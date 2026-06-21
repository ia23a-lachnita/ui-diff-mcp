import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignDiffComponentsToRecords } from "../../src/report/coverage.js";
import { writeUiDiffReport } from "../../src/report/report-writer.js";
import { UiDiffReportSchema, type DiffRecord } from "../../src/schemas/core.js";
import { makeElementSlug } from "../../src/audit/audit-target.js";

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
      unresolvedRegions: [],
      modelHealth: [],
      runArtifacts: [],
      warnings: [],
      stages: []
    };

    const output = await writeUiDiffReport(report);
    expect(output.runId).toBe("run-test-1");
    expect(output.status).toBe("complete");
    expect(output.diffCount).toBe(0);
    expect(output.reportPath).toContain("report.json");
    expect(output.artifactRoot).toBe(artifactRoot);
    expect(output.summary).toMatch(/No visual differences/);
    expect(output.visualClassificationStatus).toBe("complete");
    expect(output.auditLimited).toBe(false);

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
      unresolvedRegions: [],
      modelHealth: [],
      runArtifacts: [],
      warnings: [],
      stages: []
    };

    const output = await writeUiDiffReport(report);
    expect(output.diffCount).toBe(1);
    expect(output.summary).toContain("1 visual difference");
    expect(output.summary).toContain("1 high severity");
  });

  it("includes auditScope in compact output when provided", async () => {
    const artifactRoot = path.join(tmpDir, "artifacts3");
    const report = {
      schemaVersion: "0.1" as const,
      runId: "run-3",
      createdAt: new Date().toISOString(),
      status: "complete" as const,
      visualClassificationStatus: "complete" as const,
      locatorCoverageStatus: "not_run" as const,
      expectedImagePath: "e.png",
      actualImagePath: "a.png",
      artifactRoot,
      elements: { expected: [], actual: [] },
      pairs: [],
      diffs: [],
      unresolvedRegions: [],
      modelHealth: [],
      runArtifacts: [],
      warnings: [],
      stages: [],
      auditScope: { auditedPairs: 3, totalPairs: 5, auditLimited: true, limitReason: "max pairs limit" }
    };

    const output = await writeUiDiffReport(report);
    expect(output.auditScope).toBeDefined();
    expect(output.auditScope?.auditedPairs).toBe(3);
    expect(output.auditScope?.totalPairs).toBe(5);
    expect(output.auditScope?.auditLimited).toBe(true);
    expect(output.auditScope?.limitReason).toBe("max pairs limit");
    // auditScope persisted in report.json
    const written = JSON.parse(await fs.readFile(output.reportPath, "utf8")) as { auditScope?: unknown };
    expect(written.auditScope).toBeDefined();
  });

  it("auditScope is absent from compact output when not provided", async () => {
    const artifactRoot = path.join(tmpDir, "artifacts4");
    const report = {
      schemaVersion: "0.1" as const,
      runId: "run-4",
      createdAt: new Date().toISOString(),
      status: "complete" as const,
      visualClassificationStatus: "not_run" as const,
      locatorCoverageStatus: "not_run" as const,
      expectedImagePath: "e.png",
      actualImagePath: "a.png",
      artifactRoot,
      elements: { expected: [], actual: [] },
      pairs: [],
      diffs: [],
      unresolvedRegions: [],
      modelHealth: [],
      runArtifacts: [],
      warnings: [],
      stages: []
    };

    const output = await writeUiDiffReport(report);
    expect(output.auditScope).toBeUndefined();
  });
});

describe("makeElementSlug", () => {
  it("converts label to kebab-case", () => {
    expect(makeElementSlug("Submit Button")).toBe("submit-button");
  });

  it("replaces multiple special chars with a single dash", () => {
    expect(makeElementSlug("Kcal / Value!")).toBe("kcal-value");
  });

  it("truncates to 20 characters", () => {
    expect(makeElementSlug("A Very Long Label Name That Exceeds Limit")).toHaveLength(20);
  });

  it("strips leading and trailing dashes", () => {
    expect(makeElementSlug("  Leading Trailing  ")).not.toMatch(/^-|-$/);
  });
});
