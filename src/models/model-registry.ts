import type { VisionMode } from "./vision-json.js";
import type { ProbeResult } from "./probes.js";

/**
 * Normalize a model identifier to its family key for diversity comparisons.
 * Strips OpenRouter routing/tier suffixes (:free, :beta, :nitro, :extended,
 * :floor, :YYYYMMDD permaslugs) so the same model served through two providers
 * maps to the same key.
 *
 * Examples:
 *   nvidia/nemotron-3-nano-omni-30b-a3b-reasoning        → unchanged
 *   nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free   → nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
 *   google/gemma-4-31b-it:free                           → google/gemma-4-31b-it
 *   moonshotai/kimi-k2.6:20250120                        → moonshotai/kimi-k2.6
 */
export function modelFamilyKey(model: string): string {
  return model.replace(/:(?:free|beta|nitro|extended|floor|\d{8})$/i, "");
}

export type { VisionMode };

export type ModelRole =
  | "locator"
  | "auditor"
  | "fast_auditor"
  | "reviewer"
  | "escalation"
  | "target_recovery";

export interface ModelRouteCapabilities {
  maxImages: number;
  supportsJsonSchema: boolean;
  supportsJsonObject: boolean;
  supportsStreaming: boolean;
  allowedRoles: Array<"auditor" | "reviewer" | "target_recovery">;
}

export interface ModelEntry {
  role: ModelRole;
  provider: "openrouter" | "nvidia";
  model: string;
  costClass: "free" | "paid";
  probeTtlMs: number;
  required: boolean;
  capabilities?: ModelRouteCapabilities;
  enabled?: boolean;
}

export function requiredImagesForRole(role: string): number {
  if (role === "auditor" || role === "fast_auditor" || role === "reviewer" || role === "escalation") {
    return 5;
  }
  if (role === "target_recovery") {
    return 4;
  }
  return 2;
}

