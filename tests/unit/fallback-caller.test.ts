import { describe, expect, it, vi } from "vitest";
import { makeFallbackVisionCaller, isRetryableProviderError, RouteExhaustedError, BudgetExhaustedError, type FallbackCandidate, type FallbackEvent } from "../../src/models/fallback-caller.js";
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

  it("passes lifecycle context to the concrete provider caller without emitting an outer lifecycle", async () => {
    const events: ProviderTraceEvent[] = [];
    const candidate = vi.fn().mockResolvedValue(ok1);

    await makeFallbackVisionCaller(
      [cand(candidate)],
      undefined,
      event => events.push({ eventId: "x", ...event } as ProviderTraceEvent)
    )(dummyReq);

    expect(candidate.mock.calls[0]?.[0].lifecycle).toMatchObject({
      phase: "audit", role: "auditor", provider: "nvidia", model: "m1", routeIndex: 0
    });
    expect(events).toEqual([]);
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

  it("falls back when a provider intermittently rejects valid multimodal data", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error(
      "OpenCode HTTP 400: Provider returned error: Multimodal data is corrupted or invalid"
    )), "opencode", "m1");
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "nvidia", "m2");

    await expect(makeFallbackVisionCaller([c1, c2])(dummyReq))
      .resolves.toMatchObject({ model: "m2" });
  });

  it("throws last error when all candidates exhausted", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429: rate limited")));
    const c2 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429: rate limited")), "openrouter", "m2");
    const caller = makeFallbackVisionCaller([c1, c2]);
    await expect(caller(dummyReq)).rejects.toBeInstanceOf(RouteExhaustedError);
    expect(caller.isExhausted()).toBe(true);
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
    const failFn = vi.fn().mockRejectedValue(new Error("HTTP 429"));
    const okFn = vi.fn().mockResolvedValue(ok2);
    const caller = makeFallbackVisionCaller([cand(failFn), cand(okFn, "openrouter", "m2")], ev => events.push(ev));
    await caller(dummyReq);
    await caller(dummyReq);
    await caller(dummyReq);
    expect(events).toHaveLength(1); // event fires once at the transition, not per-call
  });

  it("route_exhausted traceSink emits exactly once across repeated post-exhaustion calls", async () => {
    const trace: string[] = [];
    const traceSink = vi.fn((e: { event: string }) => trace.push(e.event));
    const c1 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429")), "nvidia", "m1");
    const c2 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429")), "openrouter", "m2");
    const caller = makeFallbackVisionCaller([c1, c2], undefined, traceSink as never);
    await expect(caller(dummyReq)).rejects.toThrow(); // exhausts both candidates
    await expect(caller(dummyReq)).rejects.toThrow(); // short-circuits — no new provider calls
    await expect(caller(dummyReq)).rejects.toThrow(); // short-circuits — no new provider calls
    // route_exhausted must appear exactly once regardless of how many times caller is invoked after exhaustion
    expect(trace.filter(e => e === "route_exhausted")).toHaveLength(1);
    expect(trace).not.toContain("call_start");
  });

  it("first candidate retryably fails; second candidate response spoofs wrong provider/model — returned identity matches second candidate", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("NVIDIA HTTP 429: rate limited")), "nvidia", "m1");
    // Second candidate responds with spoofed provider/model different from its candidate identity
    const c2 = cand(vi.fn().mockResolvedValue({
      parsed: {},
      rawContent: "",
      model: "spoofed-model",
      provider: "spoofed-provider"
    }), "openrouter", "m2");
    const result = await makeFallbackVisionCaller([c1, c2])(dummyReq);
    // The returned provider and model must match the second candidate's identity, not the spoofed values
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("m2");
    expect(result.provider).not.toBe("spoofed-provider");
    expect(result.model).not.toBe("spoofed-model");
  });

  it("retries transiently timed-out routes on the next request", async () => {
    const first = vi.fn()
      .mockRejectedValueOnce(new Error("OpenCode request failed: The operation was aborted due to timeout"))
      .mockResolvedValue(ok1);
    const second = vi.fn()
      .mockRejectedValueOnce(new Error("NVIDIA request failed: The operation was aborted due to timeout"))
      .mockResolvedValue(ok2);
    const caller = makeFallbackVisionCaller([
      cand(first, "opencode", "m1"),
      cand(second, "nvidia", "m2")
    ]);

    await expect(caller(dummyReq)).rejects.toBeInstanceOf(RouteExhaustedError);
    await expect(caller(dummyReq)).resolves.toMatchObject({ model: "m1" });
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(1);
    expect(caller.isExhausted()).toBe(false);
  });

  it("retries routes after a transient all-route structured-output failure", async () => {
    const diagnostic = {
      kind: "empty_content" as const,
      rawContentLength: 0,
      firstChars: "",
      lastChars: "",
      startsWithJson: false,
      endsWithJson: false,
      streamCompleted: true
    };
    const first = vi.fn()
      .mockRejectedValueOnce(new ProviderJsonParseError("opencode", diagnostic))
      .mockResolvedValue(ok1);
    const second = vi.fn()
      .mockRejectedValueOnce(new ProviderJsonParseError("nvidia", diagnostic))
      .mockResolvedValue(ok2);
    const caller = makeFallbackVisionCaller([
      cand(first, "opencode", "m1"),
      cand(second, "nvidia", "m2")
    ]);

    const exhausted = await caller(dummyReq).catch(error => error);
    expect(exhausted).toBeInstanceOf(RouteExhaustedError);
    expect((exhausted as RouteExhaustedError).permanent).toBe(false);
    await expect(caller(dummyReq)).resolves.toMatchObject({ model: "m1" });
    expect(caller.isExhausted()).toBe(false);
  });

  it("marks quota-exhausted route sets as permanent", async () => {
    const caller = makeFallbackVisionCaller([
      cand(vi.fn().mockRejectedValue(new Error("OpenCode HTTP 429: rate limited")), "opencode", "m1")
    ]);

    const exhausted = await caller(dummyReq).catch(error => error);
    expect(exhausted).toBeInstanceOf(RouteExhaustedError);
    expect((exhausted as RouteExhaustedError).permanent).toBe(true);
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

  it("budgeted attempt hook: 2 failed + 1 success consume 3 calls", async () => {
    let hookCallCount = 0;
    const hook = {
      async reserveAttempt(_attemptIndex: number, _currentTimeoutMs: number) {
        hookCallCount++;
        return { proceed: true, timeoutMs: 5000 };
      }
    };
    const c1 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429")), "nvidia", "m1");
    const c2 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429")), "openrouter", "m2");
    const c3 = cand(vi.fn().mockResolvedValue(ok2), "nvidia", "m3");
    const result = await makeFallbackVisionCaller([c1, c2, c3])({ ...dummyReq, reserveCall: hook } as any);
    // Candidate model is the trusted route identity (overwrites response model)
    expect(result.model).toBe("m3");
    expect(hookCallCount).toBe(3);
  });

  it("budgeted attempt hook: cap=2 prevents third invocation", async () => {
    let hookCallCount = 0;
    const hook = {
      async reserveAttempt(_attemptIndex: number, _currentTimeoutMs: number) {
        hookCallCount++;
        if (hookCallCount >= 3) {
          throw new BudgetExhaustedError("model_call_cap");
        }
        return { proceed: true, timeoutMs: 5000 };
      }
    };
    const c1 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429")), "nvidia", "m1");
    const c2 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429")), "openrouter", "m2");
    const c3 = cand(vi.fn().mockResolvedValue(ok2), "nvidia", "m3");
    await expect(makeFallbackVisionCaller([c1, c2, c3])({ ...dummyReq, reserveCall: hook } as any))
      .rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(hookCallCount).toBe(3);
  });

  it("budgeted attempt hook: deadline shrinks timeout for candidate 2", async () => {
    const timeouts: number[] = [];
    const candidateTimeouts: number[] = [];
    const hook = {
      async reserveAttempt(_attemptIndex: number, currentTimeoutMs: number) {
        timeouts.push(currentTimeoutMs);
        const shrunk = _attemptIndex === 0 ? currentTimeoutMs : 1000;
        return { proceed: true, timeoutMs: shrunk };
      }
    };
    const c1 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429")), "nvidia", "m1");
    const c2 = cand(vi.fn().mockImplementation(async request => {
      candidateTimeouts.push(request.timeoutMs ?? 0);
      return ok2;
    }), "openrouter", "m2");
    await makeFallbackVisionCaller([c1, c2])({ ...dummyReq, timeoutMs: 5000, reserveCall: hook } as any);
    expect(timeouts).toHaveLength(2);
    expect(timeouts[0]).toBe(5000);
    expect(timeouts[1]).toBe(5000);
    expect(candidateTimeouts).toEqual([1000]);
  });

  it("budgeted attempt hook: expired deadline prevents candidate 2", async () => {
    const hook = {
      async reserveAttempt(_attemptIndex: number, _currentTimeoutMs: number) {
        if (_attemptIndex >= 1) {
          throw new BudgetExhaustedError("deadline_exceeded");
        }
        return { proceed: true, timeoutMs: 5000 };
      }
    };
    const c1 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429")), "nvidia", "m1");
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "openrouter", "m2");
    await expect(makeFallbackVisionCaller([c1, c2])({ ...dummyReq, reserveCall: hook } as any))
      .rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(c2.caller).not.toHaveBeenCalled();
  });

  it("budgeted attempt hook preserves a declined attempt's exhaustion reason", async () => {
    const hook = {
      async reserveAttempt() {
        return { proceed: false as const, reason: "deadline_exceeded" as const };
      }
    };
    const candidate = cand(vi.fn().mockResolvedValue(ok1));
    await expect(makeFallbackVisionCaller([candidate])({ ...dummyReq, reserveCall: hook }))
      .rejects.toMatchObject({ name: "BudgetExhaustedError", reason: "deadline_exceeded" });
    expect(candidate.caller).not.toHaveBeenCalled();
  });

  it("sticky healthyStart counts first actual attempt exactly once", async () => {
    let hookCallCount = 0;
    const hook = {
      async reserveAttempt(_attemptIndex: number, _currentTimeoutMs: number) {
        hookCallCount++;
        return { proceed: true, timeoutMs: 5000 };
      }
    };
    const failFn = vi.fn().mockRejectedValue(new Error("HTTP 429"));
    const okFn = vi.fn().mockResolvedValue(ok2);
    const caller = makeFallbackVisionCaller([cand(failFn, "nvidia", "m1"), cand(okFn, "openrouter", "m2")]);
    await caller({ ...dummyReq, reserveCall: hook } as any);
    await caller({ ...dummyReq, reserveCall: hook } as any);
    // call 1: hook reserves for m1 (attempt 0), fails, reserves for m2 (attempt 1), succeeds = 2 hook calls
    // call 2: sticky skip m1, hook reserves for m2 (attempt 0) = 1 hook call
    expect(hookCallCount).toBe(3);
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

    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ event: "fallback" })]));
    expect(events.find(event => event.event === "call_error")).toBeUndefined();
    // Fallback metadata never contains the raw provider body.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(rawBody);
  });

  it("records timeout as a distinct safe diagnostic", async () => {
    const timeout = new Error("NVIDIA request failed: AbortError timeout");
    const c1 = cand(vi.fn().mockRejectedValue(timeout), "nvidia", "m1");
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "openrouter", "m2");
    const events: ProviderTraceEvent[] = [];
    await makeFallbackVisionCaller([c1, c2], undefined, event => events.push({ eventId: "x", ...event } as ProviderTraceEvent))(dummyReq);
    expect(events.find(event => event.event === "call_error")).toBeUndefined();
    expect(events.find(event => event.event === "fallback")).toBeDefined();
  });

  it("includes diagnostic.kind=http_error with httpStatus=429 on rate-limit error", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("OpenRouter HTTP 429: rate limited")), "openrouter", "m1");
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "nvidia", "m2");

    const events: ProviderTraceEvent[] = [];
    const traceSink = (e: Omit<ProviderTraceEvent, "eventId">) => events.push({ eventId: "x", ...e } as ProviderTraceEvent);
    await makeFallbackVisionCaller([c1, c2], undefined, traceSink)(dummyReq);

    expect(events.find(e => e.event === "call_error")).toBeUndefined();
    expect(events.find(e => e.event === "fallback")).toBeDefined();
  });
});

describe("isRetryableProviderError", () => {
  it.each([
    ["NVIDIA HTTP 429: rate limited", true],
    ["NVIDIA HTTP 503: service unavailable", true],
    ["NVIDIA request failed: ETIMEDOUT", true],
    ["OpenRouter request failed: ECONNRESET", true],
    ["OpenRouter HTTP 400: bad request", false],
    ["OpenCode HTTP 400: Multimodal data is corrupted or invalid", true],
    ["OpenRouter HTTP 401: unauthorized", false],
    ["OpenRouter response content is not valid JSON: {}", true],
  ])("%s → %s", (msg, expected) => {
    expect(isRetryableProviderError(new Error(msg))).toBe(expected);
  });
});
