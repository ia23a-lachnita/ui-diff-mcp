import { describe, expect, it, vi } from "vitest";
import { makeFallbackVisionCaller, isRetryableProviderError, type FallbackCandidate } from "../../src/models/fallback-caller.js";

const dummyReq = { prompt: "test", images: [], jsonSchema: { name: "t", schema: {} }, timeoutMs: 5000 };
const ok1 = { parsed: {}, rawContent: "", model: "m1", provider: "nvidia" };
const ok2 = { parsed: {}, rawContent: "", model: "m2", provider: "openrouter" };

function cand(caller: FallbackCandidate["caller"], provider = "nvidia", model = "m1"): FallbackCandidate {
  return { caller, provider, model };
}

describe("makeFallbackVisionCaller", () => {
  it("returns first candidate response when no error", async () => {
    const result = await makeFallbackVisionCaller([cand(vi.fn().mockResolvedValue(ok1))])(dummyReq);
    expect(result.model).toBe("m1");
  });

  it("falls back to second candidate on HTTP 503", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("NVIDIA HTTP 503: service unavailable")), "nvidia", "m1");
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "openrouter", "m2");
    const result = await makeFallbackVisionCaller([c1, c2])(dummyReq);
    expect(result.model).toBe("m2");
  });

  it("falls back on HTTP 429 rate limit", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("OpenRouter HTTP 429: rate limited")));
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "openrouter", "m2");
    const result = await makeFallbackVisionCaller([c1, c2])(dummyReq);
    expect(result.model).toBe("m2");
  });

  it("does NOT fall back on HTTP 400 bad request", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("OpenRouter HTTP 400: schema invalid")));
    const c2 = cand(vi.fn().mockResolvedValue(ok2));
    await expect(makeFallbackVisionCaller([c1, c2])(dummyReq)).rejects.toThrow("400");
  });

  it("does NOT fall back on JSON parse error", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("OpenRouter response content is not valid JSON: abc")));
    const c2 = cand(vi.fn().mockResolvedValue(ok2));
    await expect(makeFallbackVisionCaller([c1, c2])(dummyReq)).rejects.toThrow("not valid JSON");
  });

  it("throws last error when all candidates exhausted", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429: rate limited")));
    const c2 = cand(vi.fn().mockRejectedValue(new Error("HTTP 503: overloaded")), "openrouter", "m2");
    await expect(makeFallbackVisionCaller([c1, c2])(dummyReq)).rejects.toThrow("HTTP 503");
  });

  it("throws when constructed with empty candidates", () => {
    expect(() => makeFallbackVisionCaller([])).toThrow("at least one candidate");
  });
});

describe("isRetryableProviderError", () => {
  it.each([
    ["NVIDIA HTTP 429: rate limited", true],
    ["NVIDIA HTTP 503: service unavailable", true],
    ["NVIDIA request failed: ETIMEDOUT", true],
    ["OpenRouter request failed: ECONNRESET", true],
    ["OpenRouter HTTP 400: bad request", false],
    ["OpenRouter HTTP 401: unauthorized", false],
    ["OpenRouter response content is not valid JSON: {}", false],
  ])("%s → %s", (msg, expected) => {
    expect(isRetryableProviderError(new Error(msg))).toBe(expected);
  });
});
