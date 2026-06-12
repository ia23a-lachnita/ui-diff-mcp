import { describe, expect, it } from "vitest";
import { DiffRecordSchema, UiDiffReportSchema } from "../../src/schemas/core.js";

describe("core schemas", () => {
  it("accepts a visible diff record with evidence", () => {
    const parsed = DiffRecordSchema.parse({
      id: "diff-1",
      criterion: "geometry",
      severity: "high",
      title: "Button is lower than expected",
      location: { x: 10, y: 20, width: 100, height: 44 },
      evidence: ["actual y=20, expected y=12"],
      reviewerStatus: "accepted"
    });
    expect(parsed.criterion).toBe("geometry");
  });

  it("rejects a report without evidence-backed diffs", () => {
    expect(() => UiDiffReportSchema.parse({
      schemaVersion: "0.1",
      runId: "run-1",
      createdAt: new Date().toISOString(),
      status: "complete",
      visualClassificationStatus: "complete",
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      artifactRoot: ".ui-diff/runs/run-1/artifacts",
      elements: { expected: [], actual: [] },
      pairs: [],
      diffs: [{
        id: "bad",
        criterion: "presence",
        severity: "low",
        title: "Bad",
        location: { x: 0, y: 0, width: 1, height: 1 },
        evidence: [],
        reviewerStatus: "accepted"
      }],
      modelHealth: []
    })).toThrow();
  });
});
