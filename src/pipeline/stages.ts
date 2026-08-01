import type { AuditCriterionTrace, AuditScope, LocatorCoverageStatus, RecoverySummary, RunStatus, StageOutcome, VisualClassificationStatus } from "../schemas/core.js";

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
    "reviewer_error",
    "reviewer_needs_escalation",
    "comparison_non_comparable",
    "independent_reviewer_unavailable"
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

export interface VisualClassificationFacts {
  mode: string;
  runStatus: RunStatus;
  locatorFailed: boolean;
  locatorCoverageStatus: LocatorCoverageStatus;
  auditScope?: {
    auditLimited?: boolean | undefined;
    stoppedReason?: AuditScope["stoppedReason"] | undefined;
    failedPairs?: number | undefined;
    remainingPairs?: number | undefined;
  };
  recoverySummary?: {
    stoppedReason?: RecoverySummary["stoppedReason"] | undefined;
    unclassifiedCount?: number | undefined;
    remainingComponents?: number | undefined;
  };
  unresolvedRegionCount: number;
}

export function deriveVisualClassificationStatus(
  facts: VisualClassificationFacts
): VisualClassificationStatus {
  if (facts.mode === "deterministic_only") return "not_run";
  if (facts.locatorFailed || facts.locatorCoverageStatus === "failed") return "incomplete";
  if (facts.runStatus !== "complete") return "incomplete";

  const audit = facts.auditScope;
  if (
    audit?.auditLimited
    || (audit?.stoppedReason !== undefined && audit.stoppedReason !== "none")
    || (audit?.failedPairs ?? 0) > 0
    || (audit?.remainingPairs ?? 0) > 0
  ) {
    return "incomplete";
  }

  const recovery = facts.recoverySummary;
  if (
    (recovery?.stoppedReason !== undefined && recovery.stoppedReason !== "none")
    || (recovery?.unclassifiedCount ?? 0) > 0
    || (recovery?.remainingComponents ?? 0) > 0
  ) {
    return "incomplete";
  }

  return facts.unresolvedRegionCount > 0 ? "incomplete" : "complete";
}