// Canonical Model Candidate Ranking from docs/superpowers/plans/2026-06-14-free-first-ui-diff-hardening.md
// This is a quality/probe order.
export const CANONICAL_MODEL_RANKING: readonly (Omit<ModelEntry, "required" | "probeTtlMs"> & {
  eligibleFreeProviderRoutes: Array<{ provider: ModelEntry["provider"]; model: string }>;
  paidRoutes?: Array<{ provider: ModelEntry["provider"]; model: string }>;
  defaultFreeModeHandling: string; // Describes the selection logic
})[] = [
  {
    role: "auditor", // Kimi K2.6 family, general purpose
    provider: "nvidia", // Primary provider for ranking purposes
    model: "moonshotai/kimi-k2.6",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "moonshotai/kimi-k2.6" }
    ],
    paidRoutes: [{ provider: "openrouter", model: "moonshotai/kimi-k2.6" }],
    defaultFreeModeHandling: "Probe native NVIDIA in free modes. OpenRouter Kimi is paid and requires explicit paid mode enablement.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "reviewer", // Kimi K2.6 family, strongest reviewer candidate
    provider: "nvidia",
    model: "moonshotai/kimi-k2.6",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "moonshotai/kimi-k2.6" }
    ],
    paidRoutes: [{ provider: "openrouter", model: "moonshotai/kimi-k2.6" }],
    defaultFreeModeHandling: "Probe native NVIDIA in free modes. OpenRouter Kimi is paid and requires explicit paid mode enablement.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "auditor", // MiniMax M3 family, general purpose
    provider: "nvidia",
    model: "minimaxai/minimax-m3",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "minimaxai/minimax-m3" }
    ],
    paidRoutes: [{ provider: "openrouter", model: "minimax/minimax-m3" }],
    defaultFreeModeHandling: "Probe native NVIDIA only in default free mode; block when licensing terms do not permit the run.",
    capabilities: { maxImages: 5, supportsJsonSchema: false, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "reviewer", // MiniMax M3 family, strong independent reviewer candidate
    provider: "nvidia",
    model: "minimaxai/minimax-m3",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "minimaxai/minimax-m3" }
    ],
    paidRoutes: [{ provider: "openrouter", model: "minimax/minimax-m3" }],
    defaultFreeModeHandling: "Probe native NVIDIA in free modes. OpenRouter MiniMax is paid and requires explicit paid mode enablement.",
    capabilities: { maxImages: 5, supportsJsonSchema: false, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "auditor", // Mistral Large 3 family, general purpose
    provider: "nvidia",
    model: "mistralai/mistral-large-3-675b-instruct-2512",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "mistralai/mistral-large-3-675b-instruct-2512" }
    ],
    paidRoutes: [{ provider: "openrouter", model: "mistralai/mistral-large-2512" }],
    defaultFreeModeHandling: "Probe native NVIDIA only in default free mode.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "reviewer", // Mistral Large 3 family, high-quality reviewer candidate
    provider: "nvidia",
    model: "mistralai/mistral-large-3-675b-instruct-2512",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "mistralai/mistral-large-3-675b-instruct-2512" }
    ],
    paidRoutes: [{ provider: "openrouter", model: "mistralai/mistral-large-2512" }],
    defaultFreeModeHandling: "Probe native NVIDIA in free modes. OpenRouter Mistral Large is paid and requires explicit paid mode enablement.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "auditor", // Qwen3.5 397B A17B
    provider: "nvidia",
    model: "qwen/qwen3.5-397b-a17b",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "qwen/qwen3.5-397b-a17b" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA; expect speed/quota risk.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "reviewer", // Qwen3.5 397B A17B
    provider: "nvidia",
    model: "qwen/qwen3.5-397b-a17b",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "qwen/qwen3.5-397b-a17b" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA; expect speed/quota risk.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "auditor", // Qwen3.6 35B A3B
    provider: "nvidia",
    model: "qwen/qwen3.6-35b-a3b",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "qwen/qwen3.6-35b-a3b" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA or self-hosted NIM only.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "reviewer", // Qwen3.6 35B A3B
    provider: "nvidia",
    model: "qwen/qwen3.6-35b-a3b",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "qwen/qwen3.6-35b-a3b" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA or self-hosted NIM only.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "auditor", // Nemotron 3 Nano Omni 30B A3B Reasoning
    provider: "nvidia",
    model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" },
      { provider: "openrouter", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" }
    ],
    defaultFreeModeHandling: "Prefer native NVIDIA; use OpenRouter free only if native route unavailable.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "reviewer", // Nemotron 3 Nano Omni 30B A3B Reasoning
    provider: "nvidia",
    model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning" },
      { provider: "openrouter", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free" }
    ],
    defaultFreeModeHandling: "Prefer native NVIDIA; use OpenRouter free only if native route unavailable.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "reviewer", // Nex N2 Pro
    provider: "openrouter",
    model: "nex-agi/nex-n2-pro:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "nex-agi/nex-n2-pro:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free route when native NVIDIA candidates do not pass probes.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "reviewer", // Gemma 4 31B IT
    provider: "openrouter",
    model: "google/gemma-4-31b-it:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "google/gemma-4-31b-it:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free route; schema must be probed.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["reviewer"] }
  },
  {
    role: "reviewer", // Gemma 4 26B A4B IT
    provider: "openrouter",
    model: "google/gemma-4-26b-a4b-it:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free route; schema must be probed.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["reviewer"] }
  },
  {
    role: "reviewer", // Nemotron Nano 12B v2 VL
    provider: "nvidia",
    model: "nvidia/nemotron-nano-12b-v2-vl",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "nvidia/nemotron-nano-12b-v2-vl" },
      { provider: "openrouter", model: "nvidia/nemotron-nano-12b-v2-vl:free" }
    ],
    defaultFreeModeHandling: "Prefer native NVIDIA; use OpenRouter free only if native route unavailable.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["reviewer"] }
  },
  {
    role: "reviewer", // Llama 3.2 90B Vision Instruct — single-image only on NVIDIA (live evidence)
    provider: "nvidia",
    model: "meta/llama-3.2-90b-vision-instruct",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "meta/llama-3.2-90b-vision-instruct" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA as reviewer/escalation candidate.",
    capabilities: { maxImages: 1, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["reviewer"] }
  },
  {
    role: "reviewer", // Llama 3.2 11B Vision Instruct — single-image only on NVIDIA (live evidence)
    provider: "nvidia",
    model: "meta/llama-3.2-11b-vision-instruct",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "meta/llama-3.2-11b-vision-instruct" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA as lighter crop-level candidate.",
    capabilities: { maxImages: 1, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["reviewer"] }
  },
  {
    role: "auditor", // Nex N2 Pro
    provider: "openrouter",
    model: "nex-agi/nex-n2-pro:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "nex-agi/nex-n2-pro:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free fallback when native NVIDIA candidates fail or are unavailable.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer"] }
  },
  {
    role: "auditor", // Gemma 4 31B IT
    provider: "openrouter",
    model: "google/gemma-4-31b-it:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "google/gemma-4-31b-it:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free fallback; schema must be probed.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor"] }
  },
  {
    role: "auditor", // Gemma 4 26B A4B IT
    provider: "openrouter",
    model: "google/gemma-4-26b-a4b-it:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free fallback; schema must be probed.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor"] }
  },
  {
    role: "reviewer", // Llama 3.1 Nemotron Nano VL 8B
    provider: "nvidia",
    model: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1" }
    ],
    defaultFreeModeHandling: "Native NVIDIA lower-priority crop-level candidate.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["reviewer"] }
  },
  {
    role: "target_recovery", // Cosmos3 Nano Reasoner
    provider: "nvidia",
    model: "nvidia/cosmos3-nano-reasoner",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "nvidia/cosmos3-nano-reasoner" }
    ],
    defaultFreeModeHandling: "Native NVIDIA lower-priority target-recovery candidate.",
    capabilities: { maxImages: 4, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["target_recovery"] }
  },
  {
    role: "target_recovery", // Nex N2 Pro — OpenRouter free fallback for target recovery
    provider: "openrouter",
    model: "nex-agi/nex-n2-pro:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "nex-agi/nex-n2-pro:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free fallback for target recovery when native NVIDIA cosmos3 is unavailable.",
    capabilities: { maxImages: 4, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["target_recovery"] }
  },
  {
    role: "target_recovery", // Gemma 4 31B IT — OpenRouter free fallback for target recovery
    provider: "openrouter",
    model: "google/gemma-4-31b-it:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "google/gemma-4-31b-it:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free fallback for target recovery.",
    capabilities: { maxImages: 4, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["target_recovery"] }
  },
  {
    role: "auditor", // PaliGemma
    provider: "nvidia",
    model: "google/google-paligemma",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "google/google-paligemma" }
    ],
    defaultFreeModeHandling: "Native NVIDIA fallback only if it surprisingly passes UI-diff probes.",
    capabilities: { maxImages: 1, supportsJsonSchema: false, supportsJsonObject: false, supportsStreaming: true, allowedRoles: ["auditor"] }
  }
];

