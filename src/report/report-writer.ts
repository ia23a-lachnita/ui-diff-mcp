import fs from "node:fs/promises";
import path from "node:path";
import type { UiDiffReport } from "../schemas/core.js";

export interface CompactOutput {
  runId: string;
  status: string;
  diffCount: number;
  reportPath: string;
  artifactRoot: string;
  runArtifacts: string[];
  summary: string;
  warnings: string[];
}

export async function writeUiDiffReport(
  report: UiDiffReport
): Promise<CompactOutput> {
  const reportDir = report.artifactRoot;
  await fs.mkdir(reportDir, { recursive: true });

  const reportPath = path.join(reportDir, "report.json");
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");

  const diffArtifactPaths = report.diffs.flatMap(d => d.artifactPaths);
  const indexPath = path.join(reportDir, "index.json");
  await fs.writeFile(indexPath, JSON.stringify({
    runId: report.runId,
    createdAt: report.createdAt,
    reportPath,
    runArtifacts: report.runArtifacts ?? [],
    artifacts: diffArtifactPaths
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
    reportPath,
    artifactRoot: reportDir,
    runArtifacts: report.runArtifacts ?? [],
    summary,
    warnings: report.warnings ?? []
  };
}
