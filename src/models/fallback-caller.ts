import type { VisionJsonCaller } from "./vision-json.js";
import { ProviderJsonParseError } from "./vision-json.js";
import type { ProviderTraceSink } from "../debug/provider-trace.js";
import { modelFamilyKey } from "./model-registry.js";

export type { ProviderTraceSink };

export class RouteExhaustedError extends Error {
  constructor(public readonly lastError?: unknown) {
    super(lastError instanceof Error ? `All provider routes exhausted: ${lastError.message}` : "All provider routes exhausted", { cause: lastError });
    this.name = "RouteExhaustedError";
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
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Retry on rate limit, server errors, network failures, and malformed/truncated
  // provider JSON — all indicate a transient provider-side issue.
  // Do NOT retry on HTTP 400 (bad request schema) or 401 (auth) — those are
  // caller-side problems that will recur on every candidate.
  return /HTTP 429|HTTP 5\d{2}|request failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|not valid JSON/i.test(msg);
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
      throw new RouteExhaustedError(persistedLastErr);
    }
    let lastErr: unknown;
    for (let i = healthyStartIndex; i < candidates.length; i++) {
      const candidate = candidates[i]!;
      const phase = candidate.phase ?? "audit";
      const role = phase === "reviewer" ? "reviewer" as const : phase === "recovery" ? "target_recovery" as const : "auditor" as const;
      const startedAt = new Date().toISOString();
      traceSink?.({
        phase,
        event: "call_start",
        role,
        provider: candidate.provider,
        model: candidate.model,
        modelFamilyKey: modelFamilyKey(candidate.model),
        routeIndex: i,
        startedAt
      });
      try {
        const callStart = Date.now();
        const result = await candidate.caller(req);
        const completedAt = new Date().toISOString();
        traceSink?.({
          phase,
          event: "call_success",
          role,
          provider: candidate.provider,
          model: candidate.model,
          modelFamilyKey: modelFamilyKey(candidate.model),
          routeIndex: i,
          startedAt,
          completedAt,
          durationMs: Date.now() - callStart,
          status: "ok",
          ...(result.ttftMs != null ? { ttftMs: result.ttftMs } : {})
        });
        return result;
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
        traceSink?.({
          phase,
          event: "call_error",
          role,
          provider: candidate.provider,
          model: candidate.model,
          modelFamilyKey: modelFamilyKey(candidate.model),
          routeIndex: i,
          startedAt,
          completedAt,
          status: "error",
          retryable,
          reason: errMsg.slice(0, 500),
          ...(httpStatus ? { httpStatus: Number(httpStatus) } : {}),
          ...(diagnostic !== undefined ? { diagnostic } : {})
        });
        if (!retryable) throw err;
        // Advance sticky index past this unhealthy candidate and emit trace + fallback event.
        if (i === healthyStartIndex) {
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
              reason: `previous route (${candidate.provider}/${candidate.model}) unhealthy`
            });
            if (onFallback) {
              onFallback({
                fromProvider: candidate.provider,
                fromModel: candidate.model,
                toProvider: next.provider,
                toModel: next.model,
                reason: errMsg.slice(0, 200),
                timestamp: new Date().toISOString()
              });
            }
          } else {
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
    throw new RouteExhaustedError(lastErr);
  };
  return Object.assign(caller, { isExhausted: () => healthyStartIndex >= candidates.length });
}
