import { describe, expect, it } from "vitest";
import { MODEL_REGISTRY, getModelByRole, getRequiredModels, selectModelForMode, resolveMode } from "../../src/models/model-registry.js";

describe("model-registry", () => {
  it("contains all required model roles", () => {
    const roles = MODEL_REGISTRY.map(m => m.role);
    expect(roles).toContain("auditor");
    expect(roles).toContain("reviewer");
    expect(roles).toContain("escalation");
    expect(roles).toContain("free_auditor");
  });

  it("uses exact model IDs from the approved spec", () => {
    expect(getModelByRole("auditor")?.model).toBe("qwen/qwen3-vl-30b-a3b-instruct");
    expect(getModelByRole("reviewer")?.model).toBe("google/gemini-2.5-flash-lite");
    expect(getModelByRole("escalation")?.model).toBe("qwen/qwen3-vl-235b-a22b-instruct");
    expect(getModelByRole("free_auditor")?.model).toBe("nex-agi/nex-n2-pro:free");
    expect(getModelByRole("free_reviewer")?.model).toBe("nvidia/nemotron-nano-12b-v2-vl:free");
  });

  it("marks paid model entries with costClass paid", () => {
    expect(getModelByRole("auditor")?.costClass).toBe("paid");
    expect(getModelByRole("reviewer")?.costClass).toBe("paid");
    expect(getModelByRole("escalation")?.costClass).toBe("paid");
  });

  it("marks free model entries with costClass free", () => {
    expect(getModelByRole("free_auditor")?.costClass).toBe("free");
    expect(getModelByRole("free_reviewer")?.costClass).toBe("free");
  });

  it("uses 15min TTL for free models and 24h for paid models", () => {
    const freeAuditor = getModelByRole("free_auditor");
    const auditor = getModelByRole("auditor");
    expect(freeAuditor?.probeTtlMs).toBe(15 * 60 * 1000);
    expect(auditor?.probeTtlMs).toBe(24 * 60 * 60 * 1000);
  });

  it("getRequiredModels returns only required entries", () => {
    const required = getRequiredModels();
    expect(required.every(m => m.required)).toBe(true);
    expect(required.length).toBeGreaterThan(0);
  });
});

describe("selectModelForMode", () => {
  const noEnv: Record<string, string | undefined> = {};
  const withNvidia: Record<string, string | undefined> = { NVIDIA_API_KEY: "test-key" };

  it("free mode without NVIDIA key returns OpenRouter :free auditor", () => {
    const entry = selectModelForMode("auditor", "free", noEnv);
    expect(entry).toBeDefined();
    expect(entry?.costClass).toBe("free");
    expect(entry?.model).toContain(":free");
    expect(entry?.provider).toBe("openrouter");
  });

  it("free mode without NVIDIA key returns OpenRouter :free reviewer", () => {
    const entry = selectModelForMode("reviewer", "free", noEnv);
    expect(entry).toBeDefined();
    expect(entry?.costClass).toBe("free");
    expect(entry?.provider).toBe("openrouter");
  });

  it("free mode with NVIDIA key returns native NVIDIA model", () => {
    const entry = selectModelForMode("auditor", "free", withNvidia);
    expect(entry).toBeDefined();
    expect(entry?.costClass).toBe("free");
    expect(entry?.provider).toBe("nvidia");
    expect(entry?.model).not.toContain(":free");
  });

  it("free_openrouter always returns OpenRouter :free regardless of NVIDIA key", () => {
    const entry = selectModelForMode("auditor", "free_openrouter", withNvidia);
    expect(entry?.provider).toBe("openrouter");
    expect(entry?.model).toContain(":free");
  });

  it("free_nvidia returns NVIDIA entry when key is set", () => {
    const entry = selectModelForMode("auditor", "free_nvidia", withNvidia);
    expect(entry?.provider).toBe("nvidia");
    expect(entry?.costClass).toBe("free");
  });

  it("free_nvidia returns undefined when NVIDIA key is absent", () => {
    const entry = selectModelForMode("auditor", "free_nvidia", noEnv);
    expect(entry).toBeUndefined();
  });

  it("paid mode never returns a free model", () => {
    const auditor = selectModelForMode("auditor", "paid", noEnv);
    const reviewer = selectModelForMode("reviewer", "paid", noEnv);
    expect(auditor?.costClass).toBe("paid");
    expect(reviewer?.costClass).toBe("paid");
    expect(auditor?.model).toBe("qwen/qwen3-vl-30b-a3b-instruct");
    expect(reviewer?.model).toBe("google/gemini-2.5-flash-lite");
  });

  it("paid mode never returns a :free OpenRouter model", () => {
    const auditor = selectModelForMode("auditor", "paid", noEnv);
    expect(auditor?.model).not.toContain(":free");
  });

  it("deterministic_only returns undefined for all roles", () => {
    expect(selectModelForMode("auditor", "deterministic_only", noEnv)).toBeUndefined();
    expect(selectModelForMode("reviewer", "deterministic_only", noEnv)).toBeUndefined();
    expect(selectModelForMode("escalation", "deterministic_only", noEnv)).toBeUndefined();
  });

  it("escalation is not available in free modes", () => {
    expect(selectModelForMode("escalation", "free", noEnv)).toBeUndefined();
    expect(selectModelForMode("escalation", "free_openrouter", noEnv)).toBeUndefined();
    expect(selectModelForMode("escalation", "free_nvidia", withNvidia)).toBeUndefined();
  });
});

describe("resolveMode", () => {
  it("treats free_only as alias for free", () => {
    expect(resolveMode("free_only")).toBe("free");
  });

  it("treats full as alias for free", () => {
    expect(resolveMode("full")).toBe("free");
  });

  it("passes through valid modes unchanged", () => {
    expect(resolveMode("free")).toBe("free");
    expect(resolveMode("free_openrouter")).toBe("free_openrouter");
    expect(resolveMode("free_nvidia")).toBe("free_nvidia");
    expect(resolveMode("paid")).toBe("paid");
    expect(resolveMode("deterministic_only")).toBe("deterministic_only");
  });

  it("defaults unknown modes to free", () => {
    expect(resolveMode(undefined)).toBe("free");
    expect(resolveMode("nonsense")).toBe("free");
  });
});
