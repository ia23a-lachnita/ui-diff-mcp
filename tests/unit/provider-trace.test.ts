import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRuntimeModelUsageLedger, ProviderTraceWriter, writeProviderTrace } from "../../src/debug/provider-trace.js";
import { buildUsageSummaryFromLedger } from "../../src/debug/usage-summary.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "provider-trace-test-")); });
afterEach(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

describe("ProviderTraceWriter", () => {
  it("emits events and assigns eventId", () => {
    const writer = new ProviderTraceWriter();
    writer.emit({
      phase: "probe",
      event: "probe_result",
      role: "auditor",
      provider: "nvidia",
      model: "qwen/qwen3.5-397b-a17b",
      modelFamilyKey: "qwen/qwen3.5-397b-a17b",
      status: "pass"
    });
    const events = writer.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.eventId).toBeTruthy();
    expect(events[0]!.event).toBe("probe_result");
  });

  it("rejects events with unsafe / unknown fields", () => {
    const writer = new ProviderTraceWriter();
    expect(() => writer.emit({
      phase: "audit",
      event: "call_start",
      role: "auditor",
      provider: "openrouter",
      model: "nex-agi/nex-n2-pro:free",
      modelFamilyKey: "nex-agi/nex-n2-pro",
      // @ts-expect-error intentional unknown field to test schema validation
      promptText: "super secret prompt"
    })).toThrow();
  });

  it("sink getter returns a callback that emits events", () => {
    const writer = new ProviderTraceWriter();
    const sink = writer.sink;
    sink({
      phase: "audit",
      event: "call_success",
      role: "auditor",
      provider: "nvidia",
      model: "qwen/qwen3.5-397b-a17b",
      modelFamilyKey: "qwen/qwen3.5-397b-a17b",
      status: "ok",
      durationMs: 1234
    });
    expect(writer.getEvents()).toHaveLength(1);
    expect(writer.getEvents()[0]!.durationMs).toBe(1234);
  });

  it("emits route_unhealthy and fallback events correctly", () => {
    const writer = new ProviderTraceWriter();
    writer.emit({
      phase: "audit",
      event: "route_unhealthy",
      role: "auditor",
      provider: "nvidia",
      model: "qwen/qwen3.5-397b-a17b",
      modelFamilyKey: "qwen/qwen3.5-397b-a17b",
      routeIndex: 0,
      retryable: true,
      reason: "HTTP 429 rate limited",
      status: "error"
    });
    writer.emit({
      phase: "audit",
      event: "fallback",
      role: "auditor",
      provider: "openrouter",
      model: "nex-agi/nex-n2-pro:free",
      modelFamilyKey: "nex-agi/nex-n2-pro",
      routeIndex: 1,
      reason: "previous route unhealthy"
    });
    const events = writer.getEvents();
    expect(events[0]!.event).toBe("route_unhealthy");
    expect(events[0]!.retryable).toBe(true);
    expect(events[1]!.event).toBe("fallback");
    expect(events[1]!.provider).toBe("openrouter");
  });

  it("preserves bounded structured-response diagnostics", () => {
    const writer = new ProviderTraceWriter();
    writer.emit({
      phase: "audit",
      event: "call_error",
      role: "auditor",
      provider: "nvidia",
      model: "model",
      modelFamilyKey: "model",
      status: "error",
      diagnostic: {
        kind: "truncated_json",
        rawContentLength: 564,
        firstChars: "{\"hasDiff\":",
        lastChars: "unfinished",
        startsWithJson: true,
        endsWithJson: false,
        streamCompleted: true,
        finishReason: "length",
        retryDecision: "same_route_compact_retry"
      }
    });
    expect(writer.getEvents()[0]?.diagnostic).toMatchObject({ kind: "truncated_json", retryDecision: "same_route_compact_retry" });
  });

  it("derives runtime usage from matched call lifecycles and diagnoses unmatched events", () => {
    const writer = new ProviderTraceWriter();
    writer.emit({
      phase: "audit", event: "call_start", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", callId: "audit-success"
    });
    writer.emit({
      phase: "audit", event: "call_success", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", callId: "audit-success", status: "ok", inputTokens: 12, outputTokens: 4, totalTokens: 16
    });
    writer.emit({
      phase: "audit", event: "call_start", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", callId: "audit-error", attempt: 1
    });
    writer.emit({
      phase: "audit", event: "call_error", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", callId: "audit-error", attempt: 1, status: "error"
    });
    writer.emit({
      phase: "audit", event: "call_start", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", callId: "audit-incomplete", attempt: 2
    });
    writer.emit({
      phase: "reviewer", event: "fallback", role: "reviewer", provider: "mistral", model: "mistral-small-3.2",
      modelFamilyKey: "mistral-small-3.2"
    });
    writer.emit({
      phase: "reviewer", event: "call_start", role: "reviewer", provider: "mistral", model: "mistral-small-3.2",
      modelFamilyKey: "mistral-small-3.2", callId: "review-missing-usage"
    });
    writer.emit({
      phase: "reviewer", event: "call_success", role: "reviewer", provider: "mistral", model: "mistral-small-3.2",
      modelFamilyKey: "mistral-small-3.2", callId: "review-missing-usage", status: "ok"
    });
    writer.emit({
      phase: "recovery", event: "fallback", role: "target_recovery", provider: "mistral", model: "mistral-large",
      modelFamilyKey: "mistral-large"
    });
    writer.emit({
      phase: "audit", event: "call_success", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", callId: "orphan", status: "ok"
    });
    writer.emit({
      phase: "audit", event: "call_start", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash"
    });
    writer.emit({
      phase: "audit", event: "call_success", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", status: "ok"
    });

    const events = writer.getEvents();
    const ledger = buildRuntimeModelUsageLedger([...events, events[1]!]);

    expect(ledger.usage).toEqual([
      {
        phase: "audit", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
        callStartCount: 3, callSuccessCount: 1, callErrorCount: 1, fallbackCount: 0,
        incompleteStartedCallCount: 1, successesWithUsage: 1, successesMissingUsage: 0,
        inputTokens: 12, outputTokens: 4, totalTokens: 16
      },
      {
        phase: "reviewer", role: "reviewer", provider: "mistral", model: "mistral-small-3.2",
        callStartCount: 1, callSuccessCount: 1, callErrorCount: 0, fallbackCount: 1,
        incompleteStartedCallCount: 0, successesWithUsage: 0, successesMissingUsage: 1
      }
    ]);
    expect(ledger.diagnostics).toEqual({
      orphanTerminalCount: 1,
      legacyUnmatchedLifecycleEventCount: 2,
      duplicateCallStartCount: 0,
      fallbackWithoutCallStartCount: 1,
      terminalRouteMismatchCount: 0,
      terminalStatusMismatchCount: 0
    });
  });

  it("requires an exact route tuple and expected terminal status before closing a call", () => {
    const writer = new ProviderTraceWriter();
    writer.emit({
      phase: "audit", event: "call_start", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", callId: "tuple-mismatch"
    });
    writer.emit({
      phase: "audit", event: "call_success", role: "auditor", provider: "mistral", model: "mistral-small-3.2",
      modelFamilyKey: "mistral-small-3.2", callId: "tuple-mismatch", status: "ok", totalTokens: 999
    });
    writer.emit({
      phase: "audit", event: "call_error", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", callId: "tuple-mismatch", status: "ok"
    });

    const ledger = buildRuntimeModelUsageLedger(writer.getEvents());
    expect(ledger.usage).toEqual([{
      phase: "audit", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      callStartCount: 1, callSuccessCount: 0, callErrorCount: 0, fallbackCount: 0,
      incompleteStartedCallCount: 1, successesWithUsage: 0, successesMissingUsage: 0
    }]);
    expect(ledger.diagnostics).toMatchObject({ terminalRouteMismatchCount: 1, terminalStatusMismatchCount: 1 });
  });

  it("derives usage summary only from reconciled lifecycle successes", () => {
    const writer = new ProviderTraceWriter();
    writer.emit({
      phase: "audit", event: "call_start", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", callId: "accepted"
    });
    writer.emit({
      phase: "audit", event: "call_success", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", callId: "accepted", status: "ok", inputTokens: 10, outputTokens: 4, totalTokens: 14
    });
    writer.emit({
      phase: "audit", event: "call_success", role: "auditor", provider: "mistral", model: "mistral-small-3.2",
      modelFamilyKey: "mistral-small-3.2", callId: "orphan", status: "ok", totalTokens: 999
    });
    writer.emit({
      phase: "audit", event: "call_success", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash", status: "ok", totalTokens: 888
    });

    const ledger = buildRuntimeModelUsageLedger(writer.getEvents());
    const usageSummary = buildUsageSummaryFromLedger(ledger);
    expect(usageSummary).toMatchObject({
      calls: ledger.usage[0]?.callSuccessCount,
      inputTokens: ledger.usage[0]?.inputTokens,
      outputTokens: ledger.usage[0]?.outputTokens,
      totalTokens: ledger.usage[0]?.totalTokens,
      successesWithUsage: ledger.usage[0]?.successesWithUsage,
      successesMissingUsage: ledger.usage[0]?.successesMissingUsage
    });
    expect(usageSummary.totalTokens).toBe(14);
    expect(usageSummary.byRoute).toEqual({
      "gemini/gemini-3.5-flash": expect.objectContaining({ totalTokens: 14, calls: 1 })
    });
  });

  it("preserves deduplicated imported route exhaustion in usage summary without runtime work", () => {
    const checkpoint = new ProviderTraceWriter();
    checkpoint.emit({
      phase: "recovery", event: "route_exhausted", role: "target_recovery", provider: "mistral", model: "mistral-large",
      modelFamilyKey: "mistral-large", status: "error"
    });
    const resumed = new ProviderTraceWriter();
    resumed.importEvents([...checkpoint.getEvents(), ...checkpoint.getEvents()]);

    const ledger = buildRuntimeModelUsageLedger(resumed.getEvents());
    const summary = buildUsageSummaryFromLedger(ledger);

    expect(ledger.usage).toEqual([]);
    expect(summary).toMatchObject({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      routeExhaustedCount: 1
    });
    expect(summary.byRoute).toEqual({
      "mistral/mistral-large": expect.objectContaining({ routeExhaustedCount: 1, calls: 0, totalTokens: 0 })
    });
  });

  it("imports checkpoint events once by event ID", () => {
    const first = new ProviderTraceWriter();
    first.emit({
      phase: "audit", event: "call_start", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      modelFamilyKey: "gemini-3.5-flash"
    });
    const resumed = new ProviderTraceWriter();
    resumed.importEvents([...first.getEvents(), ...first.getEvents()]);

    expect(resumed.getEvents()).toHaveLength(1);
  });
});

