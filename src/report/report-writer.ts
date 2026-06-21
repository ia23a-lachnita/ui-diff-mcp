import fs from "node:fs/promises";
import path from "node:path";
import type { UiDiffReport, UiArtifact, AuditScope, RecoverySummary, RunDebugSummary } from "../schemas/core.js";
import { UiDiffReportSchema } from "../schemas/core.js";

export interface CompactOutput {
  runId: string;
  status: string;
  diffCount: number;
  unresolvedRegionCount: number;
  reportPath: string;
  artifactRoot: string;
  runArtifacts: UiArtifact[];
  summary: string;
  warnings: string[];
  visualClassificationStatus: string;
  locatorCoverageStatus: string;
  auditLimited: boolean;
  auditScope?: AuditScope;
  recoverySummary?: RecoverySummary;
  debugSummary?: RunDebugSummary;
}

export async function writeReportCheckpoint(report: UiDiffReport): Promise<string> {
  const reportPath = path.join(report.artifactRoot, "report.json");
  const tmpPath = `${reportPath}.tmp`;
  await fs.mkdir(report.artifactRoot, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(UiDiffReportSchema.parse(report), null, 2), "utf8");
  await fs.rename(tmpPath, reportPath);
  return reportPath;
}

export async function writeUiDiffReport(
  report: UiDiffReport
): Promise<CompactOutput> {
  const reportDir = report.artifactRoot;
  await fs.mkdir(reportDir, { recursive: true });

  const reportPath = path.join(reportDir, "report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  const diffArtifactPaths = report.diffs.flatMap(d => d.artifactPaths);
  const unresolvedArtifactPaths = report.unresolvedRegions.flatMap(region => region.artifactPaths);
  const indexPath = path.join(reportDir, "index.json");
  await fs.writeFile(indexPath, JSON.stringify({
    runId: report.runId,
    createdAt: report.createdAt,
    reportPath,
    runArtifacts: report.runArtifacts ?? [],
    artifacts: [...diffArtifactPaths, ...unresolvedArtifactPaths]
  }, null, 2), "utf8");

  const diffCount = report.diffs.length;
  const highCount = report.diffs.filter(d => d.severity === "high").length;
  const summary = diffCount === 0
    ? "No visual differences found."
    : `Found ${diffCount} visual difference${diffCount > 1 ? "s" : ""}` +
      (highCount > 0 ? ` (${highCount} high severity)` : "") + ".";

  return {
    runId: report.runId,
    status: report.status,
    diffCount,
    unresolvedRegionCount: report.unresolvedRegions.length,
    reportPath,
    artifactRoot: reportDir,
    runArtifacts: report.runArtifacts ?? [],
    summary,
    warnings: report.warnings ?? [],
    visualClassificationStatus: report.visualClassificationStatus,
    locatorCoverageStatus: report.locatorCoverageStatus,
    auditLimited: report.auditScope?.auditLimited ?? false,
    ...(report.auditScope !== undefined ? { auditScope: report.auditScope } : {}),
    ...(report.recoverySummary !== undefined ? { recoverySummary: report.recoverySummary } : {}),
    ...(report.debugSummary !== undefined ? { debugSummary: report.debugSummary } : {})
  };
}
