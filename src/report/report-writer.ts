import fs from "node:fs/promises";
import path from "node:path";
import type { UiDiffReport, UiArtifact, AuditScope, RecoverySummary, RunDebugSummary, RuntimeModelUsage, RuntimeModelUsageDiagnostics, UsageSummary, StructuralConsolidationSummary } from "../schemas/core.js";
import { UiDiffReportSchema } from "../schemas/core.js";
import { assertReportReferenceIntegrity, slimReportForParts, writeReportParts } from "./report-parts.js";
import { assertStructuralConsolidationAuthenticity } from "./structural-authenticity.js";

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
  structuralConsolidation: StructuralConsolidationSummary;
  auditScope?: AuditScope;
  recoverySummary?: RecoverySummary;
  debugSummary?: RunDebugSummary;
  usageSummary?: UsageSummary;
  runtimeModelUsage?: RuntimeModelUsage[];
  runtimeModelUsageDiagnostics?: RuntimeModelUsageDiagnostics;
}

export async function writeReportCheckpoint(report: UiDiffReport): Promise<string> {
  const reportPath = path.join(report.artifactRoot, "report.json");
  const tmpPath = `${reportPath}.tmp`;
  await fs.mkdir(report.artifactRoot, { recursive: true });
  const checkpointSource: UiDiffReport = {
    ...report,
    isCheckpoint: true,
    structuralConsolidation: {
      status: "not_evaluated",
      candidateCount: 0,
      retainedCount: 0,
      suppressedCount: 0,
      broadExcludedCount: 0,
      violationCount: 0
    },
    structuralConsolidationDetail: undefined
  };
  const reportParts = await writeReportParts(checkpointSource);
  const checkpoint = UiDiffReportSchema.parse(slimReportForParts({
    ...checkpointSource,
    status: report.status === "interrupted" ? "interrupted" : "running",
    isCheckpoint: true,
    heartbeatAt: new Date().toISOString(),
    progress: { ...(report.progress ?? { stage: "checkpoint" }), checkpointPath: reportPath }
  }, reportParts));
  await fs.writeFile(tmpPath, JSON.stringify(checkpoint, null, 2), "utf8");
  await fs.rename(tmpPath, reportPath);
  return reportPath;
}

export async function writeUiDiffReport(
  report: UiDiffReport
): Promise<CompactOutput> {
  if (report.isCheckpoint === true) {
    throw new Error("writeUiDiffReport is the final writer; checkpoint input is not allowed");
  }
  if (report.status === "running" || report.status === "interrupted") {
    throw new Error(`final report status cannot be ${report.status}`);
  }
  assertReportReferenceIntegrity(report);
  assertStructuralConsolidationAuthenticity(report, report.structuralConsolidationDetail);
  const reportDir = report.artifactRoot;
  await fs.mkdir(reportDir, { recursive: true });

  const reportPath = path.join(reportDir, "report.json");
  const reportParts = await writeReportParts(report);

  const diffArtifactPaths = report.diffs.flatMap(d => d.artifactPaths);
  const broadEvidenceArtifactPaths = (report.broadEvidence ?? []).flatMap(d => d.artifactPaths);
  const unresolvedArtifactPaths = report.unresolvedRegions.flatMap(region => region.artifactPaths);
  const indexPath = path.join(reportDir, "index.json");
  const indexTmpPath = `${indexPath}.tmp`;
  await fs.writeFile(indexTmpPath, JSON.stringify({
    runId: report.runId,
    createdAt: report.createdAt,
    reportPath,
    reportParts,
    runArtifacts: report.runArtifacts ?? [],
    artifacts: [...diffArtifactPaths, ...broadEvidenceArtifactPaths, ...unresolvedArtifactPaths]
  }, null, 2), "utf8");
  await fs.rename(indexTmpPath, indexPath);

  const finalReport = UiDiffReportSchema.parse(slimReportForParts({
    ...report,
    isCheckpoint: false,
    structuralConsolidationContract: "v1",
    heartbeatAt: new Date().toISOString()
  }, reportParts));
  const reportTmpPath = `${reportPath}.tmp`;
  await fs.writeFile(reportTmpPath, JSON.stringify(finalReport, null, 2), "utf8");
  await fs.rename(reportTmpPath, reportPath);

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
    structuralConsolidation: report.structuralConsolidation ?? {
      status: "not_evaluated",
      candidateCount: 0,
      retainedCount: 0,
      suppressedCount: 0,
      broadExcludedCount: 0,
      violationCount: 0
    },
    ...(report.auditScope !== undefined ? { auditScope: report.auditScope } : {}),
    ...(report.recoverySummary !== undefined ? { recoverySummary: report.recoverySummary } : {}),
    ...(report.debugSummary !== undefined ? { debugSummary: report.debugSummary } : {}),
    ...(report.usageSummary !== undefined ? { usageSummary: report.usageSummary } : {}),
    runtimeModelUsage: report.runtimeModelUsage ?? [],
    ...(report.runtimeModelUsageDiagnostics !== undefined ? { runtimeModelUsageDiagnostics: report.runtimeModelUsageDiagnostics } : {})
  };
}
