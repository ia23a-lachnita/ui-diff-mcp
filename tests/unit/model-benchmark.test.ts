import { describe, expect, it } from "vitest";
import { CANONICAL_MODEL_RANKING } from "../../src/models/model-registry.js";

describe("benchmark script prerequisites", () => {
  it("every candidate has at least one eligible free route to benchmark", () => {
    for (const c of CANONICAL_MODEL_RANKING) {
      expect(c.eligibleFreeProviderRoutes.length).toBeGreaterThan(0);
    }
  });

  it("eligible free routes have provider and non-empty model id", () => {
    for (const c of CANONICAL_MODEL_RANKING) {
      for (const route of c.eligibleFreeProviderRoutes) {
        expect(route.provider).toMatch(/^(opencode|openrouter|nvidia)$/);
        expect(route.model.length).toBeGreaterThan(0);
      }
    }
  });

  it("openrouter free routes end with :free suffix", () => {
    for (const c of CANONICAL_MODEL_RANKING) {
      for (const route of c.eligibleFreeProviderRoutes) {
        if (route.provider === "openrouter") {
          expect(route.model).toMatch(/:free$/);
        }
      }
    }
  });

  it("paid routes do not have :free suffix", () => {
    for (const c of CANONICAL_MODEL_RANKING) {
      for (const route of c.paidRoutes ?? []) {
        expect(route.model).not.toMatch(/:free$/);
      }
    }
  });
});
