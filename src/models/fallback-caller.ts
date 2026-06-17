import type { VisionJsonCaller } from "./vision-json.js";

export interface FallbackCandidate {
  caller: VisionJsonCaller;
  provider: string;
  model: string;
}

export function isRetryableProviderError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Retry on rate limit, server errors, and network-level failures.
  // Do NOT retry on 400 (bad request), 401 (auth), or JSON parse errors
  // from the provider — those indicate a non-transient problem.
  return /HTTP 429|HTTP 5\d{2}|request failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout/i.test(msg);
}

export function makeFallbackVisionCaller(candidates: FallbackCandidate[]): VisionJsonCaller {
  if (candidates.length === 0) {
    throw new Error("makeFallbackVisionCaller requires at least one candidate");
  }
  return async (req) => {
    let lastErr: unknown;
    for (const candidate of candidates) {
      try {
        return await candidate.caller(req);
      } catch (err) {
        lastErr = err;
        if (!isRetryableProviderError(err)) {
          throw err;
        }
        // Retryable: try next candidate
      }
    }
    throw lastErr;
  };
}