export function getModelByRole(role: ModelRole): ModelEntry | undefined {
  // This function currently returns the first entry; needs to be updated for model selection logic.
  // Will be refactored or removed as part of model selection implementation.
  return undefined;
}

export function getRequiredModels(): ModelEntry[] {
  return CANONICAL_MODEL_RANKING.flatMap(c =>
    c.eligibleFreeProviderRoutes.map(r => ({
      role: c.role,
      provider: r.provider,
      model: r.model,
      costClass: c.costClass,
      probeTtlMs: 15 * 60 * 1000,
      required: false,
      ...(c.capabilities !== undefined ? { capabilities: c.capabilities } : {})
    }))
  );
}

function findValidProbe(
  probeResults: ProbeResult[],
  provider: "openrouter" | "nvidia",
  model: string,
  logicalRole: "auditor" | "reviewer" | "escalation" | "target_recovery"
): ProbeResult | undefined {
  const requiredImages = requiredImagesForRole(logicalRole);
  return probeResults.find(p =>
    p.provider === provider &&
    p.model === model &&
    p.role === logicalRole &&
    p.status === "pass" &&
    p.schemaValid === true &&
    p.contentAccurate === true &&
    (p.maxImagesSupported === undefined || p.maxImagesSupported >= requiredImages)
  );
}

