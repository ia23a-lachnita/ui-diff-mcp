import { describe, expect, it } from "vitest";
import { CANONICAL_MODEL_RANKING, getModelByRole, getRequiredModels, selectModelForMode, resolveMode } from "../../src/models/model-registry.js";
import type { ProbeResult } from "../../src/models/probes.js";

const NOW = new Date().toISOString();

function makeProbe(provider: string, model: string, status: "pass" | "fail" | "not_checked" = "pass"): ProbeResult {
  return { role: "auditor", provider, model, status, checkedAt: NOW };
}

function allPass(): ProbeResult[] {
  return CANONICAL_MODEL_RANKING.flatMap(c => [
    ...c.eligibleFreeProviderRoutes.map(r => makeProbe(r.provider, r.model)),
    ...(c.paidRoutes ?? []).map(r => makeProbe(r.provider, r.model))
  ]);
}

describe("CANONICAL_MODEL_RANKING", () => {
  it("contains auditor and reviewer entries", () => {
    const roles = CANONICAL_MODEL_RANKING.map(c => c.role);
    expect(roles).toContain("auditor");
    expect(roles).toContain("reviewer");
  });

  it("all entries have at least one eligible free route", () => {
    for (const c of CANONICAL_MODEL_RANKING) {
      expect(c.eligibleFreeProviderRoutes.length).toBeGreaterThan(0);
    }
  });

  it("all entries have costClass free", () => {
    for (const c of CANONICAL_MODEL_RANKING) {
      expect(c.costClass).toBe("free");
    }
  });
});

describe("getModelByRole / getRequiredModels", () => {
  it("getModelByRole returns undefined (placeholder)", () => {
    expect(getModelByRole("auditor")).toBeUndefined();
  });

  it("getRequiredModels returns empty array (placeholder)", () => {
    expect(getRequiredModels()).toEqual([]);
  });
});

describe("selectModelForMode", () => {
  const noEnv: Record<string, string | undefined> = {};
  const withNvidia: Record<string, string | undefined> = { NVIDIA_API_KEY: "test-key" };

  it("free mode without NVIDIA key picks first passing OpenRouter :free auditor", () => {
    const openRouterAuditor = CANONICAL_MODEL_RANKING.find(
      c => c.role === "auditor" && c.eligibleFreeProviderRoutes.some(r => r.provider === "openrouter")
    );
    const route = openRouterAuditor?.eligibleFreeProviderRoutes.find(r => r.provider === "openrouter");
    if (!route || !openRouterAuditor) return;
    const probes: ProbeResult[] = [makeProbe(route.provider, route.model)];
    const entry = selectModelForMode("auditor", "free", probes, noEnv);
    expect(entry).toBeDefined();
    expect(entry?.costClass).toBe("free");
    expect(entry?.provider).toBe("openrouter");
  });

  it("free mode with NVIDIA key picks first passing native NVIDIA auditor", () => {
    const nvidiaAuditor = CANONICAL_MODEL_RANKING.find(
      c => c.role === "auditor" && c.eligibleFreeProviderRoutes.some(r => r.provider === "nvidia")
    );
    const route = nvidiaAuditor?.eligibleFreeProviderRoutes.find(r => r.provider === "nvidia");
    if (!route || !nvidiaAuditor) return;
    const probes: ProbeResult[] = [makeProbe(route.provider, route.model)];
    const entry = selectModelForMode("auditor", "free", probes, withNvidia);
    expect(entry).toBeDefined();
    expect(entry?.costClass).toBe("free");
    expect(entry?.provider).toBe("nvidia");
    expect(entry?.model).not.toContain(":free");
  });

  it("free_openrouter always picks OpenRouter :free even with NVIDIA key", () => {
    const entry = selectModelForMode("auditor", "free_openrouter", allPass(), withNvidia);
    expect(entry?.provider).toBe("openrouter");
  });

  it("free_nvidia picks NVIDIA entry when key is set and probes pass", () => {
    const entry = selectModelForMode("auditor", "free_nvidia", allPass(), withNvidia);
    expect(entry?.provider).toBe("nvidia");
    expect(entry?.costClass).toBe("free");
  });

  it("free_nvidia returns undefined when NVIDIA key is absent", () => {
    const entry = selectModelForMode("auditor", "free_nvidia", allPass(), noEnv);
    expect(entry).toBeUndefined();
  });

  it("returns undefined when no probes pass", () => {
    const entry = selectModelForMode("auditor", "free", [], withNvidia);
    expect(entry).toBeUndefined();
  });

  it("paid mode returns undefined when registry has no paid entries", () => {
    const auditor = selectModelForMode("auditor", "paid", allPass(), noEnv);
    expect(auditor).toBeUndefined();
  });

  it("paid mode never returns a :free OpenRouter model", () => {
    const entry = selectModelForMode("auditor", "paid", allPass(), noEnv);
    if (entry) {
      expect(entry.model).not.toContain(":free");
    } else {
      expect(entry).toBeUndefined();
    }
  });

  it("deterministic_only returns undefined for all roles", () => {
    expect(selectModelForMode("auditor", "deterministic_only", allPass(), noEnv)).toBeUndefined();
    expect(selectModelForMode("reviewer", "deterministic_only", allPass(), noEnv)).toBeUndefined();
    expect(selectModelForMode("escalation", "deterministic_only", allPass(), noEnv)).toBeUndefined();
  });

  it("escalation is not available in free modes (no escalation in CANONICAL_MODEL_RANKING)", () => {
    expect(selectModelForMode("escalation", "free", allPass(), noEnv)).toBeUndefined();
    expect(selectModelForMode("escalation", "free_openrouter", allPass(), noEnv)).toBeUndefined();
    expect(selectModelForMode("escalation", "free_nvidia", allPass(), withNvidia)).toBeUndefined();
  });
});

describe("resolveMode", () => {
  it("treats free_only as alias for free", () => {
    expect(resolveMode("free_only")).toBe("free");
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
