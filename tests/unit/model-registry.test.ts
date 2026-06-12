import { describe, expect, it } from "vitest";
import { MODEL_REGISTRY, getModelByRole, getRequiredModels } from "../../src/models/model-registry.js";

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
