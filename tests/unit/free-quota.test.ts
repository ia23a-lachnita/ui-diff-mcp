import { describe, expect, it, vi } from "vitest";
import {
  estimateFreeRunBudget,
  lookupOpenRouterQuota,
  checkFreeQuotaSufficiency,
  FreeCallThrottler
} from "../../src/models/free-quota.js";

describe("estimateFreeRunBudget", () => {
  it("sums probe + audit + review + recovery calls", () => {
    const budget = estimateFreeRunBudget({
      modelCount: 4,
      pairCount: 10,
      criteriaPerPair: 3,
      recoveryRegionCount: 2,
      reviewerPolicy: "every_diff"
    });
    expect(budget.probeCallsEstimate).toBe(4);
    expect(budget.auditCallsEstimate).toBe(30);
    expect(budget.reviewCallsEstimate).toBe(30);
    expect(budget.recoveryCallsEstimate).toBe(2);
    expect(budget.estimatedCalls).toBe(66);
  });

  it("reviewer=sample uses 25% of audit calls", () => {
    const budget = estimateFreeRunBudget({
      modelCount: 2,
      pairCount: 8,
      criteriaPerPair: 4,
      recoveryRegionCount: 0,
      reviewerPolicy: "sample"
    });
    expect(budget.reviewCallsEstimate).toBe(8); // ceil(32 * 0.25)
  });

  it("reviewer=none produces zero review calls", () => {
    const budget = estimateFreeRunBudget({
      modelCount: 2,
      pairCount: 5,
      criteriaPerPair: 2,
      recoveryRegionCount: 0,
      reviewerPolicy: "none"
    });
    expect(budget.reviewCallsEstimate).toBe(0);
    expect(budget.estimatedCalls).toBe(12); // 2 + 10 + 0 + 0
  });
});

describe("lookupOpenRouterQuota", () => {
  it("returns null when apiKey is empty", async () => {
    const result = await lookupOpenRouterQuota("", fetch);
    expect(result).toBeNull();
  });

  it("returns null when fetch returns non-ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const result = await lookupOpenRouterQuota("sk-test", mockFetch as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network"));
    const result = await lookupOpenRouterQuota("sk-test", mockFetch as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it("parses quota fields from response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: {
          is_free_tier: true,
          limit: 1000,
          limit_remaining: 800,
          usage: 200
        }
      })
    });
    const result = await lookupOpenRouterQuota("sk-test", mockFetch as unknown as typeof fetch);
    expect(result).toEqual({
      is_free_tier: true,
      limit: 1000,
      limit_remaining: 800,
      usage: 200
    });
  });

  it("returns null when data field is missing", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({})
    });
    const result = await lookupOpenRouterQuota("sk-test", mockFetch as unknown as typeof fetch);
    expect(result).toBeNull();
  });
});

describe("checkFreeQuotaSufficiency", () => {
  it("allows run when calls fit within remaining quota", () => {
    const budget = { estimatedCalls: 30, probeCallsEstimate: 5, auditCallsEstimate: 20, reviewCallsEstimate: 5, recoveryCallsEstimate: 0 };
    const keyInfo = { is_free_tier: true, limit: 50, limit_remaining: 40, usage: 10 };
    const result = checkFreeQuotaSufficiency(budget, keyInfo);
    expect(result.available).toBe(true);
    expect(result.estimatedCalls).toBe(30);
  });

  it("blocks run when calls exceed remaining quota", () => {
    const budget = { estimatedCalls: 60, probeCallsEstimate: 5, auditCallsEstimate: 50, reviewCallsEstimate: 5, recoveryCallsEstimate: 0 };
    const keyInfo = { is_free_tier: true, limit: 50, limit_remaining: 30, usage: 20 };
    const result = checkFreeQuotaSufficiency(budget, keyInfo);
    expect(result.available).toBe(false);
    expect(result.detail).toContain("60");
    expect(result.detail).toContain("30");
  });

  it("allows run when keyInfo is null (quota unknown — optimistic)", () => {
    const budget = { estimatedCalls: 200, probeCallsEstimate: 5, auditCallsEstimate: 180, reviewCallsEstimate: 10, recoveryCallsEstimate: 5 };
    const result = checkFreeQuotaSufficiency(budget, null);
    expect(result.available).toBe(true);
    expect(result.detail).toContain("optimistically");
  });

  it("allows run when limit_remaining is null even if keyInfo present", () => {
    const budget = { estimatedCalls: 80, probeCallsEstimate: 5, auditCallsEstimate: 70, reviewCallsEstimate: 5, recoveryCallsEstimate: 0 };
    const keyInfo = { is_free_tier: true, limit: null, limit_remaining: null, usage: 10 };
    const result = checkFreeQuotaSufficiency(budget, keyInfo);
    expect(result.available).toBe(true);
  });
});

describe("FreeCallThrottler", () => {
  it("allows calls below the RPM limit without waiting", async () => {
    const throttler = new FreeCallThrottler(18);
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await throttler.throttle();
    }
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("tracks pending call count correctly", async () => {
    const throttler = new FreeCallThrottler(18);
    expect(throttler.pendingCallCount).toBe(0);
    await throttler.throttle();
    await throttler.throttle();
    expect(throttler.pendingCallCount).toBe(2);
  });
});
