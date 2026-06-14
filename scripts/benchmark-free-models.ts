#!/usr/bin/env node
/**
 * Benchmark free VLM candidates from CANONICAL_MODEL_RANKING.
 * Measures TTFT, tokens/sec, schema success, and UI-diff accuracy.
 * Results written to .ui-diff/generated/model-benchmark.json (excluded from git).
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-... NVIDIA_API_KEY=nvapi-... npm run benchmark:models
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CANONICAL_MODEL_RANKING } from "../src/models/model-registry.js";
import { probeOpenRouterModel, probeNvidiaModel } from "../src/models/probes.js";
import { FreeCallThrottler } from "../src/models/free-quota.js";

const OUTPUT_DIR = ".ui-diff/generated";
const OUTPUT_FILE = path.join(OUTPUT_DIR, "model-benchmark.json");

interface BenchmarkEntry {
  role: string;
  provider: string;
  model: string;
  costClass: string;
  probeStatus: "pass" | "fail" | "not_checked";
  ttftMs: number | null;
  detail?: string;
  benchmarkedAt: string;
  schemaValid?: boolean | null;
  contentAccurate?: boolean | null;
}

export async function runBenchmark(): Promise<void> {
  const openRouterApiKey = process.env["OPENROUTER_API_KEY"] ?? "";
  const nvidiaApiKey = process.env["NVIDIA_API_KEY"] ?? "";
  const nvidiaBaseUrl = process.env["NVIDIA_VLM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1";

  if (!openRouterApiKey && !nvidiaApiKey) {
    throw new Error("ERROR: Set OPENROUTER_API_KEY and/or NVIDIA_API_KEY to run benchmarks.");
  }

  const throttler = new FreeCallThrottler(18);
  const results: BenchmarkEntry[] = [];

  for (const candidate of CANONICAL_MODEL_RANKING) {
    for (const route of candidate.eligibleFreeProviderRoutes) {
      const entry = {
        role: candidate.role,
        provider: route.provider,
        model: route.model,
        costClass: candidate.costClass,
        probeTtlMs: 15 * 60 * 1000,
        required: false
      };

      let probeResult: Awaited<ReturnType<typeof probeOpenRouterModel>>;
      if (route.provider === "openrouter") {
        if (!openRouterApiKey) {
          results.push({
            role: candidate.role,
            provider: route.provider,
            model: route.model,
            costClass: candidate.costClass,
            probeStatus: "not_checked",
            ttftMs: null,
            detail: "No OPENROUTER_API_KEY",
            benchmarkedAt: new Date().toISOString(),
            schemaValid: null, // No schema check if not checked
            contentAccurate: null // No content accuracy check if not checked
          });
          continue;
        }
        await throttler.throttle();
        probeResult = await probeOpenRouterModel(entry, openRouterApiKey);
      } else {
        if (!nvidiaApiKey) {
          results.push({
            role: candidate.role,
            provider: route.provider,
            model: route.model,
            costClass: candidate.costClass,
            probeStatus: "not_checked",
            ttftMs: null,
            detail: "No NVIDIA_API_KEY",
            benchmarkedAt: new Date().toISOString(),
            schemaValid: null, // No schema check if not checked
            contentAccurate: null // No content accuracy check if not checked
          });
          continue;
        }
        probeResult = await probeNvidiaModel(entry, nvidiaApiKey, nvidiaBaseUrl);
      }

      const benchEntry: BenchmarkEntry = {
        role: candidate.role,
        provider: route.provider,
        model: route.model,
        costClass: candidate.costClass,
        probeStatus: probeResult.status,
        ttftMs: probeResult.ttftMs ?? null,
        benchmarkedAt: new Date().toISOString(),
        schemaValid: probeResult.schemaValid ?? null,
        contentAccurate: probeResult.contentAccurate ?? null
      };
      if (probeResult.detail) benchEntry.detail = probeResult.detail;

      results.push(benchEntry);

      const statusMark = probeResult.status === "pass" ? "✓" : probeResult.status === "fail" ? "✗" : "–";
      const ttftDisplay = probeResult.ttftMs !== null ? `${probeResult.ttftMs}ms` : 'N/A';
      console.log(`${statusMark} [${route.provider}] ${route.model} (${ttftDisplay})`);
    }
  }

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify({ benchmarkedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nBenchmark complete. Results written to ${OUTPUT_FILE}`);

  const passing = results.filter(r => r.probeStatus === "pass");
  console.log(`\n${passing.length}/${results.length} routes passed probes.`);
  for (const r of passing.sort((a, b) => (a.ttftMs ?? 9999) - (b.ttftMs ?? 9999))) {
    console.log(`  ${r.ttftMs}ms  [${r.provider}] ${r.model}`);
  }
}

