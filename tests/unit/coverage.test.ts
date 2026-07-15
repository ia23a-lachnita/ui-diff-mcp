import { describe, expect, it } from "vitest";
import { findUncoveredComponents, assignDiffComponentsToRecords, traceCoverageDecisions } from "../../src/report/coverage.js";
import { clusterUncoveredComponents } from "../../src/report/component-clustering.js";
import { buildRegionLedger, unresolvedRegionsFromLedger } from "../../src/report/region-ledger.js";
import { applyBroadEvidenceFragmentDeferrals, applyResidualFragmentDecisions, classifyBroadEvidenceFragmentDeferrals, classifyResidualFragments } from "../../src/report/residual-fragments.js";
import { UnresolvedRegionsPartSchema } from "../../src/report/report-parts.js";
import type { PixelComponent } from "../../src/signals/pixel-diff.js";
import type { DiffRecord } from "../../src/schemas/core.js";

function makeComponent(x: number, y: number, w: number, h: number, pixelCount = 200): PixelComponent {
  return { box: { x, y, width: w, height: h }, pixelCount };
}

function makeDiff(x: number, y: number, w: number, h: number): DiffRecord {
  return {
    id: `diff-${x}-${y}`,
    criterion: "geometry",
    severity: "medium",
    title: "Test diff",
    location: { x, y, width: w, height: h },
    evidence: ["test evidence"],
    measurements: [],
    artifactPaths: [],
    reviewerStatus: "accepted"
  };
}

describe("findUncoveredComponents", () => {
  it("returns all components when no diffs exist", () => {
    const components = [makeComponent(0, 0, 50, 50), makeComponent(100, 100, 50, 50)];
    const uncovered = findUncoveredComponents(components, [], 10);
    expect(uncovered).toHaveLength(2);
  });

  it("excludes components below minArea threshold", () => {
    const components = [makeComponent(0, 0, 50, 50, 5)]; // pixelCount < minArea
    const uncovered = findUncoveredComponents(components, [], 10);
    expect(uncovered).toHaveLength(0);
  });

  it("excludes components that overlap accepted diffs", () => {
    const components = [makeComponent(10, 10, 80, 60)];
    const diffs = [makeDiff(10, 10, 80, 60)];
    const uncovered = findUncoveredComponents(components, diffs, 10);
    expect(uncovered).toHaveLength(0);
  });

  it("includes components that do not overlap any diff", () => {
    const components = [makeComponent(0, 0, 50, 50), makeComponent(100, 100, 50, 50)];
    const diffs = [makeDiff(0, 0, 50, 50)]; // only covers first component
    const uncovered = findUncoveredComponents(components, diffs, 10);
    expect(uncovered).toHaveLength(1);
    expect(uncovered[0]?.box).toMatchObject({ x: 100, y: 100 });
  });

  it("includes component with insufficient overlap (< 10%)", () => {
    // component at (0,0,100,100) = 10000 area
    // diff at (90,90,50,50) — overlap is (90,90,10,10) = 100 area → 1% of component
    const components = [makeComponent(0, 0, 100, 100)];
    const diffs = [makeDiff(90, 90, 50, 50)];
    const uncovered = findUncoveredComponents(components, diffs, 10);
    expect(uncovered).toHaveLength(1);
  });
});

describe("traceCoverageDecisions", () => {
  it("traces covered component with covering diff id and overlap ratio", () => {
    const components = [makeComponent(0, 0, 100, 100, 900)];
    const diffs = [makeDiff(0, 0, 50, 100)];
    const trace = traceCoverageDecisions(components, diffs, 10);
    expect(trace[0]).toMatchObject({
      status: "covered_by_diff",
      coveringDiffId: diffs[0]!.id,
      coveringCriterion: "geometry",
      overlapRatio: 0.5
    });
  });

  it("traces below-threshold components instead of silently losing them", () => {
    const trace = traceCoverageDecisions([makeComponent(0, 0, 5, 5, 5)], [], 10);
    expect(trace[0]?.status).toBe("below_threshold");
  });

  it("traces uncovered component with no covering diff", () => {
    const components = [makeComponent(0, 0, 50, 50, 200)];
    const trace = traceCoverageDecisions(components, [], 10);
    expect(trace[0]?.status).toBe("uncovered");
    expect(trace[0]?.componentId).toBe("component-0001");
  });

  it("assigns stable sequential componentIds", () => {
    const components = [makeComponent(0, 0, 10, 10), makeComponent(20, 0, 10, 10), makeComponent(40, 0, 10, 10)];
    const trace = traceCoverageDecisions(components, [], 10);
    expect(trace.map(t => t.componentId)).toEqual(["component-0001", "component-0002", "component-0003"]);
  });

  it("uses shape-local coverage boxes instead of a displacement corridor", () => {
    const diff = makeDiff(0, 0, 20, 120);
    diff.coverageLocations = [
      { x: 0, y: 0, width: 20, height: 20 },
      { x: 0, y: 100, width: 20, height: 20 }
    ];
    const trace = traceCoverageDecisions([
      makeComponent(2, 2, 10, 10),
      makeComponent(2, 52, 10, 10),
      makeComponent(2, 102, 10, 10)
    ], [diff], 10);

    expect(trace.map(decision => decision.status)).toEqual([
      "covered_by_diff",
      "uncovered",
      "covered_by_diff"
    ]);
  });
});

