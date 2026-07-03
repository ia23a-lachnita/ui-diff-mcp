import { describe, expect, it } from "vitest";
import { buildLocatorBenchmarkMarkdown, determineBenchmarkConclusion, parseBenchmarkDimensions, summarizeLabelStability } from "../../scripts/benchmark-locator-lanes.js";

describe("locator benchmark helpers", () => {
  it("parses sorted unique benchmark dimensions with safe defaults", () => {
    expect(parseBenchmarkDimensions(undefined)).toEqual([600, 900, 1200]);
    expect(parseBenchmarkDimensions("1200, 600,900,600, bad, 100, 2401")).toEqual([600, 900, 1200]);
  });

  it("summarizes label stability against the largest completed dimension", () => {
    const summary = summarizeLabelStability(
      { expected: ["text:Today", "icon:Bell"], actual: ["text:Today"] },
      { expected: ["text:Today", "icon:Bell", "card:Meal"], actual: ["text:Today", "icon:Eye"] }
    );

    expect(summary.expectedMissingLabels).toEqual(["card:Meal"]);
    expect(summary.actualMissingLabels).toEqual(["icon:Eye"]);
    expect(summary.expectedExtraLabels).toEqual([]);
    expect(summary.actualExtraLabels).toEqual([]);
  });

  it("marks the benchmark complete once any live dimension completed", () => {
    expect(determineBenchmarkConclusion([
      { maxDimension: 1200, status: "timeout", error: "timed out" }
    ])).toBe("needs_live_data");
    expect(determineBenchmarkConclusion([
      { maxDimension: 600, status: "complete", expected: { elapsedMs: 1, imageWidth: 1, imageHeight: 1, usefulElementCount: 1, queryCoverageRatio: 1, queryCounts: {}, laneMetadata: {}, elements: [] }, actual: { elapsedMs: 1, imageWidth: 1, imageHeight: 1, usefulElementCount: 1, queryCoverageRatio: 1, queryCounts: {}, laneMetadata: {}, elements: [] } },
      { maxDimension: 1200, status: "timeout", error: "timed out" }
    ])).toBe("complete");
  });

  it("builds markdown that marks timeout trials and sequential execution", () => {
    const markdown = buildLocatorBenchmarkMarkdown({
      generatedAt: "2026-07-03T00:00:00.000Z",
      sidecarUrl: "http://127.0.0.1:39731",
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      conclusion: "needs_live_data",
      trials: [
        {
          maxDimension: 600,
          status: "complete",
          expected: { elapsedMs: 1000, imageWidth: 1200, imageHeight: 2600, usefulElementCount: 10, queryCoverageRatio: 1, queryCounts: { text: 4 }, laneMetadata: {}, elements: [] },
          actual: { elapsedMs: 1200, imageWidth: 1080, imageHeight: 2400, usefulElementCount: 9, queryCoverageRatio: 1, queryCounts: { text: 3 }, laneMetadata: {}, elements: [] }
        },
        { maxDimension: 1200, status: "timeout", error: "The operation was aborted" }
      ]
    });

    expect(markdown).toContain("Trials are executed sequentially");
    expect(markdown).toContain("| 600 | complete | 1.0s | 1.2s | 10 | 9 |");
    expect(markdown).toContain("| 1200 | timeout | - | - | - | - |");
  });
});
