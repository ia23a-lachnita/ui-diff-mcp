import type { VisionMode } from "./vision-json.js";

export type { VisionMode };

export type ModelRole =
  | "locator"
  | "auditor"
  | "fast_auditor"
  | "reviewer"
  | "escalation"
  | "free_auditor"
  | "free_reviewer";

export interface ModelEntry {
  role: ModelRole;
  provider: "openrouter" | "nvidia";
  model: string;
  costClass: "free" | "paid";
  probeTtlMs: number;
  required: boolean;
}

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  {
    role: "locator",
    provider: "nvidia",
    model: "nvidia/LocateAnything-3B",
    costClass: "free",
    probeTtlMs: 24 * 60 * 60 * 1000,
    required: false
  },
  {
    role: "auditor",
    provider: "openrouter",
    model: "qwen/qwen3-vl-30b-a3b-instruct",
    costClass: "paid",
    probeTtlMs: 24 * 60 * 60 * 1000,
    required: true
  },
  {
    role: "fast_auditor",
    provider: "openrouter",
    model: "qwen/qwen3-vl-8b-instruct",
    costClass: "paid",
    probeTtlMs: 24 * 60 * 60 * 1000,
    required: false
  },
  {
    role: "reviewer",
    provider: "openrouter",
    model: "google/gemini-2.5-flash-lite",
    costClass: "paid",
    probeTtlMs: 24 * 60 * 60 * 1000,
    required: true
  },
  {
    role: "escalation",
    provider: "openrouter",
    model: "qwen/qwen3-vl-235b-a22b-instruct",
    costClass: "paid",
    probeTtlMs: 24 * 60 * 60 * 1000,
    required: false
  },
  {
    role: "free_auditor",
    provider: "openrouter",
    model: "nex-agi/nex-n2-pro:free",
    costClass: "free",
    probeTtlMs: 15 * 60 * 1000,
    required: false
  },
  {
    role: "free_reviewer",
    provider: "openrouter",
    model: "nvidia/nemotron-nano-12b-v2-vl:free",
    costClass: "free",
    probeTtlMs: 15 * 60 * 1000,
    required: false
  }
] as const;

export function getModelByRole(role: ModelRole): ModelEntry | undefined {
  return MODEL_REGISTRY.find(m => m.role === role);
}

export function getRequiredModels(): ModelEntry[] {
  return MODEL_REGISTRY.filter(m => m.required);
}

const FREE_NVIDIA_AUDITOR_MODEL = "moonshotai/kimi-k2.6";
const FREE_NVIDIA_REVIEWER_MODEL = "nvidia/nemotron-nano-12b-v2-vl";

export function selectModelForMode(
  logicalRole: "auditor" | "reviewer" | "escalation",
  mode: VisionMode,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): ModelEntry | undefined {
  if (mode === "deterministic_only") return undefined;

  if (mode === "paid") {
    return MODEL_REGISTRY.find(m => m.role === logicalRole && m.costClass === "paid");
  }

  if (logicalRole === "escalation") return undefined;

  const freeRole: ModelRole = logicalRole === "auditor" ? "free_auditor" : "free_reviewer";

  if (mode === "free_openrouter") {
    return MODEL_REGISTRY.find(m => m.role === freeRole && m.provider === "openrouter");
  }

  const nvidiaModel = logicalRole === "auditor" ? FREE_NVIDIA_AUDITOR_MODEL : FREE_NVIDIA_REVIEWER_MODEL;
  const nvidiaApiKey = env["NVIDIA_API_KEY"];

  if (mode === "free_nvidia") {
    if (!nvidiaApiKey) return undefined;
    return { role: freeRole, provider: "nvidia", model: nvidiaModel, costClass: "free", probeTtlMs: 15 * 60 * 1000, required: false };
  }

  // free mode: prefer native NVIDIA when key is configured, else OpenRouter :free
  if (nvidiaApiKey) {
    return { role: freeRole, provider: "nvidia", model: nvidiaModel, costClass: "free", probeTtlMs: 15 * 60 * 1000, required: false };
  }
  return MODEL_REGISTRY.find(m => m.role === freeRole && m.provider === "openrouter");
}

export function resolveMode(rawMode: string | undefined): VisionMode {
  if (rawMode === "free_only" || rawMode === "full") return "free";
  const valid: VisionMode[] = ["free", "free_openrouter", "free_nvidia", "paid", "deterministic_only"];
  if (valid.includes(rawMode as VisionMode)) return rawMode as VisionMode;
  return "free";
}
