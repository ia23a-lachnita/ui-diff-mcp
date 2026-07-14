import type { VisionJsonCaller } from "./vision-json.js";
import { ProviderJsonParseError } from "./vision-json.js";
import type { ProviderTraceSink } from "../debug/provider-trace.js";
import { modelFamilyKey } from "./model-registry.js";

export type { ProviderTraceSink };

export class RouteExhaustedError extends Error {
  constructor(
    public readonly lastError?: unknown,
    public readonly permanent = false
  ) {
    super(lastError instanceof Error ? `All provider routes exhausted: ${lastError.message}` : "All provider routes exhausted", { cause: lastError });
    this.name = "RouteExhaustedError";
  }
}

export type BudgetedAttemptResult =
  | { proceed: true; timeoutMs?: number }
  | { proceed: false; reason: "model_call_cap" | "deadline_exceeded" };

export interface BudgetedAttemptHook {
  reserveAttempt(attemptIndex: number, currentTimeoutMs: number): BudgetedAttemptResult | Promise<BudgetedAttemptResult>;
}

export class BudgetExhaustedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "BudgetExhaustedError";
  }
}

export type FallbackVisionCaller = VisionJsonCaller & { isExhausted(): boolean };

export interface FallbackCandidate {
  caller: VisionJsonCaller;
  provider: string;
  model: string;
  /** Runtime role for provider-trace phase tagging */
  phase?: "audit" | "reviewer" | "recovery";
}

export interface FallbackEvent {
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
  reason: string;
  timestamp: string;
}

export function isRetryableProviderError(err: unknown): boolean {
  if (err instanceof ProviderJsonParseError) return true;
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Retry on rate limit, server errors, network failures, and malformed/truncated
  // provider JSON — all indicate a transient provider-side issue.
  // Do NOT retry on HTTP 400 (bad request schema) or 401 (auth) — those are
  // caller-side problems that will recur on every candidate.
  return /HTTP 429|HTTP 5\d{2}|request failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|not valid JSON|Multimodal data is corrupted/i.test(msg);
}

function isRunStickyProviderError(err: unknown): boolean {
  return err instanceof Error && /HTTP 429/i.test(err.message);
}

