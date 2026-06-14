import { describe, expect, it } from "vitest";
import { findUncoveredComponents, assignDiffComponentsToRecords } from "../../src/report/coverage.js";
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
