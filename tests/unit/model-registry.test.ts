import { describe, expect, it } from "vitest";
import { CANONICAL_MODEL_RANKING, getModelByRole, getRequiredModels, selectModelForMode, selectFallbackModelsForMode, resolveMode, requiredImagesForRole, modelFamilyKey, candidateSupportsLogicalRole } from "../../src/models/model-registry.js";
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

describe("modelFamilyKey", () => {
  it("strips :free suffix", () => {
    expect(modelFamilyKey("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"))
      .toBe("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
    expect(modelFamilyKey("nex-agi/nex-n2-pro:free")).toBe("nex-agi/nex-n2-pro");
    expect(modelFamilyKey("google/gemma-4-31b-it:free")).toBe("google/gemma-4-31b-it");
  });

  it("strips dated permaslug suffix", () => {
    expect(modelFamilyKey("moonshotai/kimi-k2.6:20250120")).toBe("moonshotai/kimi-k2.6");
  });

  it("strips :beta, :nitro, :extended, :floor suffixes", () => {
    expect(modelFamilyKey("some/model:beta")).toBe("some/model");
    expect(modelFamilyKey("some/model:nitro")).toBe("some/model");
    expect(modelFamilyKey("some/model:extended")).toBe("some/model");
    expect(modelFamilyKey("some/model:floor")).toBe("some/model");
  });

  it("returns model unchanged when no suffix to strip", () => {
    expect(modelFamilyKey("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"))
      .toBe("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning");
    expect(modelFamilyKey("moonshotai/kimi-k2.6")).toBe("moonshotai/kimi-k2.6");
    expect(modelFamilyKey("qwen/qwen3.5-397b-a17b")).toBe("qwen/qwen3.5-397b-a17b");
  });

  it("native NVIDIA and OpenRouter :free copy of the same model share a family key", () => {
    const native = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
    const orFree = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
    expect(modelFamilyKey(native)).toBe(modelFamilyKey(orFree));
  });
});

describe("selectFallbackModelsForMode — route diversity", () => {
  const withNvidia: Record<string, string | undefined> = { NVIDIA_API_KEY: "test-key" };
  const noEnv: Record<string, string | undefined> = {};

  it("free mode: NVIDIA primary routes come before OpenRouter routes in the list", () => {
    const probes: ProbeResult[] = [
      makeProbe("nvidia", "qwen/qwen3.5-397b-a17b", "auditor"),
      makeProbe("openrouter", "nex-agi/nex-n2-pro:free", "auditor"),
    ];
    const candidates = selectFallbackModelsForMode("auditor", "free", probes, 3, withNvidia);
    const firstOrIdx = candidates.findIndex(c => c.provider === "openrouter");
    const lastNvidiaIdx = Math.max(...candidates.map((c, i) => c.provider === "nvidia" ? i : -1));
    expect(firstOrIdx).toBeGreaterThan(lastNvidiaIdx);
  });

  it("free mode: multiple passing different-family OpenRouter routes are all returned", () => {
    const probes: ProbeResult[] = [
      makeProbe("nvidia", "qwen/qwen3.5-397b-a17b", "auditor"),
      makeProbe("openrouter", "nex-agi/nex-n2-pro:free", "auditor"),
      makeProbe("openrouter", "google/gemma-4-31b-it:free", "auditor"),
    ];
    const candidates = selectFallbackModelsForMode("auditor", "free", probes, 3, withNvidia);
    const orModels = candidates.filter(c => c.provider === "openrouter").map(c => c.model);
    expect(orModels).toContain("nex-agi/nex-n2-pro:free");
    expect(orModels).toContain("google/gemma-4-31b-it:free");
  });

  it("free mode: same-family OpenRouter Nemotron is skipped when different-family alternatives pass", () => {
    const probes: ProbeResult[] = [
      makeProbe("nvidia", "qwen/qwen3.5-397b-a17b", "auditor"),
      makeProbe("nvidia", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "auditor"),
      // same-family as native nemotron:
      makeProbe("openrouter", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "auditor"),
      // different-family alternatives:
      makeProbe("openrouter", "nex-agi/nex-n2-pro:free", "auditor"),
      makeProbe("openrouter", "google/gemma-4-31b-it:free", "auditor"),
    ];
    const candidates = selectFallbackModelsForMode("auditor", "free", probes, 3, withNvidia);
    const orModels = candidates.filter(c => c.provider === "openrouter").map(c => c.model);
    // Same-family Nemotron:free must NOT appear when different-family alternatives exist
    expect(orModels).not.toContain("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free");
    // Different-family routes must be chosen instead
    expect(orModels.length).toBeGreaterThan(0);
    expect(orModels.some(m => m.includes("nex") || m.includes("gemma"))).toBe(true);
  });

  it("free mode: same-family OpenRouter Nemotron is used when it is the only passing OpenRouter route", () => {
    const probes: ProbeResult[] = [
      makeProbe("nvidia", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "auditor"),
      makeProbe("openrouter", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "auditor"),
    ];
    const candidates = selectFallbackModelsForMode("auditor", "free", probes, 3, withNvidia);
    const orModels = candidates.filter(c => c.provider === "openrouter").map(c => c.model);
    // Only same-family option — must still be included as last-resort fallback
    expect(orModels).toContain("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free");
  });

  it("free_nvidia contains no OpenRouter route even when all probes pass", () => {
    const candidates = selectFallbackModelsForMode("auditor", "free_nvidia", allPass(), 3, withNvidia);
    expect(candidates.every(c => c.provider === "nvidia")).toBe(true);
  });

  it("free_openrouter contains no NVIDIA route even when all probes pass", () => {
    const candidates = selectFallbackModelsForMode("auditor", "free_openrouter", allPass(), 3, withNvidia);
    expect(candidates.every(c => c.provider === "openrouter")).toBe(true);
  });

  it("free mode without NVIDIA key selects only OpenRouter routes, all treated as different-family", () => {
    const candidates = selectFallbackModelsForMode("auditor", "free", allPass(), 3, noEnv);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every(c => c.provider === "openrouter")).toBe(true);
  });
});

