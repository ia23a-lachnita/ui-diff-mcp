import type { VisionMode, VisionProvider } from "./vision-json.js";
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

export const FREE_PROVIDER_PHASE_ORDER: readonly VisionProvider[] = [
  "gemini",
  "mistral",
  "opencode",
  "nvidia",
  "openrouter"
];

export function freeProviderPhaseOrderForMode(mode: VisionMode): readonly VisionProvider[] {
  if (mode === "free") return FREE_PROVIDER_PHASE_ORDER;
  if (mode === "free_gemini") return ["gemini"];
  if (mode === "free_mistral") return ["mistral"];
  if (mode === "free_opencode") return ["opencode"];
  if (mode === "free_nvidia") return ["nvidia"];
  if (mode === "free_openrouter") return ["openrouter"];
  return [];
}

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
  provider: VisionProvider;
  model: string;
  costClass: "free" | "paid";
  probeTtlMs: number;
  required: boolean;
  capabilities?: ModelRouteCapabilities;
  enabled?: boolean;
}

export function candidateSupportsLogicalRole(
  candidate: Pick<ModelEntry, "role" | "capabilities">,
  logicalRole: "auditor" | "reviewer" | "escalation" | "target_recovery"
): boolean {
  if (candidate.role === logicalRole) return true;
  if (!candidate.capabilities) return false;
  if (logicalRole === "target_recovery") {
    return candidate.capabilities.maxImages >= 4 && candidate.capabilities.allowedRoles.includes("target_recovery");
  }
  return (candidate.capabilities.allowedRoles as string[]).includes(logicalRole);
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
    role: "auditor",
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "gemini", model: "gemini-3.1-pro-preview" }
    ],
    defaultFreeModeHandling: "Strongest Gemini direct route visible on this machine; free-tier quota may be zero and must be probe-gated.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "reviewer",
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "gemini", model: "gemini-3.1-pro-preview" }
    ],
    defaultFreeModeHandling: "Strongest Gemini direct reviewer route visible on this machine; free-tier quota may be zero and must be probe-gated.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "target_recovery",
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "gemini", model: "gemini-3.1-pro-preview" }
    ],
    defaultFreeModeHandling: "Strong Gemini direct recovery route when quota is available.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "auditor",
    provider: "gemini",
    model: "gemini-3.5-flash",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "gemini", model: "gemini-3.5-flash" }
    ],
    defaultFreeModeHandling: "Current Gemini Flash route available through the direct Gemini API; probe-gated for multimodal JSON.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "reviewer",
    provider: "gemini",
    model: "gemini-3.5-flash",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "gemini", model: "gemini-3.5-flash" }
    ],
    defaultFreeModeHandling: "Current Gemini Flash reviewer route available through the direct Gemini API; probe-gated for multimodal JSON.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "target_recovery",
    provider: "gemini",
    model: "gemini-3.5-flash",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "gemini", model: "gemini-3.5-flash" }
    ],
    defaultFreeModeHandling: "Gemini Flash recovery route available through the direct Gemini API; probe-gated for multimodal JSON.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "auditor",
    provider: "mistral",
    model: "ministral-14b-2512",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "mistral", model: "ministral-14b-2512" }
    ],
    defaultFreeModeHandling: "Direct Mistral Ministral 14B route passed the live five-image role probe; probe-gated for multimodal JSON.",
    capabilities: { maxImages: 5, supportsJsonSchema: false, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "reviewer",
    provider: "mistral",
    model: "ministral-14b-2512",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "mistral", model: "ministral-14b-2512" }
    ],
    defaultFreeModeHandling: "Direct Mistral Ministral 14B reviewer route passed the live five-image role probe; probe-gated for multimodal JSON.",
    capabilities: { maxImages: 5, supportsJsonSchema: false, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "target_recovery",
    provider: "mistral",
    model: "ministral-14b-2512",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "mistral", model: "ministral-14b-2512" }
    ],
    defaultFreeModeHandling: "Direct Mistral Ministral 14B recovery route passed the live five-image role probe; probe-gated for multimodal JSON.",
    capabilities: { maxImages: 5, supportsJsonSchema: false, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "auditor",
    provider: "mistral",
    model: "ministral-8b-2512",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "mistral", model: "ministral-8b-2512" }
    ],
    defaultFreeModeHandling: "Direct Mistral Ministral 8B fallback passed the live five-image role probe.",
    capabilities: { maxImages: 5, supportsJsonSchema: false, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "reviewer",
    provider: "mistral",
    model: "ministral-8b-2512",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "mistral", model: "ministral-8b-2512" }
    ],
    defaultFreeModeHandling: "Direct Mistral Ministral 8B reviewer fallback; content accuracy remains probe-gated.",
    capabilities: { maxImages: 5, supportsJsonSchema: false, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "target_recovery",
    provider: "mistral",
    model: "ministral-8b-2512",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "mistral", model: "ministral-8b-2512" }
    ],
    defaultFreeModeHandling: "Direct Mistral Ministral 8B recovery fallback; content accuracy remains probe-gated.",
    capabilities: { maxImages: 5, supportsJsonSchema: false, supportsJsonObject: true, supportsStreaming: false, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "auditor",
    provider: "opencode",
    model: "mimo-v2.5-free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "opencode", model: "mimo-v2.5-free" }
    ],
    defaultFreeModeHandling: "Preferred free visual route through the direct OpenCode Zen API; availability is probe-gated.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
  {
    role: "reviewer",
    provider: "opencode",
    model: "mimo-v2.5-free",
    costClass: "free",
    eligibleFreeProviderRoutes: [
      { provider: "opencode", model: "mimo-v2.5-free" }
    ],
    defaultFreeModeHandling: "Preferred strong free visual reviewer through the direct OpenCode Zen API; availability is probe-gated.",
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
  },
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: false, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: false, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "reviewer", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "target_recovery"] }
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
    capabilities: { maxImages: 5, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["auditor", "target_recovery"] }
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
  provider: VisionProvider,
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
    if (!candidateSupportsLogicalRole(candidate, logicalRole)) {
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

      if (mode === "free" || mode === "free_gemini") {
        const geminiRoute = eligibleRoutes.find(r => r.provider === "gemini");
        if (geminiRoute && !isExcluded(geminiRoute.provider, geminiRoute.model)) {
          const probe = findValidProbe(probeResults, geminiRoute.provider, geminiRoute.model, logicalRole);
          if (probe) {
            return { ...candidate, provider: geminiRoute.provider, model: geminiRoute.model, required: true, probeTtlMs: 15 * 60 * 1000 };
          }
        }
      }

      if (mode === "free" || mode === "free_mistral") {
        const mistralRoute = eligibleRoutes.find(r => r.provider === "mistral");
        if (mistralRoute && !isExcluded(mistralRoute.provider, mistralRoute.model)) {
          const probe = findValidProbe(probeResults, mistralRoute.provider, mistralRoute.model, logicalRole);
          if (probe) {
            return { ...candidate, provider: mistralRoute.provider, model: mistralRoute.model, required: true, probeTtlMs: 15 * 60 * 1000 };
          }
        }
      }

      if (mode === "free" || mode === "free_opencode") {
        const openCodeRoute = eligibleRoutes.find(r => r.provider === "opencode");
        if (openCodeRoute && !isExcluded(openCodeRoute.provider, openCodeRoute.model)) {
          const probe = findValidProbe(probeResults, openCodeRoute.provider, openCodeRoute.model, logicalRole);
          if (probe) {
            return { ...candidate, provider: openCodeRoute.provider, model: openCodeRoute.model, required: true, probeTtlMs: 15 * 60 * 1000 };
          }
        }
      }

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
    for (const provider of FREE_PROVIDER_PHASE_ORDER) {
      const phase = `free_${provider}` as VisionMode;
      if (results.length >= maxCandidates) break;
      const phaseExcluded = [...excludedRoutes, ...results.map(r => ({ provider: r.provider, model: r.model }))];
      const differentFamily: ModelEntry[] = [];
      const sameFamily: ModelEntry[] = [];
      const existingFamilies = new Set(results.map(r => modelFamilyKey(r.model)));
      const remainingSlots = maxCandidates - results.length;

      while (differentFamily.length < remainingSlots) {
        const next = selectModelForMode(logicalRole, phase, probeResults, env, phaseExcluded);
        if (!next) break;
        phaseExcluded.push({ provider: next.provider, model: next.model });
        const key = `${next.provider}:${next.model}`;
        if (seen.has(key)) continue;
        if (existingFamilies.has(modelFamilyKey(next.model))) sameFamily.push(next);
        else differentFamily.push(next);
      }

      const selected = differentFamily.length > 0 ? differentFamily : sameFamily.slice(0, 1);
      for (const candidate of selected) {
        if (results.length >= maxCandidates) break;
        const key = `${candidate.provider}:${candidate.model}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push(candidate);
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

export interface IndependentReviewerCandidate {
  provider: string;
  model: string;
}

export function selectIndependentReviewer(
  reviewerCandidates: IndependentReviewerCandidate[],
  recoveryProvider: string,
  recoveryModel: string
): IndependentReviewerCandidate | undefined {
  return orderIndependentReviewerCandidates(reviewerCandidates, recoveryProvider, recoveryModel)[0];
}

export function orderIndependentReviewerCandidates(
  reviewerCandidates: IndependentReviewerCandidate[],
  recoveryProvider: string,
  recoveryModel: string
): IndependentReviewerCandidate[] {
  const recoveryFamily = modelFamilyKey(recoveryModel);
  return reviewerCandidates
    .filter(c => !(c.provider === recoveryProvider && c.model === recoveryModel))
    .filter(c => modelFamilyKey(c.model) !== recoveryFamily)
    .sort((a, b) => {
      const aDiffProvider = a.provider !== recoveryProvider ? 0 : 1;
      const bDiffProvider = b.provider !== recoveryProvider ? 0 : 1;
      if (aDiffProvider !== bDiffProvider) return aDiffProvider - bDiffProvider;
      return 0;
    });
}

export function resolveMode(rawMode: string | undefined): VisionMode {
  // 'free_only' is deprecated and now treated as 'free'
  if (rawMode === "free_only") {
    console.warn("Deprecation Warning: 'free_only' mode is deprecated and will be treated as 'free'. Please update your configuration.");
    return "free";
  }
  const valid: VisionMode[] = ["free", "free_gemini", "free_mistral", "free_opencode", "free_openrouter", "free_nvidia", "paid", "deterministic_only"];
  if (valid.includes(rawMode as VisionMode)) {
    return rawMode as VisionMode;
  }
  return "free";
}
