import fs from "node:fs/promises";
import path from "node:path";
import type {
  AuditCriterionTrace,
  CoverageDecisionTrace,
  RecoveryComponentTrace,
  RunDebugSummary,
  UiArtifact
} from "../schemas/core.js";
import { RunDebugSummarySchema } from "../schemas/core.js";
import type { AuditScope } from "../schemas/core.js";

export interface AuditPairOutcome {
  pairId: string;
  entered: boolean;
  providerCalled: boolean;
  validAuditor: boolean;
  reviewed: boolean;
  skippedNoTrigger: boolean;
  failed: boolean;
}

export function summarizeAuditPairOutcomes(
  outcomes: AuditPairOutcome[],
  options: {
    totalPairs: number;
    selectedPairs?: number;
    auditLimited: boolean;
    stoppedReason: "none" | "route_exhausted" | "interrupted";
    preAuditDeterministicPairs?: number;
    limitReason?: string;
    remainingPairs?: number;
  }
): AuditScope {
  const selectedPairs = options.selectedPairs ?? outcomes.length;
  const providerCalledPairs = outcomes.filter(outcome => outcome.providerCalled).length;
  return {
    auditedPairs: selectedPairs,
    vlmAuditedPairs: providerCalledPairs,
    totalPairs: options.totalPairs,
    auditLimited: options.auditLimited,
    selectedPairs,
    enteredPairs: outcomes.filter(outcome => outcome.entered).length,
    providerCalledPairs,
    validAuditorPairs: outcomes.filter(outcome => outcome.validAuditor).length,
    reviewedPairs: outcomes.filter(outcome => outcome.reviewed).length,
    skippedNoTriggeredPairs: outcomes.filter(outcome => outcome.skippedNoTrigger).length,
    failedPairs: outcomes.filter(outcome => outcome.failed).length,
    remainingPairs: options.remainingPairs ?? 0,
    stoppedReason: options.stoppedReason,
    ...(options.preAuditDeterministicPairs !== undefined ? { preAuditDeterministicPairs: options.preAuditDeterministicPairs } : {}),
    ...(options.limitReason !== undefined ? { limitReason: options.limitReason } : {})
  };
}

export interface RunDebugTrace {
  audit: AuditCriterionTrace[];
  coverage: CoverageDecisionTrace[];
  recovery: RecoveryComponentTrace[];
}

export function summarizeRunDebug(trace: RunDebugTrace): RunDebugSummary {
  const summary: RunDebugSummary = {
    auditPairs: new Set(trace.audit.map(t => t.pairId)).size,
    auditCriterionCalls: trace.audit.filter(t => t.status !== "criterion_not_triggered").length,
    auditAccepted: trace.audit.filter(t => t.status === "reviewer_accepted" || t.status === "reviewer_needs_escalation" || t.status === "deterministic_projected_mismatch").length,
    auditRejected: trace.audit.filter(t => t.status === "reviewer_rejected").length,
    auditNoDiff: trace.audit.filter(t => t.status === "auditor_no_diff").length,
    auditErrors: trace.audit.filter(t =>
      t.status === "auditor_error" ||
      t.status === "auditor_schema_error" ||
      t.status === "reviewer_error" ||
      t.status === "empty_evidence"
    ).length,
    coverageComponents: trace.coverage.length,
    coverageCovered: trace.coverage.filter(t => t.status === "covered_by_diff").length,
    coverageUncovered: trace.coverage.filter(t => t.status === "uncovered").length,
    coverageBelowThreshold: trace.coverage.filter(t => t.status === "below_threshold").length,
    recoveryAttempted: trace.recovery.filter(t =>
      !t.status.startsWith("skipped_") && t.status !== "below_threshold"
    ).length,
    recoveryAccepted: trace.recovery.filter(t =>
      t.status === "recovery_accepted" || t.status === "recovery_needs_escalation"
    ).length,
    recoveryRejected: trace.recovery.filter(t => t.status === "recovery_rejected").length,
    recoveryClassifiedFalse: trace.recovery.filter(t => t.status === "classified_false").length,
    recoveryErrors: trace.recovery.filter(t => [
      "recovery_error",
      "recovery_schema_error",
      "missing_required_fields",
      "box_out_of_bounds",
      "box_no_component_overlap"
    ].includes(t.status)).length,
    recoverySkipped: trace.recovery.filter(t =>
      t.status.startsWith("skipped_") || t.status === "below_threshold"
    ).length
  };
  return RunDebugSummarySchema.parse(summary);
}

export async function writeRunDebugArtifacts(
  artifactDir: string,
  trace: RunDebugTrace
): Promise<{ summary: RunDebugSummary; artifacts: UiArtifact[] }> {
  await fs.mkdir(artifactDir, { recursive: true });
  const summary = summarizeRunDebug(trace);
  const files = [
    { role: "audit_trace" as const, path: path.join(artifactDir, "audit-trace.json"), data: trace.audit },
    { role: "coverage_trace" as const, path: path.join(artifactDir, "coverage-trace.json"), data: trace.coverage },
    { role: "recovery_trace" as const, path: path.join(artifactDir, "recovery-trace.json"), data: trace.recovery },
    { role: "debug_summary" as const, path: path.join(artifactDir, "debug-summary.json"), data: summary }
  ];
  for (const file of files) {
    await fs.writeFile(file.path, JSON.stringify(file.data, null, 2), "utf8");
  }
  return {
    summary,
    artifacts: files.map(f => ({ role: f.role, path: f.path }))
  };
}
