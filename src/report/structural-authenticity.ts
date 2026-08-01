import { StructuralConsolidationDetailSchema, type UiDiffReport } from "../schemas/core.js";
import { buildFindingGroups } from "./context-overlays.js";
import {
  summarizeStructuralConsolidation,
  validateStructuralConsolidationLedger,
  type StructuralConsolidationLedger,
  type StructuralLedgerValidation,
  type StructuralFindingGroupReference,
  type StructuralConsolidationSummary
} from "./structural-invariants.js";

export interface RecomputedStructuralConsolidation {
  readonly groups: readonly StructuralFindingGroupReference[];
  readonly validation: StructuralLedgerValidation;
  readonly summary: StructuralConsolidationSummary;
}

function comparisonCanvas(report: Pick<UiDiffReport, "comparisonSpace" | "imageNormalization">): { width: number; height: number } {
  if (report.comparisonSpace !== undefined) {
    return { width: report.comparisonSpace.width, height: report.comparisonSpace.height };
  }
  const normalized = report.imageNormalization?.expected.normalized;
  if (normalized !== undefined && normalized.width > 0 && normalized.height > 0) return normalized;
  throw new Error("structural consolidation authenticity: missing comparison canvas");
}

export function recomputeStructuralConsolidation(
  report: Pick<UiDiffReport, "diffs" | "comparisonSpace" | "imageNormalization">,
  ledger: StructuralConsolidationLedger
): RecomputedStructuralConsolidation {
  const canvas = comparisonCanvas(report);
  const groups = buildFindingGroups([...report.diffs], canvas).map(group => ({ id: group.id, diffIds: [...group.diffIds] }));
  const validation = validateStructuralConsolidationLedger(ledger, {
    requireGroups: true,
    actualGroups: groups,
    finalFindingIds: report.diffs.map(diff => diff.id)
  });
  const summary = summarizeStructuralConsolidation(ledger, validation);
  return { groups, validation, summary };
}

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}

export function assertStructuralConsolidationAuthenticity(
  report: Pick<UiDiffReport, "diffs" | "comparisonSpace" | "imageNormalization" | "structuralConsolidation" | "visualClassificationStatus">,
  detail: unknown
): RecomputedStructuralConsolidation | undefined {
  if (detail === undefined) {
    throw new Error("structural consolidation detail is required for final non-checkpoint reports");
  }
  const parsed = StructuralConsolidationDetailSchema.parse(detail) as unknown as {
    ledger: StructuralConsolidationLedger;
    validation: StructuralLedgerValidation;
  };
  const recomputed = recomputeStructuralConsolidation(report, parsed.ledger);
  if (exactJson(parsed.validation) !== exactJson(recomputed.validation)) {
    throw new Error("structural consolidation authenticity: persisted validation does not match recomputed validation");
  }
  if (report.structuralConsolidation === undefined || exactJson(report.structuralConsolidation) !== exactJson(recomputed.summary)) {
    throw new Error("structural consolidation authenticity: persisted summary does not match recomputed summary");
  }
  if (recomputed.summary.status !== "pass" && report.visualClassificationStatus === "complete") {
    throw new Error("structural consolidation authenticity: incomplete structural status cannot have complete visual classification");
  }
  return recomputed;
}
