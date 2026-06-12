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
  provider: string;
  model: string;
  probeTtlMs: number;
  required: boolean;
}

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  {
    role: "locator",
    provider: "nvidia",
    model: "nvidia/LocateAnything-3B",
    probeTtlMs: 24 * 60 * 60 * 1000,
    required: false
  },
  {
    role: "auditor",
    provider: "openrouter",
    model: "qwen/qwen3-vl-30b-a3b-instruct",
    probeTtlMs: 24 * 60 * 60 * 1000,
    required: true
  },
  {
    role: "fast_auditor",
    provider: "openrouter",
    model: "qwen/qwen3-vl-8b-instruct",
    probeTtlMs: 24 * 60 * 60 * 1000,
    required: false
  },
  {
    role: "reviewer",
    provider: "openrouter",
    model: "google/gemini-2.5-flash-lite",
    probeTtlMs: 24 * 60 * 60 * 1000,
    required: true
  },
  {
    role: "escalation",
    provider: "openrouter",
    model: "qwen/qwen3-vl-235b-a22b-instruct",
    probeTtlMs: 24 * 60 * 60 * 1000,
    required: false
  },
  {
    role: "free_auditor",
    provider: "openrouter",
    model: "nex-agi/nex-n2-pro:free",
    probeTtlMs: 15 * 60 * 1000,
    required: false
  },
  {
    role: "free_reviewer",
    provider: "openrouter",
    model: "nvidia/nemotron-nano-12b-v2-vl:free",
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
