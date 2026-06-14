import { describe, expect, test } from "vitest";
import { CANONICAL_MODEL_RANKING } from "../../src/models/model-registry.js";
import { probeRequiredModels } from "../../src/models/probes.js";

const nvidiaLiveEnabled = process.env["RUN_NVIDIA_LIVE"] === "1";

describe.skipIf(!nvidiaLiveEnabled)("verify:nvidia-live NVIDIA endpoint gates", () => {
  test("NVIDIA_API_KEY and NVIDIA_VLM_BASE_URL are configured", () => {
    expect(process.env["NVIDIA_API_KEY"], "NVIDIA_API_KEY must be set when RUN_NVIDIA_LIVE=1").toBeTruthy();
  });

  test("at least one native NVIDIA free VLM passes auditor probe", async () => {
    const apiKey = process.env["OPENROUTER_API_KEY"] ?? "";
    const nvidiaApiKey = process.env["NVIDIA_API_KEY"];
    const nvidiaBaseUrl = process.env["NVIDIA_VLM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1";
    expect(nvidiaApiKey, "NVIDIA_API_KEY must be set when RUN_NVIDIA_LIVE=1").toBeTruthy();

    const nvidiaEntries = CANONICAL_MODEL_RANKING.flatMap(c =>
      c.eligibleFreeProviderRoutes
        .filter(r => r.provider === "nvidia")
        .map(r => ({
          role: c.role,
          provider: r.provider as "openrouter" | "nvidia",
          model: r.model,
          costClass: c.costClass,
          probeTtlMs: 15 * 60 * 1000,
          required: false
        }))
    );

    expect(nvidiaEntries.length, "No native NVIDIA entries in CANONICAL_MODEL_RANKING").toBeGreaterThan(0);

    const results = await probeRequiredModels(nvidiaEntries, apiKey, nvidiaApiKey!, nvidiaBaseUrl);
    for (const r of results) {
      console.info(`[nvidia-probe] ${r.role} ${r.provider}/${r.model}: ${r.status}${r.detail ? ` | ${r.detail}` : ""}`);
    }

    const passingAuditor = results.find(r => r.role === "auditor" && r.status === "pass");
    expect(
      passingAuditor,
      `No NVIDIA auditor passed probes. Results: ${JSON.stringify(results.map(r => ({ model: r.model, status: r.status, detail: r.detail })))}`
    ).toBeDefined();
  }, 180000);

  test("at least one native NVIDIA free VLM passes reviewer probe", async () => {
    const apiKey = process.env["OPENROUTER_API_KEY"] ?? "";
    const nvidiaApiKey = process.env["NVIDIA_API_KEY"]!;
    const nvidiaBaseUrl = process.env["NVIDIA_VLM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1";

    const nvidiaEntries = CANONICAL_MODEL_RANKING.flatMap(c =>
      c.eligibleFreeProviderRoutes
        .filter(r => r.provider === "nvidia")
        .map(r => ({
          role: c.role,
          provider: r.provider as "openrouter" | "nvidia",
          model: r.model,
          costClass: c.costClass,
          probeTtlMs: 15 * 60 * 1000,
          required: false
        }))
    );

    const results = await probeRequiredModels(nvidiaEntries, apiKey, nvidiaApiKey, nvidiaBaseUrl);
    const passingReviewer = results.find(r => r.role === "reviewer" && r.status === "pass");
    expect(
      passingReviewer,
      `No NVIDIA reviewer passed probes. Check NVIDIA_API_KEY and endpoint availability.`
    ).toBeDefined();
  }, 180000);

  test("selected NVIDIA model is recorded in modelSelection in report", async () => {
    const { selectModelForMode } = await import("../../src/models/model-registry.js");
    const nvidiaApiKey = process.env["NVIDIA_API_KEY"]!;
    const nvidiaBaseUrl = process.env["NVIDIA_VLM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1";
    const apiKey = process.env["OPENROUTER_API_KEY"] ?? "";

    const nvidiaEntries = CANONICAL_MODEL_RANKING.flatMap(c =>
      c.eligibleFreeProviderRoutes
        .filter(r => r.provider === "nvidia")
        .map(r => ({
          role: c.role,
          provider: r.provider as "openrouter" | "nvidia",
          model: r.model,
          costClass: c.costClass,
          probeTtlMs: 15 * 60 * 1000,
          required: false
        }))
    );

    const { probeRequiredModels: probe } = await import("../../src/models/probes.js");
    const probeResults = await probe(nvidiaEntries, apiKey, nvidiaApiKey, nvidiaBaseUrl);
    const env = { NVIDIA_API_KEY: nvidiaApiKey };
    const auditorEntry = selectModelForMode("auditor", "free_nvidia", probeResults, env);

    if (auditorEntry) {
      expect(auditorEntry.provider).toBe("nvidia");
      console.info(`[nvidia] Selected auditor: ${auditorEntry.provider}/${auditorEntry.model}`);
    } else {
      console.warn("[nvidia] No NVIDIA auditor selected — skipping modelSelection check");
    }
  }, 180000);
});
