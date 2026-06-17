import type { VisionJsonCaller } from "./vision-json.js";

export interface FallbackCandidate {
  caller: VisionJsonCaller;
  provider: string;
  model: string;
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
