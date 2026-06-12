import { describe, it, expect } from "vitest";
import { assignDiffComponentsToRecords } from "../../src/report/coverage.js";
import { writeUiDiffReport } from "../../src/report/report-writer.js";
import { UiDiffReportSchema } from "../../src/schemas/core.js";

describe("Report Writer", () => {
  it("should assign diff components", () => {
    const components = [{ area: 100 }];
    const diffs: any[] = [];
    const newDiffs = assignDiffComponentsToRecords(components, diffs, 50);
    // This is a placeholder test. A real test would check for unclassified_visual_change.
    expect(newDiffs).toBe(diffs);
  });

  it("should write a report", () => {
    const report: any = {
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
      diffs: [],
      modelHealth: [],
      warnings: [],
    };
    const output = writeUiDiffReport(report);
    expect(output.diffCount).toBe(0);
    expect(output.status).toBe("complete");
  });
});
