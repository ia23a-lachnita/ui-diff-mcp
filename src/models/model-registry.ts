import type { VisionMode } from "./vision-json.js";
import type { ProbeResult } from "./probes.js";

export type { VisionMode };

export type ModelRole =
  | "locator"
  | "auditor"
  | "fast_auditor"
  | "reviewer"
  | "escalation"
  | "target_recovery";

export interface ModelEntry {
  role: ModelRole;
  provider: "openrouter" | "nvidia";
  model: string;
  costClass: "free" | "paid";
  probeTtlMs: number;
  required: boolean;
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
    defaultFreeModeHandling: "Probe native NVIDIA in free modes. OpenRouter Kimi is paid and requires explicit paid mode enablement."
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
    defaultFreeModeHandling: "Probe native NVIDIA in free modes. OpenRouter Kimi is paid and requires explicit paid mode enablement."
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
    defaultFreeModeHandling: "Probe native NVIDIA only in default free mode; block when licensing terms do not permit the run."
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
    defaultFreeModeHandling: "Probe native NVIDIA in free modes. OpenRouter MiniMax is paid and requires explicit paid mode enablement."
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
    defaultFreeModeHandling: "Probe native NVIDIA only in default free mode."
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
    defaultFreeModeHandling: "Probe native NVIDIA in free modes. OpenRouter Mistral Large is paid and requires explicit paid mode enablement."
  },
  {
    role: "auditor", // Qwen3.5 397B A17B
    provider: "nvidia",
    model: "qwen/qwen3.5-397b-a17b",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "qwen/qwen3.5-397b-a17b" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA; expect speed/quota risk."
  },
  {
    role: "reviewer", // Qwen3.5 397B A17B
    provider: "nvidia",
    model: "qwen/qwen3.5-397b-a17b",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "qwen/qwen3.5-397b-a17b" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA; expect speed/quota risk."
  },
  {
    role: "auditor", // Qwen3.6 35B A3B
    provider: "nvidia",
    model: "qwen/qwen3.6-35b-a3b",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "qwen/qwen3.6-35b-a3b" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA or self-hosted NIM only."
  },
  {
    role: "reviewer", // Qwen3.6 35B A3B
    provider: "nvidia",
    model: "qwen/qwen3.6-35b-a3b",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "qwen/qwen3.6-35b-a3b" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA or self-hosted NIM only."
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
    defaultFreeModeHandling: "Prefer native NVIDIA; use OpenRouter free only if native route unavailable."
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
    defaultFreeModeHandling: "Prefer native NVIDIA; use OpenRouter free only if native route unavailable."
  },
  {
    role: "reviewer", // Nex N2 Pro
    provider: "openrouter",
    model: "nex-agi/nex-n2-pro:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "nex-agi/nex-n2-pro:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free route when native NVIDIA candidates do not pass probes."
  },
  {
    role: "reviewer", // Gemma 4 31B IT
    provider: "openrouter",
    model: "google/gemma-4-31b-it:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "google/gemma-4-31b-it:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free route; schema must be probed."
  },
  {
    role: "reviewer", // Gemma 4 26B A4B IT
    provider: "openrouter",
    model: "google/gemma-4-26b-a4b-it:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free route; schema must be probed."
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
    defaultFreeModeHandling: "Prefer native NVIDIA; use OpenRouter free only if native route unavailable."
  },
  {
    role: "reviewer", // Llama 3.2 90B Vision Instruct
    provider: "nvidia",
    model: "meta/llama-3.2-90b-vision-instruct",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "meta/llama-3.2-90b-vision-instruct" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA as reviewer/escalation candidate."
  },
  {
    role: "reviewer", // Llama 3.2 11B Vision Instruct
    provider: "nvidia",
    model: "meta/llama-3.2-11b-vision-instruct",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "meta/llama-3.2-11b-vision-instruct" }
    ],
    defaultFreeModeHandling: "Probe native NVIDIA as lighter crop-level candidate."
  },
  {
    role: "auditor", // Nex N2 Pro
    provider: "openrouter",
    model: "nex-agi/nex-n2-pro:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "nex-agi/nex-n2-pro:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free fallback when native NVIDIA candidates fail or are unavailable."
  },
  {
    role: "auditor", // Gemma 4 31B IT
    provider: "openrouter",
    model: "google/gemma-4-31b-it:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "google/gemma-4-31b-it:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free fallback; schema must be probed."
  },
  {
    role: "auditor", // Gemma 4 26B A4B IT
    provider: "openrouter",
    model: "google/gemma-4-26b-a4b-it:free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" }
    ],
    defaultFreeModeHandling: "OpenRouter free fallback; schema must be probed."
  },
  {
    role: "reviewer", // Llama 3.1 Nemotron Nano VL 8B
    provider: "nvidia",
    model: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1" }
    ],
    defaultFreeModeHandling: "Native NVIDIA lower-priority crop-level candidate."
  },
  {
    role: "target_recovery", // Cosmos3 Nano Reasoner
    provider: "nvidia",
    model: "nvidia/cosmos3-nano-reasoner",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "nvidia/cosmos3-nano-reasoner" }
    ],
    defaultFreeModeHandling: "Native NVIDIA lower-priority target-recovery candidate."
  },
  {
    role: "auditor", // PaliGemma
    provider: "nvidia",
    model: "google/google-paligemma",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "nvidia", model: "google/google-paligemma" }
    ],
    defaultFreeModeHandling: "Native NVIDIA fallback only if it surprisingly passes UI-diff probes."
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
      required: false
    }))
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
          const probe = probeResults.find(p => p.model === paidRoute.model && p.provider === paidRoute.provider);
          if (probe?.status === "pass") {
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
            if (isExcluded(nvidiaRoute.provider, nvidiaRoute.model)) {
              continue;
            }
            const probe = probeResults.find(p => p.model === nvidiaRoute.model && p.provider === nvidiaRoute.provider);
            if (probe?.status === "pass") {
              return { ...candidate, provider: nvidiaRoute.provider, model: nvidiaRoute.model, required: true, probeTtlMs: 15 * 60 * 1000 };
            }
          }
        }
      }

      // Fallback to OpenRouter for "free" and primary for "free_openrouter"
      if (mode === "free" || mode === "free_openrouter") {
        const openRouterRoute = eligibleRoutes.find(r => r.provider === "openrouter");
        if (openRouterRoute) {
          if (isExcluded(openRouterRoute.provider, openRouterRoute.model)) {
            continue;
          }
          const probe = probeResults.find(p => p.model === openRouterRoute.model && p.provider === openRouterRoute.provider);
          if (probe?.status === "pass") {
            return { ...candidate, provider: openRouterRoute.provider, model: openRouterRoute.model, required: true, probeTtlMs: 15 * 60 * 1000 };
          }
        }
      }
    }
  }

  return undefined;
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
