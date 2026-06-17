import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderTraceWriter, writeProviderTrace } from "../../src/debug/provider-trace.js";

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