export function selectModelForMode(
  logicalRole: "auditor" | "reviewer" | "escalation" | "target_recovery",
  mode: VisionMode,
  probeResults: ProbeResult[],
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  excludedRoutes: Array<{ provider: ModelEntry["provider"]; model: string }> = []
): ModelEntry | undefined {
  if (mode === "deterministic_only") {
    return undefined;
  }

  const isNvidiaApiKeyConfigured = !!env["NVIDIA_API_KEY"];
  const isPaidModeEnabled = env["UI_DIFF_ENABLE_PAID_MODE"] === "1";
  const isExcluded = (provider: ModelEntry["provider"], model: string) =>
    excludedRoutes.some(route => route.provider === provider && route.model === model);

  for (const candidate of CANONICAL_MODEL_RANKING) {
    if (candidate.role !== logicalRole) {
      continue;
    }

    if (mode === "paid") {
      if (!isPaidModeEnabled) {
        return undefined;
      }
      if (candidate.paidRoutes && candidate.paidRoutes.length > 0) {
        for (const paidRoute of candidate.paidRoutes) {
          if (isExcluded(paidRoute.provider, paidRoute.model)) {
            continue;
          }
          const probe = findValidProbe(probeResults, paidRoute.provider, paidRoute.model, logicalRole);
          if (probe) {
            // Paid models have a longer TTL
            return { ...candidate, provider: paidRoute.provider, model: paidRoute.model, costClass: "paid", required: true, probeTtlMs: 24 * 60 * 60 * 1000 };
          }
        }
      }
    } else { // Free modes
      if (candidate.costClass !== "free") {
        continue; // Skip paid models in free modes
      }

      const eligibleRoutes = candidate.eligibleFreeProviderRoutes;

      // Prioritize native NVIDIA for "free" and "free_nvidia" modes
      if (mode === "free" || mode === "free_nvidia") {
        if (isNvidiaApiKeyConfigured) {
          const nvidiaRoute = eligibleRoutes.find(r => r.provider === "nvidia");
          if (nvidiaRoute) {
            if (!isExcluded(nvidiaRoute.provider, nvidiaRoute.model)) {
              const probe = findValidProbe(probeResults, nvidiaRoute.provider, nvidiaRoute.model, logicalRole);
              if (probe) {
                return { ...candidate, provider: nvidiaRoute.provider, model: nvidiaRoute.model, required: true, probeTtlMs: 15 * 60 * 1000 };
              }
            }
          }
        }
      }

      // Fallback to OpenRouter for "free" and primary for "free_openrouter"
      if (mode === "free" || mode === "free_openrouter") {
        const openRouterRoute = eligibleRoutes.find(r => r.provider === "openrouter");
        if (openRouterRoute) {
          if (!isExcluded(openRouterRoute.provider, openRouterRoute.model)) {
            const probe = findValidProbe(probeResults, openRouterRoute.provider, openRouterRoute.model, logicalRole);
            if (probe) {
              return { ...candidate, provider: openRouterRoute.provider, model: openRouterRoute.model, required: true, probeTtlMs: 15 * 60 * 1000 };
            }
          }
        }
      }
    }
  }

  return undefined;
}

