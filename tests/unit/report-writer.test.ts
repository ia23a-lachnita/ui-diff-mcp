import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeReportCheckpoint } from "../../src/report/report-writer.js";
import { UiDiffReportSchema } from "../../src/schemas/core.js";
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
    expect(written.status).toBe("incomplete");
  });

  it("records stages in the written report", async () => {
    const report = makeReport({
      stages: [
        { name: "locator_pairing", status: "complete", completedAt: new Date().toISOString() }
      ]
    });
    const reportPath = await writeReportCheckpoint(report);

    const written = JSON.parse(await fs.readFile(reportPath, "utf8")) as { stages: unknown[] };
    expect(written.stages).toHaveLength(1);
  });
});
