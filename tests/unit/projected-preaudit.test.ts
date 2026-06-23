import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runProjectedPreAudit } from "../../src/diff/projected-preaudit.js";
import type { ElementPair, UiElement } from "../../src/schemas/core.js";

vi.mock("../../src/audit/projected-mismatch.js", () => ({
  detectProjectedCropMismatch: vi.fn()
}));

vi.mock("../../src/diff/displacement-search.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/diff/displacement-search.js")>();
  return {
    ...actual,
    buildDisplacementSearchIndex: vi.fn(() => ({ width: 150, height: 300, edgeMap: new Uint8Array(), edgeProximityMap: new Uint8Array(), colorMap: new Uint16Array() })),
    searchDisplacementCandidates: vi.fn()
  };
});

import { detectProjectedCropMismatch } from "../../src/audit/projected-mismatch.js";
import { searchDisplacementCandidates } from "../../src/diff/displacement-search.js";

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
    (searchDisplacementCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "projected-preaudit-"));

    const expectedEl = makeExpected("e1");
    const actualEl = makeActualProjected("a1");
    const pair = makePair("p1", "e1", "a1");

    const result = await runProjectedPreAudit({
      pairs: [pair],
      expectedElements: [expectedEl],
      actualElements: [actualEl],
      expectedRgba: makeRgba(200, 400),
      actualRgba: makeRgba(150, 300, 10),
      artifactDir
    });

    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]!.classificationSource).toBe("deterministic_projected_mismatch");
    expect(result.diffs[0]!.reviewerStatus).toBe("not_reviewed");
    expect(result.skipVlmPairIds.has("p1")).toBe(true);
    expect(result.summary.deterministicProjectedDiffs).toBe(1);
    expect(result.summary.sentToVlmPairs).toBe(0);
    expect(result.summary.projectedPairsChecked).toBe(1);
    expect(result.diffs[0]?.criterion).toBe("presence");
    expect(result.diffs[0]?.projectionMismatchKind).toBe("absent_at_location");
    expect(result.diffs[0]?.artifactPaths).toHaveLength(4);
    await Promise.all(result.diffs[0]!.artifactPaths.map(artifact => fs.access(artifact.path)));
  });

  it("accounting: deterministicProjectedDiffs + sentToVlmPairs equals projectedPairsChecked", async () => {
    // This directly validates the numbers that flow into report.auditScope.vlmAuditedPairs and
    // report.auditScope.preAuditDeterministicPairs. One pair is a definite mismatch (consumed
    // by pre-audit), two are clear matches (forwarded to VLM).
    (detectProjectedCropMismatch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ mismatched: true, reason: "changed_pixels", changedPercent: 85 })
      .mockResolvedValueOnce({ mismatched: false, reason: "not_mismatched", changedPercent: 3 })
      .mockResolvedValueOnce({ mismatched: false, reason: "not_mismatched", changedPercent: 1 });
    (searchDisplacementCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const pairs = [
      makePair("p10", "e10", "a10"),
      makePair("p11", "e11", "a11"),
      makePair("p12", "e12", "a12"),
    ];
    const expectedEls = [makeExpected("e10"), makeExpected("e11"), makeExpected("e12")];
    const actualEls = [makeActualProjected("a10"), makeActualProjected("a11"), makeActualProjected("a12")];

    const result = await runProjectedPreAudit({
      pairs,
      expectedElements: expectedEls,
      actualElements: actualEls,
      expectedRgba: makeRgba(200, 400),
      actualRgba: makeRgba(150, 300, 10),
      artifactDir: os.tmpdir()
    });

    expect(result.summary.projectedPairsChecked).toBe(3);
    expect(result.summary.deterministicProjectedDiffs).toBe(1);
    expect(result.summary.sentToVlmPairs).toBe(2);
    expect(result.summary.deterministicProjectedDiffs + result.summary.sentToVlmPairs)
      .toBe(result.summary.projectedPairsChecked);
    expect(result.diffs).toHaveLength(1);
    expect(result.skipVlmPairIds.size).toBe(1);
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
      actualRgba: makeRgba(150, 300, 200),
      artifactDir: os.tmpdir()
    });

    expect(result.diffs).toHaveLength(0);
    expect(result.skipVlmPairIds.has("p2")).toBe(false);
    expect(result.summary.sentToVlmPairs).toBe(1);
    expect(result.summary.deterministicProjectedDiffs).toBe(0);
  });

  it("classifies a deterministic translation as geometry", async () => {
    (detectProjectedCropMismatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      mismatched: true,
      reason: "projected_crop_low_overlap",
      changedPercent: 80
    });
    (searchDisplacementCandidates as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{
      dx: 4,
      dy: -2,
      score: 0.9,
      edgeOverlap: 0.88,
      colorAgreement: 0.8,
      improvement: 0.3,
      runnerUpMargin: 0.2
    }]);
    const result = await runProjectedPreAudit({
      pairs: [makePair("p-shift", "e-shift", "a-shift")],
      expectedElements: [makeExpected("e-shift")],
      actualElements: [makeActualProjected("a-shift")],
      expectedRgba: makeRgba(200, 400),
      actualRgba: makeRgba(150, 300, 10),
      artifactDir: await fs.mkdtemp(path.join(os.tmpdir(), "projected-shift-"))
    });

    expect(result.diffs[0]).toMatchObject({ criterion: "geometry", projectionMismatchKind: "displaced" });
    expect(result.diffs[0]?.measurements).toEqual(expect.arrayContaining([
      { name: "horizontal_shift", value: 4, unit: "px" },
      { name: "vertical_shift", value: -2, unit: "px" }
    ]));
  });

  it("assigns coherent large translations one shared group and group artifacts", async () => {
    (detectProjectedCropMismatch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ mismatched: true, reason: "projected_crop_low_overlap", changedPercent: 90 })
      .mockResolvedValueOnce({ mismatched: true, reason: "projected_crop_low_overlap", changedPercent: 88 });
    const ambiguousCandidate = (dy: number) => [{
      dx: 2,
      dy,
      score: 0.9,
      edgeOverlap: 0.85,
      colorAgreement: 0.8,
      improvement: 0.3,
      runnerUpMargin: 0.02
    }];
    (searchDisplacementCandidates as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ambiguousCandidate(140))
      .mockResolvedValueOnce(ambiguousCandidate(142));

    const parent = makeExpected("parent", "cv-component-0");
    parent.source = "merged";
    parent.type = "text";
    parent.box = { x: 0, y: 0, width: 120, height: 200 };
    const first = makeExpected("e-first", "cv-component-31");
    first.parentId = parent.id;
    first.box = { x: 10, y: 20, width: 40, height: 20 };
    const second = makeExpected("e-second", "cv-component-32");
    second.parentId = parent.id;
    second.box = { x: 10, y: 80, width: 40, height: 20 };
    parent.childIds = [first.id, second.id];
    const actualFirst = makeActualProjected("a-first");
    actualFirst.box = { x: 8, y: 18, width: 30, height: 15 };
    const actualSecond = makeActualProjected("a-second");
    actualSecond.box = { x: 8, y: 72, width: 30, height: 15 };
    const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "projected-group-"));

    const result = await runProjectedPreAudit({
      pairs: [makePair("p-first", first.id, actualFirst.id), makePair("p-second", second.id, actualSecond.id)],
      expectedElements: [parent, first, second],
      actualElements: [actualFirst, actualSecond],
      expectedRgba: makeRgba(200, 400),
      actualRgba: makeRgba(150, 300, 10),
      artifactDir
    });

    expect(result.diffs).toHaveLength(2);
    expect(result.diffs[0]?.findingGroupId).toBeTruthy();
    expect(result.diffs[1]?.findingGroupId).toBe(result.diffs[0]?.findingGroupId);
    expect(result.diffs.every(diff => diff.criterion === "geometry")).toBe(true);
    expect(result.summary.displacementGroups).toBe(1);
    expect(result.summary.groupedPairs).toBe(2);
    for (const diff of result.diffs) {
      expect(diff.artifactPaths.map(artifact => artifact.role)).toEqual(expect.arrayContaining([
        "projected_expected_crop",
        "projected_actual_crop",
        "projected_directional_overlay",
        "projected_pixel_diff_mask",
        "projected_group_expected_crop",
        "projected_group_actual_crop",
        "projected_group_directional_overlay",
        "projected_group_pixel_diff_mask"
      ]));
    }
  });

  it("consolidates non-coherent child mismatches as one structural region mismatch", async () => {
    (detectProjectedCropMismatch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ mismatched: true, reason: "projected_crop_low_overlap", changedPercent: 90 })
      .mockResolvedValueOnce({ mismatched: true, reason: "projected_crop_low_overlap", changedPercent: 85 })
      .mockResolvedValueOnce({ mismatched: true, reason: "projected_crop_low_overlap", changedPercent: 80 });
    (searchDisplacementCandidates as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const parent = makeExpected("structural-parent", "cv-component-0");
    parent.source = "merged";
    parent.type = "text";
    parent.box = { x: 0, y: 0, width: 120, height: 240 };
    const expected = [0, 1, 2].map(index => {
      const item = makeExpected(`structural-e-${index}`, `cv-component-${index + 30}`);
      item.parentId = parent.id;
      item.box = { x: 10, y: 20 + index * 55, width: 40, height: 20 };
      return item;
    });
    parent.childIds = expected.map(item => item.id);
    const actual = expected.map((_, index) => {
      const item = makeActualProjected(`structural-a-${index}`);
      item.box = { x: 8, y: 18 + index * 50, width: 30, height: 15 };
      return item;
    });
    const result = await runProjectedPreAudit({
      pairs: expected.map((item, index) => makePair(`structural-p-${index}`, item.id, actual[index]!.id)),
      expectedElements: [parent, ...expected],
      actualElements: actual,
      expectedRgba: makeRgba(200, 400),
      actualRgba: makeRgba(150, 600, 10),
      artifactDir: await fs.mkdtemp(path.join(os.tmpdir(), "projected-structural-"))
    });

    expect(new Set(result.diffs.map(diff => diff.findingGroupId)).size).toBe(1);
    expect(result.diffs.every(diff => diff.findingGroupKind === "structural_region_mismatch")).toBe(true);
    expect(result.diffs.every(diff => diff.criterion === "geometry" && diff.projectionMismatchKind === "region_mismatch")).toBe(true);
    expect(result.summary.structuralMismatchGroups).toBe(1);
    expect(result.summary.groupedPairs).toBe(3);
  });
});
