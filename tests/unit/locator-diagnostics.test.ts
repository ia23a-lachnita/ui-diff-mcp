import { describe, expect, it } from "vitest";
import { buildTargetMapJson } from "../../src/locator/diagnostics.js";

describe("buildTargetMapJson", () => {
  it("serializes element ids, labels, boxes, and coverage", () => {
    const json = buildTargetMapJson({
      imageRole: "actual",
      coverage: {
        status: "weak",
        promptCount: 8,
        usefulElementCount: 1,
        queryCounts: { text_labels: 1 },
        queryCoverageRatio: 0.125,
        rejectedElementCount: 1,
        reasons: ["query_coverage_below_threshold"]
      },
      elements: []
    });

    expect(json.imageRole).toBe("actual");
    expect(json.coverage.status).toBe("weak");
  });
});