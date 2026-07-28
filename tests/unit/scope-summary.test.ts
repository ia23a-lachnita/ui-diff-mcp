import { describe, expect, it } from "vitest";
import { buildDiffSummary, buildScopeDiffSummaries } from "../../src/diff/scope-summary.js";
import type { DiffRecord } from "../../src/schemas/core.js";

describe("scope summary", () => {
  it("summarizes changed mass for screen and named regions with triggered criteria", () => {
    const summaries = buildScopeDiffSummaries({
      imageWidth: 100,
      imageHeight: 200,
      pixelComponents: [
        { id: "component-nav", box: { x: 0, y: 180, width: 100, height: 20 }, pixelCount: 2_000 },
        { id: "component-header", box: { x: 0, y: 0, width: 100, height: 20 }, pixelCount: 500 }
      ],
      edgeComponents: [
        { box: { x: 0, y: 180, width: 100, height: 20 }, pixelCount: 600 }
      ],
      expectedRgba: { data: new Uint8Array(100 * 200 * 4).fill(20), width: 100, height: 200 },
      actualRgba: { data: new Uint8Array(100 * 200 * 4).fill(80), width: 100, height: 200 }
    });

    const screen = summaries.find(summary => summary.id === "screen");
    const nav = summaries.find(summary => summary.id === "nav");

    expect(screen?.changedPixelPercent).toBeGreaterThan(0);
    expect(nav?.triggeredCriteria).toEqual(expect.arrayContaining(["geometry", "spacing_alignment", "icon_image"]));
    expect(nav?.measurements.some(measurement => measurement.name === "scope_color_distance")).toBe(true);
  });

  it("uses only comparable pixels for scope percentages", () => {
    const summaries = buildScopeDiffSummaries({
      imageWidth: 100,
      imageHeight: 100,
      validRect: { x: 10, y: 0, width: 80, height: 100 },
      pixelComponents: [
        {
          box: { x: 10, y: 0, width: 80, height: 100 },
          pixelCount: 8_000
        }
      ]
    });

    expect(summaries.find(summary => summary.id === "screen")?.changedPixelPercent).toBe(100);
  });

  it("builds final diff counts by severity, criterion, and classification source", () => {
    const diffs: DiffRecord[] = [
      {
        id: "diff-1",
        criterion: "geometry",
        severity: "high",
        title: "Region shifted",
        location: { x: 0, y: 0, width: 10, height: 10 },
        evidence: ["Visible shift."],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "accepted",
        classificationSource: "vlm_reviewed"
      },
      {
        id: "diff-2",
        criterion: "color_appearance",
        severity: "medium",
        title: "Palette differs",
        location: { x: 0, y: 0, width: 10, height: 10 },
        evidence: ["Visible color change."],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "accepted",
        classificationSource: "target_recovery"
      }
    ];

    const summary = buildDiffSummary(diffs, 3, [], 1);

    expect(summary.finalDiffCount).toBe(2);
    expect(summary.finalGroupCount).toBe(1);
    expect(summary.unresolvedRegionCount).toBe(3);
    expect(summary.bySeverity.high).toBe(1);
    expect(summary.byCriterion.geometry).toBe(1);
    expect(summary.byClassificationSource.target_recovery).toBe(1);
  });
});