export function selectFallbackModelsForMode(
  logicalRole: "auditor" | "reviewer" | "escalation" | "target_recovery",
  mode: VisionMode,
  probeResults: ProbeResult[],
  maxCandidates: number,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  excludedRoutes: Array<{ provider: ModelEntry["provider"]; model: string }> = []
): ModelEntry[] {
  const results: ModelEntry[] = [];
  const seen = new Set<string>();

  if (mode === "free") {
    // Phase 1: collect NVIDIA-only routes up to maxCandidates.
    // Using free_nvidia ensures NVIDIA-first ordering without mixing in OpenRouter
    // routes during the primary selection loop.
    const nvidiaExcluded = [...excludedRoutes];
    while (results.length < maxCandidates) {
      const next = selectModelForMode(logicalRole, "free_nvidia", probeResults, env, nvidiaExcluded);
      if (!next) break;
      const key = `${next.provider}:${next.model}`;
      if (seen.has(key)) break;
      seen.add(key);
      results.push(next);
      nvidiaExcluded.push({ provider: next.provider, model: next.model });
    }

    // Phase 2: supplement with diverse OpenRouter :free fallbacks.
    // Prefer routes whose modelFamilyKey is not already in the selected NVIDIA
    // primaries so a Calorix-scale NVIDIA 429 cascade falls back to a genuinely
    // different model family rather than a same-model-through-different-provider hop.
    const nvidiaFamilyKeys = new Set(results.map(r => modelFamilyKey(r.model)));
    const orExcluded = [...excludedRoutes, ...results.map(r => ({ provider: r.provider, model: r.model }))];
    const differentFamily: ModelEntry[] = [];
    const sameFamily: ModelEntry[] = [];
    for (;;) {
      const next = selectModelForMode(logicalRole, "free_openrouter", probeResults, env, orExcluded);
      if (!next) break;
      const key = `${next.provider}:${next.model}`;
      orExcluded.push({ provider: next.provider, model: next.model });
      if (seen.has(key)) continue;
      if (nvidiaFamilyKeys.has(modelFamilyKey(next.model))) {
        sameFamily.push(next);
      } else {
        differentFamily.push(next);
      }
      if (differentFamily.length + sameFamily.length >= maxCandidates) break;
    }

    // Add all passing different-family OpenRouter routes.
    for (const c of differentFamily) {
      const key = `${c.provider}:${c.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(c);
      }
    }

    // Same-family OpenRouter route allowed only when no different-family alternative exists.
    // This lets a same-model-through-different-provider route (e.g. nemotron:free when native
    // NVIDIA nemotron is the primary) be the last-resort fallback without being skipped entirely.
    if (differentFamily.length === 0) {
      for (const c of sameFamily) {
        const key = `${c.provider}:${c.model}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(c);
          break;
        }
      }
    }
  } else {
    // Non-free modes: simple sequential selection (no diversity override needed).
    const excluded = [...excludedRoutes];
    while (results.length < maxCandidates) {
      const next = selectModelForMode(logicalRole, mode, probeResults, env, excluded);
      if (!next) break;
      const key = `${next.provider}:${next.model}`;
      if (seen.has(key)) break;
      seen.add(key);
      results.push(next);
      excluded.push({ provider: next.provider, model: next.model });
    }
  }

  return results;
}

export function resolveMode(rawMode: string | undefined): VisionMode {
  // 'free_only' is deprecated and now treated as 'free'
  if (rawMode === "free_only") {
    console.warn("Deprecation Warning: 'free_only' mode is deprecated and will be treated as 'free'. Please update your configuration.");
    return "free";
  }
  const valid: VisionMode[] = ["free", "free_openrouter", "free_nvidia", "paid", "deterministic_only"];
  if (valid.includes(rawMode as VisionMode)) {
    return rawMode as VisionMode;
  }
  return "free";
}
