import { describe, expect, it, vi } from "vitest";
import { makeFallbackVisionCaller, isRetryableProviderError, type FallbackCandidate, type FallbackEvent } from "../../src/models/fallback-caller.js";
import { ProviderJsonParseError } from "../../src/models/vision-json.js";
import type { ProviderTraceEvent } from "../../src/schemas/core.js";

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

  it("falls back on malformed provider JSON (not valid JSON)", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("OpenRouter response content is not valid JSON: abc")));
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "openrouter", "m2");
    const result = await makeFallbackVisionCaller([c1, c2])(dummyReq);
    expect(result.model).toBe("m2");
  });

  it("throws last error when all candidates exhausted", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429: rate limited")));
    const c2 = cand(vi.fn().mockRejectedValue(new Error("HTTP 503: overloaded")), "openrouter", "m2");
    await expect(makeFallbackVisionCaller([c1, c2])(dummyReq)).rejects.toThrow("HTTP 503");
  });

  it("throws when constructed with empty candidates", () => {
    expect(() => makeFallbackVisionCaller([])).toThrow("at least one candidate");
  });

  it("calls onFallback with from/to/reason when first candidate fails retryably", async () => {
    const events: FallbackEvent[] = [];
    const c1 = cand(vi.fn().mockRejectedValue(new Error("NVIDIA HTTP 429: rate limited")), "nvidia", "m1");
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "openrouter", "m2");
    await makeFallbackVisionCaller([c1, c2], ev => events.push(ev))(dummyReq);
    expect(events).toHaveLength(1);
    expect(events[0]!.fromProvider).toBe("nvidia");
    expect(events[0]!.fromModel).toBe("m1");
    expect(events[0]!.toProvider).toBe("openrouter");
    expect(events[0]!.toModel).toBe("m2");
    expect(events[0]!.reason).toMatch(/429/);
    expect(events[0]!.timestamp).toMatch(/^\d{4}-/);
  });

  it("sticky health: second call skips already-failed candidate without re-trying it", async () => {
    const failFn = vi.fn().mockRejectedValue(new Error("NVIDIA HTTP 429: rate limited"));
    const okFn = vi.fn().mockResolvedValue(ok2);
    const caller = makeFallbackVisionCaller([cand(failFn, "nvidia", "m1"), cand(okFn, "openrouter", "m2")]);
    await caller(dummyReq); // call 1: fails on m1, switches to m2
    await caller(dummyReq); // call 2: should start at m2 directly
    expect(failFn).toHaveBeenCalledTimes(1); // m1 not retried on call 2
    expect(okFn).toHaveBeenCalledTimes(2);
  });

  it("sticky health: onFallback fires only once even across multiple calls", async () => {
    const events: FallbackEvent[] = [];
    const failFn = vi.fn().mockRejectedValue(new Error("HTTP 503"));
    const okFn = vi.fn().mockResolvedValue(ok2);
    const caller = makeFallbackVisionCaller([cand(failFn), cand(okFn, "openrouter", "m2")], ev => events.push(ev));
    await caller(dummyReq);
    await caller(dummyReq);
    await caller(dummyReq);
    expect(events).toHaveLength(1); // event fires once at the transition, not per-call
  });

  it("route_exhausted traceSink emits exactly once across repeated post-exhaustion calls, and short-circuit skips call_start", async () => {
    const trace: string[] = [];
    const traceSink = vi.fn((e: { event: string }) => trace.push(e.event));
    const c1 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429")), "nvidia", "m1");
    const c2 = cand(vi.fn().mockRejectedValue(new Error("HTTP 503")), "openrouter", "m2");
    const caller = makeFallbackVisionCaller([c1, c2], undefined, traceSink as never);
    await expect(caller(dummyReq)).rejects.toThrow(); // exhausts both candidates
    await expect(caller(dummyReq)).rejects.toThrow(); // short-circuits — no new provider calls
    await expect(caller(dummyReq)).rejects.toThrow(); // short-circuits — no new provider calls
    // route_exhausted must appear exactly once regardless of how many times caller is invoked after exhaustion
    expect(trace.filter(e => e === "route_exhausted")).toHaveLength(1);
    // call 1 emits 2 call_starts (m1 then m2); calls 2 and 3 short-circuit before the loop
    expect(trace.filter(e => e === "call_start")).toHaveLength(2);
  });

  it("two separate caller instances have independent health state", async () => {
    const failFn = vi.fn().mockRejectedValue(new Error("HTTP 429"));
    const okFn = vi.fn().mockResolvedValue(ok2);
    const callerA = makeFallbackVisionCaller([cand(failFn), cand(okFn, "openrouter", "m2")]);
    const callerB = makeFallbackVisionCaller([cand(failFn), cand(okFn, "openrouter", "m2")]);
    await callerA(dummyReq); // callerA switches to m2
    await callerB(dummyReq); // callerB switches independently; failFn called again
    expect(failFn).toHaveBeenCalledTimes(2); // each caller tried m1 once
  });
});

describe("diagnostic field on trace events", () => {
  it("includes diagnostic.kind=invalid_json on ProviderJsonParseError without full raw body", async () => {
    const rawBody = "x".repeat(2000);
    const parseErr = new ProviderJsonParseError("nvidia", {
      kind: "invalid_json",
      rawContentLength: rawBody.length,
      firstChars: rawBody.slice(0, 300),
      lastChars: rawBody.slice(-300),
      startsWithJson: false,
      endsWithJson: false,
      streamCompleted: false
    });
    const c1 = cand(vi.fn().mockRejectedValue(parseErr), "nvidia", "m1");
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "openrouter", "m2");

    const events: ProviderTraceEvent[] = [];
    const traceSink = (e: Omit<ProviderTraceEvent, "eventId">) => events.push({ eventId: "x", ...e } as ProviderTraceEvent);
    await makeFallbackVisionCaller([c1, c2], undefined, traceSink)(dummyReq);

    const errorEvent = events.find(e => e.event === "call_error");
    expect(errorEvent?.diagnostic?.kind).toBe("invalid_json");
    // raw body must not be in any trace field
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(rawBody);
  });

  it("includes diagnostic.kind=http_error with httpStatus=429 on rate-limit error", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("OpenRouter HTTP 429: rate limited")), "openrouter", "m1");
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "nvidia", "m2");

    const events: ProviderTraceEvent[] = [];
    const traceSink = (e: Omit<ProviderTraceEvent, "eventId">) => events.push({ eventId: "x", ...e } as ProviderTraceEvent);
    await makeFallbackVisionCaller([c1, c2], undefined, traceSink)(dummyReq);

    const errorEvent = events.find(e => e.event === "call_error");
    expect(errorEvent?.diagnostic?.kind).toBe("http_error");
    expect(errorEvent?.diagnostic?.httpStatus).toBe(429);
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
    ["OpenRouter response content is not valid JSON: {}", true],
  ])("%s → %s", (msg, expected) => {
    expect(isRetryableProviderError(new Error(msg))).toBe(expected);
  });
});