describe("writeProviderTrace", () => {
  it("writes valid JSON to provider-trace.json", async () => {
    const writer = new ProviderTraceWriter();
    writer.emit({
      phase: "probe",
      event: "probe_result",
      role: "reviewer",
      provider: "openrouter",
      model: "google/gemma-4-31b-it:free",
      modelFamilyKey: "google/gemma-4-31b-it",
      status: "pass"
    });
    const artifact = await writeProviderTrace(tmpDir, writer);
    expect(artifact.role).toBe("provider_trace");
    expect(artifact.path).toContain("provider-trace.json");
    const raw = await fs.readFile(artifact.path, "utf8");
    const parsed = JSON.parse(raw) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it("writes an empty array when no events were emitted", async () => {
    const writer = new ProviderTraceWriter();
    const artifact = await writeProviderTrace(tmpDir, writer);
    const parsed = JSON.parse(await fs.readFile(artifact.path, "utf8")) as unknown[];
    expect(parsed).toHaveLength(0);
  });

  it("does not include any forbidden fields in emitted events", async () => {
    const writer = new ProviderTraceWriter();
    writer.emit({
      phase: "audit",
      event: "call_success",
      role: "auditor",
      provider: "nvidia",
      model: "qwen/qwen3.5-397b-a17b",
      modelFamilyKey: "qwen/qwen3.5-397b-a17b",
      status: "ok",
      inputTokens: 512,
      outputTokens: 64,
      finishReason: "stop"
    });
    await writeProviderTrace(tmpDir, writer);
    const content = await fs.readFile(path.join(tmpDir, "provider-trace.json"), "utf8");
    expect(content).not.toContain("prompt");
    expect(content).not.toContain("image");
    expect(content).not.toContain("apiKey");
    expect(content).not.toContain("base64");
    expect(content).not.toContain("rawResponse");
  });
});
