import { describe, expect, it } from "vitest";
import { buildUsageSummary } from "../../src/debug/usage-summary.js";
import type { ProviderTraceEvent } from "../../src/schemas/core.js";

function event(overrides: Partial<ProviderTraceEvent>): ProviderTraceEvent {
  return {
    eventId: `event-${Math.random()}`,
    phase: "audit",
    event: "call_success",
    role: "auditor",
    provider: "mistral",
    model: "ministral-14b-2512",
    modelFamilyKey: "ministral",
    status: "ok",
    ...overrides
  };
}

describe("buildUsageSummary", () => {
  it("aggregates input and output tokens separately by phase, role, and route", () => {
    const summary = buildUsageSummary([
      event({
        phase: "audit",
        role: "auditor",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        reasoningTokens: 3,
        durationMs: 50
      }),
      event({
        phase: "reviewer",
        role: "reviewer",
        inputTokens: 70,
        outputTokens: 10,
        totalTokens: 80,
        durationMs: 30
      }),
      event({
        phase: "audit",
        event: "call_error",
        role: "auditor",
        status: "error"
      }),
      event({
        phase: "audit",
        event: "fallback",
        role: "auditor"
      }),
      event({
        phase: "audit",
        event: "route_exhausted",
        role: "auditor",
        status: "error"
      })
    ]);

    expect(summary.calls).toBe(2);
    expect(summary.inputTokens).toBe(170);
    expect(summary.outputTokens).toBe(30);
    expect(summary.totalTokens).toBe(200);
    expect(summary.reasoningTokens).toBe(3);
    expect(summary.errorCalls).toBe(1);
    expect(summary.fallbackCalls).toBe(1);
    expect(summary.routeExhaustedCount).toBe(1);
    expect(summary.durationMs).toBe(80);
    expect(summary.byPhase.audit?.inputTokens).toBe(100);
    expect(summary.byRole.auditor?.outputTokens).toBe(20);
    expect(summary.byRoute["mistral/ministral-14b-2512"]?.totalTokens).toBe(200);
  });

  it("tracks total-only and missing usage without inventing a token split", () => {
    const summary = buildUsageSummary([
      event({ totalTokens: 500 }),
      event({})
    ]);

    expect(summary.calls).toBe(2);
    expect(summary.totalTokens).toBe(500);
    expect(summary.inputTokens).toBe(0);
    expect(summary.outputTokens).toBe(0);
    expect(summary.totalOnlyUsageCalls).toBe(1);
    expect(summary.missingUsageCalls).toBe(1);
  });
});
