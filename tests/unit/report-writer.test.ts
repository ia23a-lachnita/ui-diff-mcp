import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeReportCheckpoint, writeUiDiffReport } from "../../src/report/report-writer.js";
import { UiDiffReportSchema, UnresolvedRegionSchema } from "../../src/schemas/core.js";
import type { UiDiffReport } from "../../src/schemas/core.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "report-writer-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeReport(overrides: Partial<UiDiffReport> = {}): UiDiffReport {
  return {
    schemaVersion: "0.1",
    runId: "run-test-1",
    createdAt: new Date().toISOString(),
    status: "incomplete",
    visualClassificationStatus: "incomplete",
    locatorCoverageStatus: "not_run",
    expectedImagePath: "expected.png",
    actualImagePath: "actual.png",
    artifactRoot: tmpDir,
    elements: { expected: [], actual: [] },
    pairs: [],
    diffs: [],
    unresolvedRegions: [],
    modelHealth: [],
    runArtifacts: [],
    warnings: [],
    stages: [],
    ...overrides
  };
}

describe("writeReportCheckpoint", () => {
  it("writes a schema-valid report.json to artifactRoot", async () => {
    const report = makeReport();
    const reportPath = await writeReportCheckpoint(report);

    expect(reportPath).toBe(path.join(tmpDir, "report.json"));
    const written = JSON.parse(await fs.readFile(reportPath, "utf8"));
    expect(() => UiDiffReportSchema.parse(written)).not.toThrow();
  });

  it("creates artifactRoot directory if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "nested", "artifacts");
    const report = makeReport({ artifactRoot: nestedDir });
    await writeReportCheckpoint(report);

    const exists = await fs.access(path.join(nestedDir, "report.json")).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("writes atomically: final file exists after write", async () => {
    const report = makeReport({ status: "incomplete" });
    const reportPath = await writeReportCheckpoint(report);

    const tmpPath = `${reportPath}.tmp`;
    const tmpExists = await fs.access(tmpPath).then(() => true).catch(() => false);
    expect(tmpExists).toBe(false);

    const written = JSON.parse(await fs.readFile(reportPath, "utf8")) as { status: string };
    expect(written.status).toBe("running");
  });

  it("records stages in the written report", async () => {
    const report = makeReport({
      stages: [
        { name: "locator_pairing", status: "complete", outcome: "success", completedAt: new Date().toISOString() }
      ]
    });
    const reportPath = await writeReportCheckpoint(report);

    const written = JSON.parse(await fs.readFile(reportPath, "utf8")) as { stages: unknown[] };
    expect(written.stages).toHaveLength(1);
  });

  it("forces checkpoint reports to honest running state", async () => {
    const reportPath = await writeReportCheckpoint(makeReport({ status: "complete" }));
    const written = JSON.parse(await fs.readFile(reportPath, "utf8")) as { status: string; isCheckpoint?: boolean };
    expect(written.status).toBe("running");
    expect(written.isCheckpoint).toBe(true);
  });
});

describe("writeUiDiffReport", () => {
  it("counts final findings separately from unresolved regions", async () => {
    const report = makeReport({
      diffs: [{
        id: "diff-1",
        criterion: "geometry",
        severity: "medium",
        title: "Chart marker is displaced",
        location: { x: 20, y: 40, width: 12, height: 12 },
        evidence: ["Marker does not align with its expected position."],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "accepted"
      }],
      unresolvedRegions: [
        {
          id: "region-1",
          location: { x: 1, y: 2, width: 10, height: 11 },
          pixelCount: 45,
          sourceComponentIds: ["component-1"],
          reason: "not_classified",
          artifactPaths: []
        },
        {
          id: "region-2",
          location: { x: 30, y: 40, width: 20, height: 10 },
          pixelCount: 80,
          sourceComponentIds: ["component-2", "component-3"],
          reason: "recovery_budget_exhausted",
          artifactPaths: []
        }
      ]
    });

    const output = await writeUiDiffReport(report);

    expect(output.diffCount).toBe(1);
    expect(output.unresolvedRegionCount).toBe(2);
    const written = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(output.reportPath, "utf8")));
    expect(written.diffs).toHaveLength(1);
    expect(written.unresolvedRegions).toHaveLength(2);
  });

  it("rejects reviewer fields on unresolved regions", () => {
    const parsed = UnresolvedRegionSchema.safeParse({
      id: "region-1",
      location: { x: 1, y: 2, width: 10, height: 11 },
      pixelCount: 45,
      sourceComponentIds: ["component-1"],
      reason: "not_classified",
      artifactPaths: [],
      reviewerStatus: "accepted"
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.code === "unrecognized_keys")).toBe(true);
    }
  });
});
