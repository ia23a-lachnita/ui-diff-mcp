import type { VisionJsonCaller } from "./vision-json.js";

export interface FallbackCandidate {
  caller: VisionJsonCaller;
  provider: string;
  model: string;
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
  onFallback?: (event: FallbackEvent) => void
): VisionJsonCaller {
  if (candidates.length === 0) {
    throw new Error("makeFallbackVisionCaller requires at least one candidate");
  }
  // Per-run sticky health: once a candidate fails with a retryable error, all
  // subsequent calls in this run skip it and start from the next healthy candidate.
  // This prevents burning quota/time retrying an already-known-unhealthy route on
  // every model call (e.g. NVIDIA 429 should not be retried for the rest of the run).
  let healthyStartIndex = 0;
  return async (req) => {
    let lastErr: unknown;
    for (let i = healthyStartIndex; i < candidates.length; i++) {
      try {
        return await candidates[i]!.caller(req);
      } catch (err) {
        lastErr = err;
        if (!isRetryableProviderError(err)) throw err;
        // Advance sticky index past this unhealthy candidate and emit one fallback event.
        if (i === healthyStartIndex) {
          const next = candidates[i + 1];
          if (onFallback && next) {
            onFallback({
              fromProvider: candidates[i]!.provider,
              fromModel: candidates[i]!.model,
              toProvider: next.provider,
              toModel: next.model,
              reason: err instanceof Error ? err.message.slice(0, 200) : String(err),
              timestamp: new Date().toISOString()
            });
          }
          healthyStartIndex++;
        }
      }
    }
    throw lastErr;
  };
}