describe("assignDiffComponentsToRecords", () => {
  it("adds unclassified records for uncovered components", () => {
    const components = [makeComponent(0, 0, 50, 50)];
    const result = assignDiffComponentsToRecords(components, [], 10, "/fake/diff.png");
    expect(result).toHaveLength(1);
    expect(result[0]?.criterion).toBe("unclassified_visual_change");
  });

  it("preserves existing diffs", () => {
    const diffs = [makeDiff(0, 0, 50, 50)];
    const result = assignDiffComponentsToRecords([], diffs, 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("diff-0-0");
  });

  it("does not add unclassified record for covered component", () => {
    const components = [makeComponent(10, 10, 80, 60)];
    const diffs = [makeDiff(10, 10, 80, 60)];
    const result = assignDiffComponentsToRecords(components, diffs, 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.criterion).toBe("geometry");
  });

  it("sets reviewerStatus to not_reviewed for unclassified records", () => {
    const components = [makeComponent(0, 0, 50, 50)];
    const result = assignDiffComponentsToRecords(components, [], 10);
    expect(result[0]?.reviewerStatus).toBe("not_reviewed");
  });
});

describe("clusterUncoveredComponents", () => {
  it("returns empty array for empty input", () => {
    expect(clusterUncoveredComponents([], { maxGapPx: 10, maxClusterAreaRatio: 0.5, imageWidth: 1000, imageHeight: 2000 })).toHaveLength(0);
  });

  it("does not merge components far apart", () => {
    const a = { box: { x: 0, y: 0, width: 10, height: 10 }, pixelCount: 100 };
    const b = { box: { x: 200, y: 200, width: 10, height: 10 }, pixelCount: 100 };
    const result = clusterUncoveredComponents([a, b], { maxGapPx: 5, maxClusterAreaRatio: 0.5, imageWidth: 1000, imageHeight: 1000 });
    expect(result).toHaveLength(2);
  });

  it("merges adjacent components within gap threshold", () => {
    const components = Array.from({ length: 5 }, (_, i) => ({
      box: { x: i * 12, y: 0, width: 10, height: 10 },
      pixelCount: 50
    }));
    const result = clusterUncoveredComponents(components, { maxGapPx: 5, maxClusterAreaRatio: 0.9, imageWidth: 1000, imageHeight: 1000 });
    expect(result.length).toBeLessThan(components.length);
    const totalPixels = result.reduce((s, c) => s + c.pixelCount, 0);
    expect(totalPixels).toBe(250);
  });

  it("reduces 30 tiny adjacent components to fewer than 5 clusters", () => {
    const components = Array.from({ length: 30 }, (_, i) => ({
      box: { x: i * 5, y: 0, width: 4, height: 4 },
      pixelCount: 10
    }));
    const result = clusterUncoveredComponents(components, { maxGapPx: 3, maxClusterAreaRatio: 0.9, imageWidth: 1000, imageHeight: 1000 });
    expect(result.length).toBeLessThan(5);
    const totalPixels = result.reduce((s, c) => s + c.pixelCount, 0);
    expect(totalPixels).toBe(300);
  });

  it("does not merge when merged area exceeds maxClusterAreaRatio", () => {
    // Two components far enough apart that their merged bounding box is huge
    const a = { box: { x: 0, y: 0, width: 100, height: 100 }, pixelCount: 100 };
    const b = { box: { x: 110, y: 0, width: 100, height: 100 }, pixelCount: 100 };
    // imageWidth=210, imageHeight=100 → screenArea=21000; merged 210x100=21000 → ratio=1.0 ≥ 0.5, not merged
    const result = clusterUncoveredComponents([a, b], { maxGapPx: 20, maxClusterAreaRatio: 0.5, imageWidth: 210, imageHeight: 100 });
    expect(result).toHaveLength(2);
  });
});

describe("buildRegionLedger", () => {
  it("clusters raw child components once and emits only canonical unresolved regions", () => {
    const components = [
      makeComponent(0, 0, 10, 10, 80),
      makeComponent(12, 0, 10, 10, 90),
      makeComponent(100, 100, 10, 10, 70),
      makeComponent(112, 100, 10, 10, 60),
      makeComponent(180, 180, 2, 2, 4)
    ];

    const ledger = buildRegionLedger(components, [], {
      minPixelCount: 10,
      maxGapPx: 5,
      maxClusterAreaRatio: 0.5,
      imageWidth: 200,
      imageHeight: 200
    });

    expect(ledger.rawComponentCount).toBe(5);
    expect(ledger.belowThresholdCount).toBe(1);
    expect(ledger.regions).toHaveLength(2);
    expect(ledger.regions.map(region => region.sourceComponentIds.length)).toEqual([2, 2]);
    expect(unresolvedRegionsFromLedger(ledger, "not_classified")).toHaveLength(2);
  });
});

describe("unresolvedRegionsFromLedger", () => {
  it("caps emitted long details without changing their classification", () => {
    const ledger = buildRegionLedger([
      makeComponent(0, 0, 10, 10, 100),
      makeComponent(100, 0, 10, 10, 100)
    ], [], {
      minPixelCount: 1,
      maxGapPx: 5,
      maxClusterAreaRatio: 0.5,
      imageWidth: 200,
      imageHeight: 200
    });
    const broadDetail = `broad_vlm_evidence: ${"finding,".repeat(40)}`;
    const recoveryDetail = `recovery evidence: ${"reviewed-region,".repeat(30)}`;
    ledger.regions[0]!.unresolvedDetail = broadDetail;
    ledger.regions[0]!.coveringFindingIds = ["finding-a", "finding-b"];
    ledger.regions[1]!.unresolvedDetail = recoveryDetail;

    const unresolved = unresolvedRegionsFromLedger(ledger, "recovery_route_exhausted");

    expect(unresolved[0]).toMatchObject({
      reason: "broad_vlm_evidence",
      relatedFindingIds: ["finding-a", "finding-b"]
    });
    expect(unresolved[1]).toMatchObject({ reason: "recovery_route_exhausted" });
    expect(unresolved[0]?.detail).toHaveLength(200);
    expect(unresolved[1]?.detail).toHaveLength(200);
    expect(unresolved[0]?.detail).toBe(`${broadDetail.slice(0, 185)}... [truncated]`);
    expect(unresolved[1]?.detail).toBe(`${recoveryDetail.slice(0, 185)}... [truncated]`);
    expect(() => UnresolvedRegionsPartSchema.parse({ unresolvedRegions: unresolved })).not.toThrow();
  });

  it("leaves unresolved detail at or below the report limit unchanged", () => {
    const ledger = buildRegionLedger([
      makeComponent(0, 0, 10, 10, 100),
      makeComponent(100, 0, 10, 10, 100)
    ], [], {
      minPixelCount: 1,
      maxGapPx: 5,
      maxClusterAreaRatio: 0.5,
      imageWidth: 200,
      imageHeight: 200
    });
    const underLimitDetail = "broad_vlm_evidence: accepted evidence";
    const atLimitDetail = "r".repeat(200);
    ledger.regions[0]!.unresolvedDetail = underLimitDetail;
    ledger.regions[1]!.unresolvedDetail = atLimitDetail;

    const unresolved = unresolvedRegionsFromLedger(ledger, "recovery_route_exhausted");

    expect(unresolved.map(region => region.detail)).toEqual([underLimitDetail, atLimitDetail]);
    expect(unresolved[0]?.reason).toBe("broad_vlm_evidence");
    expect(unresolved[1]?.reason).toBe("recovery_route_exhausted");
    expect(() => UnresolvedRegionsPartSchema.parse({ unresolvedRegions: unresolved })).not.toThrow();
  });
});

describe("residual fragment classification", () => {
  it("defers a thin fragment supported only by broad evidence without hiding its pixels", () => {
    const ledger = buildRegionLedger([makeComponent(544, 2241, 3, 28, 80)], [], {
      minPixelCount: 50,
      maxGapPx: 12,
      maxClusterAreaRatio: 0.5,
      imageWidth: 1200,
      imageHeight: 2600
    });
    const broadFinding = {
      ...makeDiff(0, 0, 1200, 2600),
      id: "broad-screen-evidence",
      classificationSource: "vlm_reviewed" as const,
      reviewerStatus: "accepted" as const
    };
    const options = {
      maxDistancePx: 24,
      maxResidualPixels: 120,
      maxThinSidePx: 4,
      minAreaMultiplier: 8
    };

    const decisions = classifyBroadEvidenceFragmentDeferrals(ledger.regions, [broadFinding], options);
    applyBroadEvidenceFragmentDeferrals(ledger, decisions);

    expect(decisions).toHaveLength(1);
    expect(ledger.regions[0]).toMatchObject({
      state: "unresolved",
      pixelCount: 80,
      sourceComponentIds: ["component-0001"],
      recoveryDeferredReason: "deferred_broad_evidence_fragment",
      coveringFindingIds: ["broad-screen-evidence"]
    });
    expect(unresolvedRegionsFromLedger(ledger, "not_classified")).toContainEqual(expect.objectContaining({
      reason: "deferred_broad_evidence_fragment",
      pixelCount: 80,
      sourceComponentIds: ["component-0001"]
    }));
  });

  it("does not defer a substantial residual region merely because broad evidence overlaps it", () => {
    const ledger = buildRegionLedger([makeComponent(100, 100, 80, 60, 1000)], [], {
      minPixelCount: 50,
      maxGapPx: 12,
      maxClusterAreaRatio: 0.5,
      imageWidth: 1200,
      imageHeight: 2600
    });
    const broadFinding = {
      ...makeDiff(0, 0, 1200, 2600),
      id: "broad-screen-evidence",
      classificationSource: "vlm_reviewed" as const,
      reviewerStatus: "accepted" as const
    };

    expect(classifyBroadEvidenceFragmentDeferrals(ledger.regions, [broadFinding], {
      maxDistancePx: 24,
      maxResidualPixels: 120,
      maxThinSidePx: 4,
      minAreaMultiplier: 8
    })).toEqual([]);
  });

  it("selects equal-area residual candidates by stable ID under permutations", () => {
    const ledger = buildRegionLedger([makeComponent(10, 10, 2, 20, 40)], [], {
      minPixelCount: 1,
      maxGapPx: 12,
      maxClusterAreaRatio: 0.5,
      imageWidth: 200,
      imageHeight: 200
    });
    const aFinding = { ...makeDiff(0, 0, 100, 100), id: "a-finding" };
    const zFinding = { ...makeDiff(0, 0, 100, 100), id: "z-finding" };
    const options = {
      maxDistancePx: 24,
      maxResidualPixels: 120,
      maxThinSidePx: 4,
      minAreaMultiplier: 8
    };

    const selectedId = (findings: DiffRecord[]) =>
      classifyResidualFragments(ledger.regions, findings, options)[0]?.coveringFindingId;

    expect(selectedId([zFinding, aFinding])).toBe("a-finding");
    expect(selectedId([aFinding, zFinding])).toBe("a-finding");
  });

  it("marks a tiny sliver near a larger accepted finding as residual noise", () => {
    const ledger = buildRegionLedger([makeComponent(544, 2241, 3, 28, 80)], [], {
      minPixelCount: 50,
      maxGapPx: 12,
      maxClusterAreaRatio: 0.5,
      imageWidth: 1200,
      imageHeight: 2600
    });
    const largeFinding = {
      ...makeDiff(500, 2200, 250, 220),
      id: "diff-large",
      classificationSource: "vlm_reviewed" as const,
      reviewerStatus: "accepted" as const
    };

    const decisions = classifyResidualFragments(ledger.regions, [largeFinding], {
      maxDistancePx: 24,
      maxResidualPixels: 120,
      maxThinSidePx: 4,
      minAreaMultiplier: 8
    });
    applyResidualFragmentDecisions(ledger, decisions);

    expect(unresolvedRegionsFromLedger(ledger, "not_classified")).toHaveLength(0);
    expect(ledger.regions[0]).toMatchObject({
      state: "noise",
      coveringFindingIds: ["diff-large"],
      unresolvedDetail: expect.stringContaining("residual")
    });
    expect(ledger.coverageTrace[0]).toMatchObject({
      status: "noise_residual_fragment",
      coveringDiffId: "diff-large",
      coveringCriterion: "geometry"
    });
  });

  it("keeps a meaningful uncovered region unresolved", () => {
    const ledger = buildRegionLedger([makeComponent(100, 100, 80, 60, 1000)], [], {
      minPixelCount: 50,
      maxGapPx: 12,
      maxClusterAreaRatio: 0.5,
      imageWidth: 1200,
      imageHeight: 2600
    });

    const decisions = classifyResidualFragments(ledger.regions, [
      { ...makeDiff(400, 400, 200, 200), id: "far-diff", reviewerStatus: "accepted" }
    ], {
      maxDistancePx: 24,
      maxResidualPixels: 120,
      maxThinSidePx: 4,
      minAreaMultiplier: 8
    });
    applyResidualFragmentDecisions(ledger, decisions);

    expect(unresolvedRegionsFromLedger(ledger, "not_classified")).toHaveLength(1);
  });
});
