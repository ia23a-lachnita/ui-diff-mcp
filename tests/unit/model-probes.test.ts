import { describe, expect, it, vi } from "vitest";
import { probeAuditCapability, probeReviewerCapability, probeRecoveryCapability, probeRequiredModels } from "../../src/models/probes.js";
import type { ModelEntry } from "../../src/models/model-registry.js";
import type { VisionProviderConfig } from "../../src/models/provider-config.js";

// Provide a mock caller that returns content matching the multi-image probe schema.
// The mock returns imageCount: 5 and hasBlueImage: true, so 5-image probes pass and 4-image probes fail.
vi.mock("../../src/models/vision-json.js", () => ({
  makeNvidiaVisionCaller: (_key: string, model: string) => () => Promise.resolve({
    parsed: { imageCount: 5, hasBlueImage: true },
    rawContent: '{"imageCount":5,"hasBlueImage":true}',
    model,
    provider: "nvidia",
    ttftMs: 50
  }),
  makeOpenRouterVisionCaller: (_key: string, model: string) => () => Promise.resolve({
    parsed: { imageCount: 5, hasBlueImage: true },
    rawContent: '{"imageCount":5,"hasBlueImage":true}',
    model,
    provider: "openrouter",
    ttftMs: 50
  }),
}));

const CONFIG: VisionProviderConfig = {
  openRouterApiKey: "or-key",
  nvidiaApiKey: "fake-key",
  nvidiaBaseUrl: "https://nvidia.example/v1",
  openCodeApiKey: "public",
  openCodeBaseUrl: "https://opencode.ai/zen/v1"
};

function makeEntry(role: ModelEntry["role"], provider: ModelEntry["provider"] = "nvidia", model = `test/${role}-model`): ModelEntry {
  return { role, provider, model, costClass: "free", probeTtlMs: 60000, required: false };
}

describe("role-specific probe dispatch", () => {
  it("probeAuditCapability tags result with role=auditor", async () => {
    const entry = makeEntry("auditor");
    const result = await probeAuditCapability(entry, CONFIG);
    expect(result.role).toBe("auditor");
    expect(result.provider).toBe("nvidia");
    expect(result.model).toBe("test/auditor-model");
  });

  it("probeReviewerCapability tags result with role=reviewer", async () => {
    const entry = makeEntry("reviewer");
    const result = await probeReviewerCapability(entry, CONFIG);
    expect(result.role).toBe("reviewer");
    expect(result.provider).toBe("nvidia");
  });

  it("probeRecoveryCapability tags result with role=target_recovery", async () => {
    const entry = makeEntry("target_recovery");
    const result = await probeRecoveryCapability(entry, CONFIG);
    expect(result.role).toBe("target_recovery");
    expect(result.provider).toBe("nvidia");
  });

  it("probeAuditCapability passes on 5-image-capable model (mock returns imageCount=5)", async () => {
    const entry = makeEntry("auditor");
    const result = await probeAuditCapability(entry, CONFIG);
    expect(result.status).toBe("pass");
    expect(result.maxImagesSupported).toBe(5);
    expect(result.schemaValid).toBe(true);
    expect(result.contentAccurate).toBe(true);
  });

  it("probeReviewerCapability passes on 5-image-capable model", async () => {
    const entry = makeEntry("reviewer", "openrouter");
    const result = await probeReviewerCapability(entry, CONFIG);
    expect(result.status).toBe("pass");
    expect(result.maxImagesSupported).toBe(5);
    expect(result.role).toBe("reviewer");
  });

  it("probeRecoveryCapability fails when mock returns imageCount=5 but recovery expects 4", async () => {
    // Mock returns imageCount=5, but recovery probe expects imageCount=4, so content check fails
    const entry = makeEntry("target_recovery");
    const result = await probeRecoveryCapability(entry, CONFIG);
    // imageCount 5 !== 4, so contentAccurate=false → status=fail
    expect(result.status).toBe("fail");
    expect(result.role).toBe("target_recovery");
    expect(result.schemaValid).toBe(true);
    expect(result.contentAccurate).toBe(false);
  });

  it("probeRequiredModels dispatches auditor entries to audit probe (role=auditor)", async () => {
    const entries: ModelEntry[] = [makeEntry("auditor")];
    const results = await probeRequiredModels(entries, CONFIG);
    expect(results).toHaveLength(1);
    expect(results[0]!.role).toBe("auditor");
  });

  it("probeRequiredModels dispatches reviewer entries to reviewer probe (role=reviewer)", async () => {
    const entries: ModelEntry[] = [makeEntry("reviewer")];
    const results = await probeRequiredModels(entries, CONFIG);
    expect(results).toHaveLength(1);
    expect(results[0]!.role).toBe("reviewer");
  });

  it("probeRequiredModels dispatches recovery entries to recovery probe (role=target_recovery)", async () => {
    const entries: ModelEntry[] = [makeEntry("target_recovery")];
    const results = await probeRequiredModels(entries, CONFIG);
    expect(results).toHaveLength(1);
    expect(results[0]!.role).toBe("target_recovery");
  });

  it("probeRequiredModels handles mixed roles with correct role tags", async () => {
    const entries: ModelEntry[] = [
      makeEntry("auditor", "nvidia", "m/auditor"),
      makeEntry("reviewer", "openrouter", "m/reviewer"),
      makeEntry("target_recovery", "nvidia", "m/recovery"),
    ];
    const results = await probeRequiredModels(entries, { ...CONFIG, nvidiaApiKey: "nv-key" });
    const byModel = Object.fromEntries(results.map(r => [r.model, r]));
    expect(byModel["m/auditor"]!.role).toBe("auditor");
    expect(byModel["m/reviewer"]!.role).toBe("reviewer");
    expect(byModel["m/recovery"]!.role).toBe("target_recovery");
  });

  it("openrouter entries get probed with openrouter caller", async () => {
    const entry = makeEntry("auditor", "openrouter");
    const result = await probeAuditCapability(entry, CONFIG);
    expect(result.provider).toBe("openrouter");
    expect(result.status).toBe("pass");
  });
});