describe("candidateSupportsLogicalRole", () => {
  it("returns true when candidate.role matches logicalRole", () => {
    const c = CANONICAL_MODEL_RANKING.find(c => c.role === "auditor")!;
    expect(candidateSupportsLogicalRole(c, "auditor")).toBe(true);
  });

  it("returns true for target_recovery when capabilities allow it and maxImages>=4", () => {
    const c = CANONICAL_MODEL_RANKING.find(c => c.role === "auditor" && c.capabilities?.allowedRoles.includes("target_recovery"))!;
    expect(c).toBeDefined();
    expect(candidateSupportsLogicalRole(c, "target_recovery")).toBe(true);
  });

  it("returns false for target_recovery on single-image Llama entries", () => {
    const llama = CANONICAL_MODEL_RANKING.find(c => c.model.includes("llama-3.2") && c.capabilities?.maxImages === 1)!;
    expect(llama).toBeDefined();
    expect(candidateSupportsLogicalRole(llama, "target_recovery")).toBe(false);
  });

  it("returns false when capabilities are absent", () => {
    const bare = { role: "auditor" as const };
    expect(candidateSupportsLogicalRole(bare as never, "target_recovery")).toBe(false);
  });
});

describe("strong auditor routes eligible for target recovery", () => {
  const withNvidia: Record<string, string | undefined> = { NVIDIA_API_KEY: "test-key" };

  it("kimi-k2.6 auditor with passing target_recovery probe is returned for selectFallbackModelsForMode target_recovery free", () => {
    const probes: ProbeResult[] = [
      makeProbe("nvidia", "moonshotai/kimi-k2.6", "target_recovery", "pass", 4)
    ];
    const candidates = selectFallbackModelsForMode("target_recovery", "free", probes, 3, withNvidia);
    expect(candidates.some(c => c.model === "moonshotai/kimi-k2.6")).toBe(true);
  });

  it("qwen3.5-397b auditor with passing target_recovery probe is returned for target_recovery", () => {
    const probes: ProbeResult[] = [
      makeProbe("nvidia", "qwen/qwen3.5-397b-a17b", "target_recovery", "pass", 4)
    ];
    const candidates = selectFallbackModelsForMode("target_recovery", "free", probes, 3, withNvidia);
    expect(candidates.some(c => c.model === "qwen/qwen3.5-397b-a17b")).toBe(true);
  });

  it("single-image llama reviewer is NOT returned for target_recovery even if probe passes", () => {
    const probes: ProbeResult[] = [
      makeProbe("nvidia", "meta/llama-3.2-90b-vision-instruct", "target_recovery", "pass", 4),
      makeProbe("nvidia", "moonshotai/kimi-k2.6", "target_recovery", "pass", 4)
    ];
    const candidates = selectFallbackModelsForMode("target_recovery", "free", probes, 3, withNvidia);
    expect(candidates.every(c => c.model !== "meta/llama-3.2-90b-vision-instruct")).toBe(true);
  });

  it("candidate with auditor-only probe pass but no target_recovery probe is not returned for target_recovery", () => {
    const probes: ProbeResult[] = [
      makeProbe("nvidia", "moonshotai/kimi-k2.6", "auditor", "pass", 5)
      // no target_recovery probe
    ];
    const candidates = selectFallbackModelsForMode("target_recovery", "free", probes, 3, withNvidia);
    expect(candidates.every(c => c.model !== "moonshotai/kimi-k2.6")).toBe(true);
  });

  it("free mode: NVIDIA target_recovery candidates come before OpenRouter in the result list", () => {
    const probes: ProbeResult[] = [
      makeProbe("nvidia", "moonshotai/kimi-k2.6", "target_recovery", "pass", 4),
      makeProbe("openrouter", "nex-agi/nex-n2-pro:free", "target_recovery", "pass", 4)
    ];
    const candidates = selectFallbackModelsForMode("target_recovery", "free", probes, 3, withNvidia);
    const nvidiaIdx = candidates.findIndex(c => c.provider === "nvidia");
    const orIdx = candidates.findIndex(c => c.provider === "openrouter");
    if (nvidiaIdx >= 0 && orIdx >= 0) {
      expect(nvidiaIdx).toBeLessThan(orIdx);
    }
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
