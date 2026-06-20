import { describe, expect, it, vi } from "vitest";
import { runProjectedPreAudit } from "../../src/diff/projected-preaudit.js";
import type { ElementPair, UiElement } from "../../src/schemas/core.js";

vi.mock("../../src/audit/projected-mismatch.js", () => ({
  detectProjectedCropMismatch: vi.fn()
}));

import { detectProjectedCropMismatch } from "../../src/audit/projected-mismatch.js";

function makeRgba(w: number, h: number, fill = 128): { data: Uint8Array; width: number; height: number } {
  return { data: new Uint8Array(w * h * 4).fill(fill), width: w, height: h };
}

function makeExpected(id: string, label = "btn"): UiElement {
  return {
    id, label, type: "button",
    box: { x: 0, y: 0, width: 40, height: 20 },
    normalizedBox: { x: 0, y: 0, width: 0.2, height: 0.1 },
    confidence: 0.9, source: "locator", childIds: []
  };
}

function makeActualProjected(id: string): UiElement {
  return {
    id, label: "btn", type: "button",
    box: { x: 0, y: 0, width: 30, height: 15 },
    normalizedBox: { x: 0, y: 0, width: 0.15, height: 0.075 },
    confidence: 0.9, source: "projected", childIds: []
  };
}

function makePair(id: string, expectedId: string, actualId: string): ElementPair {
  return { id, expectedId, actualId, status: "matched", score: 1.0, reasons: [] };
}

describe("runProjectedPreAudit", () => {
  it("does not consume VLM budget for a definite projected mismatch", async () => {
    (detectProjectedCropMismatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      mismatched: true,
      reason: "changed_pixels",
      changedPercent: 90
    });

    const expectedEl = makeExpected("e1");
    const actualEl = makeActualProjected("a1");
    const pair = makePair("p1", "e1", "a1");

    const result = await runProjectedPreAudit({
      pairs: [pair],
      expectedElements: [expectedEl],
      actualElements: [actualEl],
      expectedRgba: makeRgba(200, 400),
      actualRgba: makeRgba(150, 300, 10)
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]!.classificationSource).toBe("deterministic_projected_mismatch");
    expect(result.skipVlmPairIds.has("p1")).toBe(true);
    expect(result.summary.deterministicProjectedDiffs).toBe(1);
    expect(result.summary.sentToVlmPairs).toBe(0);
    expect(result.summary.projectedPairsChecked).toBe(1);
  });

  it("sends dimension-only projected pairs to VLM instead of creating absence diffs", async () => {
    (detectProjectedCropMismatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      mismatched: false,
      reason: "not_mismatched",
      changedPercent: 5
    });

    const expectedEl = makeExpected("e2");
    const actualEl = makeActualProjected("a2");
    const pair = makePair("p2", "e2", "a2");

    const result = await runProjectedPreAudit({
      pairs: [pair],
      expectedElements: [expectedEl],
      actualElements: [actualEl],
      expectedRgba: makeRgba(200, 400),
      actualRgba: makeRgba(150, 300, 200)
    });

    expect(result.diffs).toHaveLength(0);
    expect(result.skipVlmPairIds.has("p2")).toBe(false);
    expect(result.summary.sentToVlmPairs).toBe(1);
    expect(result.summary.deterministicProjectedDiffs).toBe(0);
  });
});
