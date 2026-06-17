import { describe, expect, it } from "vitest";
import { CANONICAL_MODEL_RANKING, getModelByRole, getRequiredModels, selectModelForMode, selectFallbackModelsForMode, resolveMode, requiredImagesForRole } from "../../src/models/model-registry.js";
import type { ProbeResult } from "../../src/models/probes.js";

const NOW = new Date().toISOString();

function makeProbe(provider: string, model: string, role: string = "auditor", status: "pass" | "fail" | "not_checked" = "pass", maxImagesSupported = 5): ProbeResult {
  return { role, provider, model, status, checkedAt: NOW, schemaValid: status === "pass", contentAccurate: status === "pass", maxImagesSupported };
}

function allPass(): ProbeResult[] {
  return CANONICAL_MODEL_RANKING.flatMap(c => {
    const maxImages = c.role === "target_recovery" ? 4 : 5;
    return [
      ...c.eligibleFreeProviderRoutes.map(r => makeProbe(r.provider, r.model, c.role, "pass", maxImages)),
      ...(c.paidRoutes ?? []).map(r => makeProbe(r.provider, r.model, c.role, "pass", maxImages))
    ];
  });
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

  it("does not include the stale OpenRouter Kimi K2.6 free route", () => {
    const routes = CANONICAL_MODEL_RANKING.flatMap(c => c.eligibleFreeProviderRoutes);
    expect(routes).not.toContainEqual({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6:free"
    });
  });
});