export function makeFallbackVisionCaller(
  candidates: FallbackCandidate[],
  onFallback?: (event: FallbackEvent) => void,
  traceSink?: ProviderTraceSink
): FallbackVisionCaller {
  if (candidates.length === 0) {
    throw new Error("makeFallbackVisionCaller requires at least one candidate");
  }
  // Per-run sticky health: once a candidate fails with a retryable error, all
  // subsequent calls in this run skip it and start from the next healthy candidate.
  // This prevents burning quota/time retrying an already-known-unhealthy route on
  // every model call (e.g. NVIDIA 429 should not be retried for the rest of the run).
  let healthyStartIndex = 0;
  // Track exhaustion state across invocations so subsequent calls short-circuit
  // instead of re-emitting route_exhausted for every model audit after routes deplete.
  let exhaustedEmitted = false;
  let persistedLastErr: unknown;
  const caller = async (req: Parameters<VisionJsonCaller>[0]) => {
    if (healthyStartIndex >= candidates.length) {
      throw new RouteExhaustedError(persistedLastErr, true);
    }
    let lastErr: unknown;
    let requestAttemptIndex = 0;
    for (let i = healthyStartIndex; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const phase = candidate.phase ?? "audit";
      const role = phase === "reviewer" ? "reviewer" as const : phase === "recovery" ? "target_recovery" as const : "auditor" as const;
      try {
        const budgetHook = req.reserveCall;
        let attemptRequest = req;
        const initialReservationApplies = req.initialAttemptReserved === true && requestAttemptIndex === 0;
        if (budgetHook && !initialReservationApplies) {
          const hookResult = await budgetHook.reserveAttempt(requestAttemptIndex, req.timeoutMs ?? 60000);
          if (!hookResult.proceed) {
            throw new BudgetExhaustedError(hookResult.reason);
          }
          attemptRequest = { ...req, timeoutMs: hookResult.timeoutMs ?? req.timeoutMs };
        }
        requestAttemptIndex++;
        return await candidate.caller(traceSink === undefined ? attemptRequest : {
          ...attemptRequest,
          lifecycle: {
            traceSink,
            phase,
            role,
            provider: candidate.provider,
            model: candidate.model,
            modelFamilyKey: modelFamilyKey(candidate.model),
            routeIndex: i
          }
        });
      } catch (err) {
        lastErr = err;
        persistedLastErr = err;
        const completedAt = new Date().toISOString();
        const errMsg = err instanceof Error ? err.message : String(err);
        const retryable = isRetryableProviderError(err);
        const httpStatus = /HTTP (\d{3})/.exec(errMsg)?.[1];
        const diagnostic = err instanceof ProviderJsonParseError
          ? err.diagnostic
          : httpStatus ? { kind: "http_error" as const, httpStatus: Number(httpStatus) }
          : /timeout|ETIMEDOUT|AbortError/i.test(errMsg) ? { kind: "timeout" as const }
          : undefined;
        if (!retryable) throw err;
        // Quota exhaustion and repeated schema-invalid JSON are useful run-wide
        // health signals. Timeouts, network errors, and 5xx responses are transient:
        // fall back for this request, but allow the route to recover on the next one.
        const sticky = isRunStickyProviderError(err);
        if (i === healthyStartIndex && sticky) {
          traceSink?.({
            phase,
            event: "route_unhealthy",
            role,
            provider: candidate.provider,
            model: candidate.model,
            modelFamilyKey: modelFamilyKey(candidate.model),
            routeIndex: i,
            retryable: true,
            reason: errMsg.slice(0, 500),
            status: "error",
            ...(diagnostic !== undefined ? { diagnostic } : {})
          });
          if (!candidates[i + 1]) {
            if (!exhaustedEmitted) {
              exhaustedEmitted = true;
              traceSink?.({
                phase,
                event: "route_exhausted",
                role,
                provider: candidate.provider,
                model: candidate.model,
                modelFamilyKey: modelFamilyKey(candidate.model),
                routeIndex: i,
                reason: "no more candidates available",
                status: "error"
              });
            }
          }
          healthyStartIndex++;
        }
        const next = candidates[i + 1];
        if (next) {
          traceSink?.({
            phase,
            event: "fallback",
            role,
            provider: next.provider,
            model: next.model,
            modelFamilyKey: modelFamilyKey(next.model),
            routeIndex: i + 1,
            reason: `previous route (${candidate.provider}/${candidate.model}) failed for this request`
          });
          onFallback?.({
            fromProvider: candidate.provider,
            fromModel: candidate.model,
            toProvider: next.provider,
            toModel: next.model,
            reason: errMsg.slice(0, 200),
            timestamp: new Date().toISOString()
          });
        }
      }
    }
    // All candidates exhausted — emit once across all invocations of this caller
    if (!exhaustedEmitted && traceSink && candidates.length > 0) {
      exhaustedEmitted = true;
      const last = candidates[candidates.length - 1]!;
      const phase = last.phase ?? "audit";
      const role = phase === "reviewer" ? "reviewer" as const : phase === "recovery" ? "target_recovery" as const : "auditor" as const;
      traceSink({
        phase,
        event: "route_exhausted",
        role,
        provider: last.provider,
        model: last.model,
        modelFamilyKey: modelFamilyKey(last.model),
        routeIndex: candidates.length - 1,
        reason: "all candidates exhausted",
        status: "error"
      });
    }
    throw new RouteExhaustedError(lastErr, healthyStartIndex >= candidates.length);
  };
  return Object.assign(caller, { isExhausted: () => healthyStartIndex >= candidates.length });
}
