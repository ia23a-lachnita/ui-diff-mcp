import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignDiffComponentsToRecords } from "../../src/report/coverage.js";
import { writeUiDiffReport } from "../../src/report/report-writer.js";
import { UiDiffReportSchema, type DiffRecord } from "../../src/schemas/core.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-report-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("assignDiffComponentsToRecords", () => {
  it("uncovered components produce unclassified_visual_change records", () => {
    const components = [
      { box: { x: 50, y: 50, width: 20, height: 20 }, pixelCount: 400 }
    ];
    const diffs: DiffRecord[] = [];
    const result = assignDiffComponentsToRecords(components, diffs, 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.criterion).toBe("unclassified_visual_change");
    expect(result[0]?.evidence.length).toBeGreaterThan(0);
  });

  it("components below minArea are skipped", () => {
    const components = [
      { box: { x: 0, y: 0, width: 3, height: 3 }, pixelCount: 5 }
    ];
    const result = assignDiffComponentsToRecords(components, [], 10);
    expect(result).toHaveLength(0);
  });

  it("covered components do not produce extra records", () => {
    const components = [
      { box: { x: 10, y: 10, width: 30, height: 30 }, pixelCount: 900 }
    ];
    const diffs: DiffRecord[] = [{
      id: "d1", criterion: "geometry", severity: "medium",
      title: "Covered", location: { x: 10, y: 10, width: 30, height: 30 },
      evidence: ["covered"], measurements: [], artifactPaths: [],
      reviewerStatus: "accepted"
    }];
    const result = assignDiffComponentsToRecords(components, diffs, 10);
    expect(result).toHaveLength(1);
    expect(result[0]?.criterion).toBe("geometry");
  });
});

describe("writeUiDiffReport", () => {
  it("writes report.json and returns compact output with correct fields", async () => {
    const artifactRoot = path.join(tmpDir, "artifacts");
    const report = {
      schemaVersion: "0.1" as const,
      runId: "run-test-1",
      createdAt: new Date().toISOString(),
      status: "complete" as const,
      visualClassificationStatus: "complete" as const,
      locatorCoverageStatus: "not_run" as const,
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      artifactRoot,
      elements: { expected: [], actual: [] },
      pairs: [],
      diffs: [],
      modelHealth: [],
      runArtifacts: [],
      warnings: []
    };

    const output = await writeUiDiffReport(report);
    expect(output.runId).toBe("run-test-1");
    expect(output.status).toBe("complete");
    expect(output.diffCount).toBe(0);
    expect(output.reportPath).toContain("report.json");
    expect(output.artifactRoot).toBe(artifactRoot);
    expect(output.summary).toMatch(/No visual differences/);

    const written = await fs.readFile(output.reportPath, "utf8");
    const parsed = JSON.parse(written);
    expect(() => UiDiffReportSchema.parse(parsed)).not.toThrow();
  });

  it("compact summary mentions diff count and high severity", async () => {
    const artifactRoot = path.join(tmpDir, "artifacts2");
    const report = {
      schemaVersion: "0.1" as const,
      runId: "run-2",
      createdAt: new Date().toISOString(),
      status: "complete" as const,
      visualClassificationStatus: "complete" as const,
      locatorCoverageStatus: "not_run" as const,
      expectedImagePath: "e.png",
      actualImagePath: "a.png",
      artifactRoot,
      elements: { expected: [], actual: [] },
      pairs: [],
      diffs: [{
        id: "d1", criterion: "geometry" as const, severity: "high" as const,
        title: "Big shift", location: { x: 0, y: 0, width: 10, height: 10 },
        evidence: ["y=50"], measurements: [], artifactPaths: [],
        reviewerStatus: "accepted" as const
      }],
      modelHealth: [],
      runArtifacts: [],
      warnings: []
    };

    const output = await writeUiDiffReport(report);
    expect(output.diffCount).toBe(1);
    expect(output.summary).toContain("1 visual difference");
    expect(output.summary).toContain("1 high severity");
  });
});
