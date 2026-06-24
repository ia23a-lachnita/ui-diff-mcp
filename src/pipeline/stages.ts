export interface StageResult<T> {
  name: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  warnings: string[];
  data: T;
}

export function runStage<T>(
  name: string,
  fn: () => Promise<T>,
  warnings: string[] = []
): Promise<StageResult<T>> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  return fn().then(data => ({
    name,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    warnings,
    data
  }));
}

export interface SemanticStageOutcome {
  outcome: StageOutcome;
  detail?: string;
}

export function auditTraceHasFailure(
  trace: Array<Pick<AuditCriterionTrace, "status">>
): boolean {
  return trace.some(entry => [
    "auditor_error",
    "auditor_schema_error",
    "empty_evidence",
    "reviewer_error"
  ].includes(entry.status));
}

export function deriveAuditStageOutcome(scope: AuditScope): SemanticStageOutcome {
  if (scope.stoppedReason === "route_exhausted") {
    return { outcome: "incomplete", detail: "route_exhausted" };
  }
  if ((scope.failedPairs ?? 0) > 0) {
    return { outcome: "incomplete", detail: "failed_pairs" };
  }
  if ((scope.remainingPairs ?? 0) > 0) {
    return { outcome: "incomplete", detail: "remaining_pairs" };
  }
  if (scope.auditLimited) {
    return { outcome: "incomplete", detail: "audit_limited" };
  }
  return { outcome: "success" };
}

export function deriveRecoveryStageOutcome(summary: RecoverySummary): SemanticStageOutcome {
  if (summary.stoppedReason === "caller_unavailable") {
    return { outcome: "unavailable", detail: "caller_unavailable" };
  }
  if (summary.stoppedReason !== "none") {
    return { outcome: "incomplete", detail: summary.stoppedReason };
  }
  if (summary.unclassifiedCount > 0 || summary.remainingComponents > 0) {
    return { outcome: "incomplete", detail: "unclassified_regions" };
  }
  return { outcome: "success" };
}
import type { AuditCriterionTrace, AuditScope, RecoverySummary, StageOutcome } from "../schemas/core.js";
