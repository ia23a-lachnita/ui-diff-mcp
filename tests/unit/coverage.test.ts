import { describe, expect, it } from "vitest";
import { findUncoveredComponents, assignDiffComponentsToRecords, traceCoverageDecisions } from "../../src/report/coverage.js";
import { clusterUncoveredComponents } from "../../src/report/component-clustering.js";
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