describe("getModelByRole / getRequiredModels", () => {
  it("getModelByRole returns undefined (placeholder)", () => {
    expect(getModelByRole("auditor")).toBeUndefined();
  });

  it("getRequiredModels returns all free candidate entries from CANONICAL_MODEL_RANKING", () => {
    const models = getRequiredModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every(m => m.costClass === "free")).toBe(true);
    expect(models.some(m => m.role === "auditor")).toBe(true);
    expect(models.some(m => m.role === "reviewer")).toBe(true);
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
    const probes: ProbeResult[] = [makeProbe(route.provider, route.model, "auditor")];
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
    const probes: ProbeResult[] = [makeProbe(route.provider, route.model, "auditor")];
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

  it("free_nvidia reviewer selects a strong top-ranked model before nano VL routes", () => {
    const entry = selectModelForMode("reviewer", "free_nvidia", allPass(), withNvidia);
    expect(entry?.provider).toBe("nvidia");
    expect(entry?.model).toBe("moonshotai/kimi-k2.6");
    expect(entry?.model).not.toMatch(/nano|11b|8b/i);
  });

  it("can avoid the auditor route when selecting a reviewer if another strong route passes", () => {
    const entry = selectModelForMode("reviewer", "free_nvidia", allPass(), withNvidia, [
      { provider: "nvidia", model: "moonshotai/kimi-k2.6" }
    ]);
    expect(entry?.provider).toBe("nvidia");
    expect(entry?.model).toBe("minimaxai/minimax-m3");
  });

  it("free_nvidia returns undefined when NVIDIA key is absent", () => {
    const entry = selectModelForMode("auditor", "free_nvidia", allPass(), noEnv);
    expect(entry).toBeUndefined();
  });

  it("returns undefined when no probes pass", () => {
    const entry = selectModelForMode("auditor", "free", [], withNvidia);
    expect(entry).toBeUndefined();
  });

  it("paid mode is disabled unless UI_DIFF_ENABLE_PAID_MODE is explicitly set", () => {
    const paidAuditorCandidate = CANONICAL_MODEL_RANKING.find(
      c => c.role === "auditor" && c.paidRoutes && c.paidRoutes.length > 0
    );
    if (!paidAuditorCandidate || !paidAuditorCandidate.paidRoutes) {
      throw new Error("No paid auditor candidate found in CANONICAL_MODEL_RANKING for testing.");
    }
    const paidRoute = paidAuditorCandidate.paidRoutes[0];
    if (!paidRoute) throw new Error("paidRoutes[0] is undefined");
    const probes: ProbeResult[] = [makeProbe(paidRoute.provider, paidRoute.model, "auditor")];
    const entry = selectModelForMode("auditor", "paid", probes, noEnv);
    expect(entry).toBeUndefined();
  });

  it("paid mode selects a paid route only after explicit environment enablement", () => {
    const paidAuditorCandidate = CANONICAL_MODEL_RANKING.find(
      c => c.role === "auditor" && c.paidRoutes && c.paidRoutes.length > 0
    );
    if (!paidAuditorCandidate || !paidAuditorCandidate.paidRoutes) {
      throw new Error("No paid auditor candidate found in CANONICAL_MODEL_RANKING for testing.");
    }
    const paidRoute = paidAuditorCandidate.paidRoutes[0];
    if (!paidRoute) throw new Error("paidRoutes[0] is undefined");
    const probes: ProbeResult[] = [makeProbe(paidRoute.provider, paidRoute.model, "auditor")];
    const entry = selectModelForMode("auditor", "paid", probes, {
      UI_DIFF_ENABLE_PAID_MODE: "1"
    });
    expect(entry).toBeDefined();
    expect(entry?.costClass).toBe("paid");
    expect(entry?.provider).toBe(paidRoute.provider);
    expect(entry?.model).toBe(paidRoute.model);
  });

  it("paid mode returns undefined when no paid routes pass probes", () => {
    const paidAuditorCandidate = CANONICAL_MODEL_RANKING.find(
      c => c.role === "auditor" && c.paidRoutes && c.paidRoutes.length > 0
    );
    if (!paidAuditorCandidate || !paidAuditorCandidate.paidRoutes) {
      throw new Error("No paid auditor candidate found in CANONICAL_MODEL_RANKING for testing.");
    }
    // No probes passing for the paid route
    const probes: ProbeResult[] = [];
    const entry = selectModelForMode("auditor", "paid", probes, noEnv);
    expect(entry).toBeUndefined();
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

describe("selectFallbackModelsForMode", () => {
  const withNvidia: Record<string, string | undefined> = { NVIDIA_API_KEY: "test-key" };
  const noEnv: Record<string, string | undefined> = {};

  it("free mode always appends at least one OpenRouter fallback when all passing probes are NVIDIA", () => {
    // Build probes: only NVIDIA passes for auditor, plus one OpenRouter candidate also passing
    const nvidiaAuditor = CANONICAL_MODEL_RANKING.find(
      c => c.role === "auditor" && c.eligibleFreeProviderRoutes.some(r => r.provider === "nvidia")
    );
    const orAuditor = CANONICAL_MODEL_RANKING.find(
      c => c.role === "auditor" && c.eligibleFreeProviderRoutes.some(r => r.provider === "openrouter")
    );
    if (!nvidiaAuditor || !orAuditor) return;
    const nvidiaRoute = nvidiaAuditor.eligibleFreeProviderRoutes.find(r => r.provider === "nvidia")!;
    const orRoute = orAuditor.eligibleFreeProviderRoutes.find(r => r.provider === "openrouter")!;
    // Only NVIDIA probes pass (OpenRouter also passes to allow diversity guarantee to work)
    const probes = [
      makeProbe(nvidiaRoute.provider, nvidiaRoute.model, "auditor"),
      makeProbe(orRoute.provider, orRoute.model, "auditor")
    ];
    const candidates = selectFallbackModelsForMode("auditor", "free", probes, 1, withNvidia);
    // maxCandidates=1 would give only NVIDIA, but diversity guarantee must append OpenRouter
    expect(candidates.some(c => c.provider === "openrouter")).toBe(true);
    expect(candidates.some(c => c.provider === "nvidia")).toBe(true);
  });

  it("free mode with only NVIDIA probes still provides OpenRouter fallback if any OpenRouter route passes", () => {
    const candidates = selectFallbackModelsForMode("auditor", "free", allPass(), 3, withNvidia);
    // With all probes passing, should include both NVIDIA (preferred) and at least one OpenRouter
    const hasNvidia = candidates.some(c => c.provider === "nvidia");
    const hasOpenRouter = candidates.some(c => c.provider === "openrouter");
    expect(hasNvidia || hasOpenRouter).toBe(true); // at least one route
    if (hasNvidia) {
      // If NVIDIA is present, OpenRouter diversity guarantee must also be present
      expect(hasOpenRouter).toBe(true);
    }
  });

  it("free_nvidia never includes OpenRouter routes", () => {
    const candidates = selectFallbackModelsForMode("auditor", "free_nvidia", allPass(), 3, withNvidia);
    expect(candidates.every(c => c.provider === "nvidia")).toBe(true);
  });

  it("free_openrouter never includes NVIDIA routes", () => {
    const candidates = selectFallbackModelsForMode("auditor", "free_openrouter", allPass(), 3, withNvidia);
    expect(candidates.every(c => c.provider === "openrouter")).toBe(true);
  });

  it("returns multiple distinct candidates up to maxCandidates", () => {
    const candidates = selectFallbackModelsForMode("auditor", "free", allPass(), 3, withNvidia);
    const keys = candidates.map(c => `${c.provider}:${c.model}`);
    expect(new Set(keys).size).toBe(keys.length); // all unique
  });

  it("returns empty array when no probes pass", () => {
    const candidates = selectFallbackModelsForMode("auditor", "free", [], 3, withNvidia);
    expect(candidates).toHaveLength(0);
  });

  it("free mode without NVIDIA key returns only OpenRouter candidates", () => {
    const candidates = selectFallbackModelsForMode("auditor", "free", allPass(), 3, noEnv);
    expect(candidates.every(c => c.provider === "openrouter")).toBe(true);
  });
});

describe("requiredImagesForRole", () => {
  it("auditor and reviewer require 5 images", () => {
    expect(requiredImagesForRole("auditor")).toBe(5);
    expect(requiredImagesForRole("reviewer")).toBe(5);
    expect(requiredImagesForRole("fast_auditor")).toBe(5);
    expect(requiredImagesForRole("escalation")).toBe(5);
  });

  it("target_recovery requires 4 images", () => {
    expect(requiredImagesForRole("target_recovery")).toBe(4);
  });

  it("unknown roles default to 2 images", () => {
    expect(requiredImagesForRole("locator")).toBe(2);
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
