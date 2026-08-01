import type { Box, DeterministicMeasurement, DiffRecord } from "../schemas/core.js";

export const STRUCTURAL_RELATION_REASONS = [
  "same_finding",
  "no_semantic_relation",
  "sibling_boundary",
  "distinct_criterion",
  "oversized_parent",
  "nonlocal",
  "distinct_projection_kind",
  "equivalent_explicit_group",
  "invalid_measurement_relation",
  "independent_geometry",
  "coherent_translation",
  "coherent_resize",
  "unexplained_nested_same_criterion"
] as const;
export type StructuralRelationReason = typeof STRUCTURAL_RELATION_REASONS[number];

export const STRUCTURAL_VALIDATION_VIOLATIONS = [
  "missing_retained_lineage",
  "unexplained_nested_same_criterion",
  "oversized_parent",
  "sibling_boundary",
  "invalid_measurement_relation",
  "missing_retained_group",
  "ambiguous_retained_group"
] as const;
export type StructuralValidationViolation = typeof STRUCTURAL_VALIDATION_VIOLATIONS[number];

export const STRUCTURAL_ACCOUNTING_ISSUES = [
  "duplicate_candidate",
  "unknown_terminal",
  "duplicate_terminal",
  "duplicate_retained_id",
  "retained_terminal_not_retained",
  "retained_id_without_candidate",
  "retained_id_without_terminal",
  "suppressed_missing_decision",
  "suppressed_mismatched_decision",
  "duplicate_decision",
  "decision_for_retained_candidate",
  "decision_for_broad_candidate",
  "unknown_decision_id",
  "decision_criterion_mismatch",
  "decision_action_mismatch",
  "decision_reason_mismatch",
  "decision_semantic_descendant_mismatch",
  "decision_semantic_relation_mismatch",
  "decision_displacement_mismatch",
  "decision_measurement_mismatch",
  "duplicate_element_lineage",
  "dangling_parent_lineage",
  "cyclic_element_lineage",
  "broad_ineligible",
  "broad_has_retained",
  "broad_has_decision",
  "terminal_violation"
] as const;
export type StructuralAccountingIssue = typeof STRUCTURAL_ACCOUNTING_ISSUES[number];

export type StructuralRelationAction = "suppress" | "retain_distinct" | "violation" | "unrelated";
export type StructuralSemanticRelation = "descendant" | "sibling" | "unrelated" | "invalid";
export type StructuralMeasurementKind = "none" | "translation" | "resize" | "mixed" | "invalid";
export type StructuralDisplacementRelation = "coherent_translation" | "distinct_translation" | "not_applicable" | "missing_measurement";
export type StructuralMeasurementRelation = "same" | "distinct_resize" | "resize_vs_translation" | "distinct_projection_kind" | "explicit_equivalence" | "coherent_translation" | "coherent_resize" | "missing_measurement";

export interface StructuralMeasurementSignature {
  readonly kind: StructuralMeasurementKind;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface StructuralRelationInput {
  readonly parentFindingId: string;
  readonly childFindingId: string;
  readonly parentElementId?: string;
  readonly childElementId?: string;
  readonly criterion: string;
  readonly sameCriterion: boolean;
  readonly semanticRelation: StructuralSemanticRelation;
  readonly parentBox: Box;
  readonly childBox: Box;
  readonly unionBox: Box;
  readonly canvas: { readonly width: number; readonly height: number };
  readonly parentAreaRatio: number;
  readonly unionAreaRatio: number;
  readonly childContainment: number;
  readonly parentProjectionMismatchKind?: string;
  readonly childProjectionMismatchKind?: string;
  readonly explicitFindingGroupId?: string;
  readonly explicitFindingGroupKind?: string;
  readonly parentMeasurement: StructuralMeasurementSignature;
  readonly childMeasurement: StructuralMeasurementSignature;
}

export interface StructuralRelationResult {
  readonly action: StructuralRelationAction;
  readonly reason: StructuralRelationReason;
  readonly displacementRelation: StructuralDisplacementRelation;
  readonly measurementRelation: StructuralMeasurementRelation;
}

export interface StructuralLedgerCandidate {
  readonly findingId: string;
  readonly criterion: string;
  readonly elementIds?: readonly string[];
  readonly elementId?: string;
  readonly classificationSource?: Exclude<DiffRecord["classificationSource"], undefined>;
  readonly repairLocality?: Exclude<DiffRecord["repairLocality"], undefined>;
}

export interface StructuralElementLineage {
  readonly elementId: string;
  readonly parentId?: string;
}

export interface StructuralSuppressionDecision {
  readonly action: StructuralRelationAction;
  readonly reason: StructuralRelationReason;
  readonly suppressedFindingId: string;
  readonly retainedFindingId: string;
  readonly parentElementId?: string;
  readonly childElementId?: string;
  readonly criterion: string;
  readonly sameCriterion: boolean;
  readonly semanticDescendant: boolean;
  readonly semanticRelation: StructuralSemanticRelation;
  readonly parentAreaRatio: number;
  readonly locality: number;
  readonly childContainment: number;
  readonly parentMeasurement: StructuralMeasurementSignature;
  readonly childMeasurement: StructuralMeasurementSignature;
  readonly parentProjectionMismatchKind?: string;
  readonly childProjectionMismatchKind?: string;
  readonly explicitFindingGroupId?: string;
  readonly explicitFindingGroupKind?: string;
  readonly displacementRelation: StructuralDisplacementRelation;
  readonly measurementRelation: StructuralMeasurementRelation;
  readonly retainedGroupId?: string;
  readonly retainedGroupIds?: readonly string[];
}

export const STRUCTURAL_CANDIDATE_TERMINALS = [
  "retained",
  "suppressed_to_retained",
  "broad_excluded",
  "violation"
] as const;
export type StructuralCandidateTerminal = typeof STRUCTURAL_CANDIDATE_TERMINALS[number];

export interface StructuralCandidateTerminalRecord {
  readonly candidateId: string;
  readonly terminal: StructuralCandidateTerminal;
  readonly retainedFindingId?: string;
  readonly exclusionReason?: "broad_vlm_evidence";
  readonly violationCode?: "missing_retained_lineage";
  readonly detail?: {
    readonly expectedRetainedCount: number;
    readonly actualRetainedCount: number;
    readonly accountingIssue?: StructuralAccountingIssue;
  };
}

export interface StructuralConsolidationLedger {
  readonly candidates: readonly StructuralLedgerCandidate[];
  readonly decisions: readonly StructuralSuppressionDecision[];
  readonly retainedFindingIds: readonly string[];
  readonly candidateTerminals: readonly StructuralCandidateTerminalRecord[];
  readonly elementLineage?: readonly StructuralElementLineage[];
}

export interface StructuralValidationViolationRecord {
  readonly code: StructuralValidationViolation;
  readonly elementId?: string;
  readonly candidateId?: string;
  readonly suppressedFindingId?: string;
  readonly retainedFindingId?: string;
  readonly affectedGroupIds: readonly string[];
  readonly detail?: {
    readonly expectedRetainedCount?: number;
    readonly actualRetainedCount?: number;
    readonly accountingIssue?: StructuralAccountingIssue;
  };
}

export interface StructuralLedgerValidation {
  readonly status: "pass" | "fail" | "not_evaluated";
  readonly violations: readonly StructuralValidationViolationRecord[];
}

export interface StructuralCandidateLineage {
  readonly candidateId: string;
  readonly retainedFindingIds: readonly string[];
}

export interface StructuralCandidateAccountingInput {
  readonly candidates: readonly StructuralLedgerCandidate[];
  readonly retainedFindingIds: readonly string[];
  readonly broadExcludedIds?: readonly string[];
  readonly removedLineage: readonly StructuralCandidateLineage[];
  readonly decisions: readonly StructuralSuppressionDecision[];
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

export function buildCandidateTerminalRecords(input: StructuralCandidateAccountingInput): readonly StructuralCandidateTerminalRecord[] {
  const retained = new Set(input.retainedFindingIds);
  const broadExcluded = new Set(input.broadExcludedIds ?? []);
  const decisions = new Map<string, StructuralSuppressionDecision[]>();
  for (const decision of input.decisions) {
    const existing = decisions.get(decision.suppressedFindingId) ?? [];
    existing.push(decision);
    decisions.set(decision.suppressedFindingId, existing);
  }
  return freezeArray([...input.candidates]
    .sort((a, b) => a.findingId.localeCompare(b.findingId))
    .map(candidate => {
      const candidateDecisions = decisions.get(candidate.findingId) ?? [];
      const broadEligible = candidate.classificationSource === "vlm_reviewed" && candidate.repairLocality === "broad";
      if (broadEligible && !retained.has(candidate.findingId) && candidateDecisions.length === 0) {
        return Object.freeze({
          candidateId: candidate.findingId,
          terminal: "broad_excluded" as const,
          exclusionReason: "broad_vlm_evidence" as const
        });
      }
      if (broadEligible) {
        return Object.freeze({
          candidateId: candidate.findingId,
          terminal: "violation" as const,
          violationCode: "missing_retained_lineage" as const,
          detail: Object.freeze({
            expectedRetainedCount: 0,
            actualRetainedCount: candidateDecisions.length,
            accountingIssue: retained.has(candidate.findingId) ? "broad_has_retained" as const : "broad_has_decision" as const
          })
        });
      }
      if (retained.has(candidate.findingId)) return Object.freeze({ candidateId: candidate.findingId, terminal: "retained" as const });
      const matchingSuppressions = candidateDecisions.filter(decision => decision.action === "suppress" && retained.has(decision.retainedFindingId));
      if (matchingSuppressions.length === 1 && candidateDecisions.length === 1) {
        return Object.freeze({
          candidateId: candidate.findingId,
          terminal: "suppressed_to_retained" as const,
          retainedFindingId: matchingSuppressions[0]!.retainedFindingId
        });
      }
      return Object.freeze({
        candidateId: candidate.findingId,
        terminal: "violation" as const,
        violationCode: "missing_retained_lineage" as const,
        detail: Object.freeze({
          expectedRetainedCount: 1,
          actualRetainedCount: matchingSuppressions.length,
          accountingIssue: broadEligible && retained.has(candidate.findingId) ? "broad_has_retained" as const :
            broadEligible && candidateDecisions.length > 0 ? "broad_has_decision" as const :
            broadExcluded.has(candidate.findingId) && !broadEligible ? "broad_ineligible" as const :
            candidateDecisions.length === 0 ? "suppressed_missing_decision" as const :
            candidateDecisions.length > 1 ? "duplicate_decision" as const : "terminal_violation" as const
        })
      });
    }));
}

export function freezeStructuralLedger(ledger: StructuralConsolidationLedger): StructuralConsolidationLedger {
  const candidates = [...ledger.candidates].sort((a, b) => a.findingId.localeCompare(b.findingId));
  const decisions = [...ledger.decisions].sort((a, b) => a.suppressedFindingId.localeCompare(b.suppressedFindingId)
    || a.retainedFindingId.localeCompare(b.retainedFindingId)
    || a.reason.localeCompare(b.reason));
  const terminals = [...ledger.candidateTerminals].sort((a, b) => a.candidateId.localeCompare(b.candidateId)
    || a.terminal.localeCompare(b.terminal)
    || (a.retainedFindingId ?? "").localeCompare(b.retainedFindingId ?? ""));
  return Object.freeze({
    candidates: freezeArray(candidates.map(candidate => Object.freeze({
      ...candidate,
      ...(candidate.elementIds ? { elementIds: freezeArray([...candidate.elementIds].sort()) } : {})
    }))),
    decisions: freezeArray(decisions.map(decision => Object.freeze({
      ...decision,
      ...(decision.retainedGroupIds ? { retainedGroupIds: freezeArray([...decision.retainedGroupIds].sort()) } : {})
    }))),
    retainedFindingIds: freezeArray([...ledger.retainedFindingIds].sort()),
    ...(ledger.elementLineage ? {
      elementLineage: freezeArray([...ledger.elementLineage]
        .sort((a, b) => a.elementId.localeCompare(b.elementId) || (a.parentId ?? "").localeCompare(b.parentId ?? ""))
        .map(lineage => Object.freeze({ ...lineage })))
    } : {}),
    candidateTerminals: freezeArray(terminals.map(terminal => Object.freeze({
      ...terminal,
      ...(terminal.detail ? { detail: Object.freeze({ ...terminal.detail }) } : {})
    })))
  });
}

export function measurementSignature(measurements: readonly DeterministicMeasurement[]): StructuralMeasurementSignature {
  const hasX = measurements.some(measurement => measurement.name === "horizontal_shift" || measurement.name === "deltaX");
  const hasY = measurements.some(measurement => measurement.name === "vertical_shift" || measurement.name === "deltaY");
  const hasWidth = measurements.some(measurement => measurement.name === "deltaWidth");
  const hasHeight = measurements.some(measurement => measurement.name === "deltaHeight");
  const values = (names: readonly string[]): number | undefined => {
    const measurement = measurements.find(candidate => names.includes(candidate.name));
    return typeof measurement?.value === "number" ? measurement.value : undefined;
  };
  const translation = hasX || hasY;
  const resize = hasWidth || hasHeight;
  if (translation && resize) return { kind: "mixed" };
  if (!translation && !resize) return { kind: "none" };
  if (translation && (!hasX || !hasY || values(["horizontal_shift", "deltaX"]) === undefined || values(["vertical_shift", "deltaY"]) === undefined)) {
    const invalid: { kind: "invalid"; x?: number; y?: number } = { kind: "invalid" };
    const x = values(["horizontal_shift", "deltaX"]);
    const y = values(["vertical_shift", "deltaY"]);
    if (x !== undefined) invalid.x = x;
    if (y !== undefined) invalid.y = y;
    return invalid;
  }
  if (resize && (!hasWidth || !hasHeight || values(["deltaWidth"]) === undefined || values(["deltaHeight"]) === undefined)) {
    const invalid: { kind: "invalid"; width?: number; height?: number } = { kind: "invalid" };
    const width = values(["deltaWidth"]);
    const height = values(["deltaHeight"]);
    if (width !== undefined) invalid.width = width;
    if (height !== undefined) invalid.height = height;
    return invalid;
  }
  return translation
    ? { kind: "translation", x: values(["horizontal_shift", "deltaX"])!, y: values(["vertical_shift", "deltaY"])! }
    : { kind: "resize", width: values(["deltaWidth"])!, height: values(["deltaHeight"])! };
}

function completeTranslation(measurement: StructuralMeasurementSignature): measurement is StructuralMeasurementSignature & { kind: "translation"; x: number; y: number } {
  return measurement.kind === "translation" && typeof measurement.x === "number" && typeof measurement.y === "number";
}

function completeResize(measurement: StructuralMeasurementSignature): measurement is StructuralMeasurementSignature & { kind: "resize"; width: number; height: number } {
  return measurement.kind === "resize" && typeof measurement.width === "number" && typeof measurement.height === "number";
}

function result(action: StructuralRelationAction, reason: StructuralRelationReason, displacementRelation: StructuralDisplacementRelation, measurementRelation: StructuralMeasurementRelation): StructuralRelationResult {
  return Object.freeze({ action, reason, displacementRelation, measurementRelation });
}

export function classifyStructuralRelation(input: StructuralRelationInput): StructuralRelationResult {
  if (input.parentFindingId === input.childFindingId) return result("unrelated", "same_finding", "not_applicable", "same");
  if (input.semanticRelation === "unrelated" || input.semanticRelation === "invalid") return result("unrelated", "no_semantic_relation", "not_applicable", "same");
  if (input.semanticRelation === "sibling") return result("retain_distinct", "sibling_boundary", "not_applicable", "same");
  if (!input.sameCriterion) return result("retain_distinct", "distinct_criterion", "not_applicable", "same");
  if (input.parentAreaRatio >= 0.3 || input.unionAreaRatio >= 0.3) return result("retain_distinct", "oversized_parent", "not_applicable", "same");
  if (input.childContainment < 0.7) return result("retain_distinct", "nonlocal", "not_applicable", "same");
  if (input.parentProjectionMismatchKind !== undefined && input.childProjectionMismatchKind !== undefined
    && input.parentProjectionMismatchKind !== input.childProjectionMismatchKind) {
    return result("retain_distinct", "distinct_projection_kind", "not_applicable", "distinct_projection_kind");
  }
  if (input.explicitFindingGroupId !== undefined && input.explicitFindingGroupKind !== undefined) {
    return result("suppress", "equivalent_explicit_group", "not_applicable", "explicit_equivalence");
  }

  const parent = input.parentMeasurement;
  const child = input.childMeasurement;
  if (parent.kind === "mixed" || parent.kind === "invalid" || child.kind === "mixed" || child.kind === "invalid") {
    return result("violation", "invalid_measurement_relation", "missing_measurement", "missing_measurement");
  }
  if ((parent.kind === "translation" && child.kind === "resize") || (parent.kind === "resize" && child.kind === "translation")) {
    return result("retain_distinct", "independent_geometry", "distinct_translation", "resize_vs_translation");
  }
  if (parent.kind === "none" && child.kind === "none") {
    return result("violation", "unexplained_nested_same_criterion", "missing_measurement", "missing_measurement");
  }
  if (parent.kind === "none" || child.kind === "none") {
    return result("violation", "invalid_measurement_relation", "missing_measurement", "missing_measurement");
  }
  if (completeTranslation(parent) && completeTranslation(child)) {
    const sameDirection = Math.sign(parent.x) === Math.sign(child.x) && Math.sign(parent.y) === Math.sign(child.y);
    const coherent = sameDirection && Math.abs(parent.x - child.x) <= 4 && Math.abs(parent.y - child.y) <= 4;
    return coherent
      ? result("suppress", "coherent_translation", "coherent_translation", "coherent_translation")
      : result("retain_distinct", "independent_geometry", "distinct_translation", "coherent_translation");
  }
  if (completeResize(parent) && completeResize(child)) {
    const coherent = Math.abs(parent.width - child.width) <= 4 && Math.abs(parent.height - child.height) <= 4;
    return coherent
      ? result("suppress", "coherent_resize", "not_applicable", "coherent_resize")
      : result("retain_distinct", "independent_geometry", "not_applicable", "distinct_resize");
  }
  return result("violation", "invalid_measurement_relation", "missing_measurement", "missing_measurement");
}

function freezeViolation(violation: StructuralValidationViolationRecord): StructuralValidationViolationRecord {
  return Object.freeze({
    ...violation,
    affectedGroupIds: freezeArray([...violation.affectedGroupIds].sort()),
    ...(violation.detail ? { detail: Object.freeze({ ...violation.detail }) } : {})
  });
}

function violationRecord(
  code: StructuralValidationViolation,
  decision: StructuralSuppressionDecision,
  detail?: StructuralValidationViolationRecord["detail"]
): StructuralValidationViolationRecord {
  return freezeViolation({
    code,
    suppressedFindingId: decision.suppressedFindingId,
    retainedFindingId: decision.retainedFindingId,
    affectedGroupIds: [...(decision.retainedGroupIds ?? (decision.retainedGroupId ? [decision.retainedGroupId] : []))],
    ...(detail ? { detail } : {})
  });
}

function relationViolationCode(relation: StructuralRelationResult): StructuralValidationViolation {
  switch (relation.reason) {
    case "sibling_boundary": return "sibling_boundary";
    case "oversized_parent":
    case "nonlocal": return "oversized_parent";
    case "invalid_measurement_relation": return "invalid_measurement_relation";
    case "unexplained_nested_same_criterion": return "unexplained_nested_same_criterion";
    default: return "missing_retained_lineage";
  }
}

function accountingViolation(
  issue: StructuralAccountingIssue,
  ids: Pick<StructuralValidationViolationRecord, "candidateId" | "suppressedFindingId" | "retainedFindingId" | "elementId"> = {},
  detail: Pick<NonNullable<StructuralValidationViolationRecord["detail"]>, "expectedRetainedCount" | "actualRetainedCount"> = {}
): StructuralValidationViolationRecord {
  return freezeViolation({
    code: "missing_retained_lineage",
    ...ids,
    affectedGroupIds: [],
    detail: { ...detail, accountingIssue: issue }
  });
}

function deriveSemanticRelation(
  parent: StructuralLedgerCandidate,
  child: StructuralLedgerCandidate,
  elementLineage: readonly StructuralElementLineage[]
): StructuralSemanticRelation {
  const parentIds = parent.elementIds ?? [];
  const childIds = child.elementIds ?? [];
  if (parentIds.length === 0 || childIds.length === 0) return "invalid";
  const lineage = new Map(elementLineage.map(item => [item.elementId, item]));
  if (parentIds.some(id => !lineage.has(id)) || childIds.some(id => !lineage.has(id))) return "invalid";
  const isAncestor = (ancestorId: string, descendantId: string): boolean => {
    const visited = new Set<string>();
    let current = lineage.get(descendantId);
    while (current?.parentId !== undefined && !visited.has(current.elementId)) {
      if (current.parentId === ancestorId) return true;
      visited.add(current.elementId);
      current = lineage.get(current.parentId);
    }
    return false;
  };
  if (parentIds.some(parentId => childIds.some(childId => parentId === childId || isAncestor(parentId, childId)))) return "descendant";
  const immediateParents = (id: string): string | undefined => lineage.get(id)?.parentId;
  if (parentIds.some(parentId => childIds.some(childId => {
    const parentParent = immediateParents(parentId);
    const childParent = immediateParents(childId);
    return parentParent !== undefined && parentParent === childParent;
  }))) return "sibling";
  return "unrelated";
}

function relationMatchesDecisionElements(
  relation: StructuralSemanticRelation,
  decision: StructuralSuppressionDecision,
  parent: StructuralLedgerCandidate,
  child: StructuralLedgerCandidate,
  elementLineage: readonly StructuralElementLineage[]
): boolean {
  const parentIds = parent.elementIds ?? [];
  const childIds = child.elementIds ?? [];
  if (decision.parentElementId !== undefined && !parentIds.includes(decision.parentElementId)) return false;
  if (decision.childElementId !== undefined && !childIds.includes(decision.childElementId)) return false;
  if (decision.parentElementId === undefined || decision.childElementId === undefined) return true;
  const lineage = new Map(elementLineage.map(item => [item.elementId, item]));
  const isAncestor = (ancestorId: string, descendantId: string): boolean => {
    const visited = new Set<string>();
    let current = lineage.get(descendantId);
    while (current?.parentId !== undefined && !visited.has(current.elementId)) {
      if (current.parentId === ancestorId) return true;
      visited.add(current.elementId);
      current = lineage.get(current.parentId);
    }
    return false;
  };
  if (relation === "descendant") return decision.parentElementId === decision.childElementId || isAncestor(decision.parentElementId, decision.childElementId);
  if (relation === "sibling") {
    const parentParent = lineage.get(decision.parentElementId)?.parentId;
    const childParent = lineage.get(decision.childElementId)?.parentId;
    return parentParent !== undefined && parentParent === childParent && !isAncestor(decision.parentElementId, decision.childElementId)
      && !isAncestor(decision.childElementId, decision.parentElementId);
  }
  return !isAncestor(decision.parentElementId, decision.childElementId) && !isAncestor(decision.childElementId, decision.parentElementId);
}

function validateElementLineage(lineage: readonly StructuralElementLineage[]): readonly StructuralValidationViolationRecord[] {
  const violations: StructuralValidationViolationRecord[] = [];
  const counts = new Map<string, number>();
  const ids = new Set(lineage.map(item => item.elementId));
  for (const item of lineage) counts.set(item.elementId, (counts.get(item.elementId) ?? 0) + 1);
  for (const [elementId, count] of counts) {
    if (count > 1) violations.push(accountingViolation("duplicate_element_lineage", { elementId }, { expectedRetainedCount: 1, actualRetainedCount: count }));
  }
  for (const item of lineage) {
    if (item.parentId !== undefined && !ids.has(item.parentId)) {
      violations.push(accountingViolation("dangling_parent_lineage", { elementId: item.elementId }));
    }
  }
  const parentById = new Map<string, string | undefined>();
  for (const item of lineage) if (!parentById.has(item.elementId)) parentById.set(item.elementId, item.parentId);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleIds = new Set<string>();
  const visit = (elementId: string): void => {
    if (visited.has(elementId)) return;
    if (visiting.has(elementId)) {
      cycleIds.add(elementId);
      return;
    }
    visiting.add(elementId);
    const parentId = parentById.get(elementId);
    if (parentId !== undefined && parentById.has(parentId)) visit(parentId);
    visiting.delete(elementId);
    visited.add(elementId);
  };
  for (const elementId of parentById.keys()) visit(elementId);
  for (const elementId of [...cycleIds].sort((a, b) => a.localeCompare(b))) {
    violations.push(accountingViolation("cyclic_element_lineage", { elementId }));
  }
  return freezeArray(violations);
}

export function validateStructuralConsolidationLedger(
  ledger: StructuralConsolidationLedger | undefined,
  options: { readonly requireGroups?: boolean } = {}
): StructuralLedgerValidation {
  if (!ledger) return Object.freeze({ status: "not_evaluated" as const, violations: freezeArray([]) });
  const violations: StructuralValidationViolationRecord[] = [...validateElementLineage(ledger.elementLineage ?? [])];
  const candidateCounts = new Map<string, number>();
  for (const candidate of ledger.candidates) candidateCounts.set(candidate.findingId, (candidateCounts.get(candidate.findingId) ?? 0) + 1);
  const candidateIds = new Set(ledger.candidates.map(candidate => candidate.findingId));
  for (const [candidateId, count] of candidateCounts) {
    if (count > 1) violations.push(accountingViolation("duplicate_candidate", { candidateId }, { expectedRetainedCount: 1, actualRetainedCount: count }));
  }
  const retainedIds = new Set(ledger.retainedFindingIds);
  const retainedCounts = new Map<string, number>();
  for (const retainedId of ledger.retainedFindingIds) retainedCounts.set(retainedId, (retainedCounts.get(retainedId) ?? 0) + 1);
  for (const [retainedId, count] of retainedCounts) {
    if (count > 1) violations.push(accountingViolation("duplicate_retained_id", { candidateId: retainedId }, { expectedRetainedCount: 1, actualRetainedCount: count }));
    if (!candidateIds.has(retainedId)) violations.push(accountingViolation("retained_id_without_candidate", { candidateId: retainedId }));
  }
  const terminalCounts = new Map<string, number>();
  const terminalByCandidate = new Map<string, StructuralCandidateTerminalRecord>();
  for (const terminal of ledger.candidateTerminals) {
    terminalCounts.set(terminal.candidateId, (terminalCounts.get(terminal.candidateId) ?? 0) + 1);
    if (!candidateIds.has(terminal.candidateId)) {
      violations.push(accountingViolation("unknown_terminal", { candidateId: terminal.candidateId }));
      continue;
    }
    if (terminalByCandidate.has(terminal.candidateId)) {
      violations.push(accountingViolation("duplicate_terminal", { candidateId: terminal.candidateId }, { expectedRetainedCount: 1, actualRetainedCount: terminalCounts.get(terminal.candidateId)! }));
    } else {
      terminalByCandidate.set(terminal.candidateId, terminal);
    }
    if (terminal.terminal === "retained" && !retainedIds.has(terminal.candidateId)) {
      violations.push(accountingViolation("retained_terminal_not_retained", { candidateId: terminal.candidateId }));
    }
  }
  for (const candidate of ledger.candidates) {
    const count = terminalCounts.get(candidate.findingId) ?? 0;
    if (count === 0) violations.push(accountingViolation("retained_id_without_terminal", { candidateId: candidate.findingId }, { expectedRetainedCount: 1, actualRetainedCount: count }));
  }
  for (const retainedId of retainedIds) {
    const terminal = terminalByCandidate.get(retainedId);
    if (!terminal || terminal.terminal !== "retained") {
      violations.push(accountingViolation("retained_id_without_terminal", { candidateId: retainedId }));
    }
  }
  for (const candidate of ledger.candidates) {
    const broadEligible = candidate.classificationSource === "vlm_reviewed" && candidate.repairLocality === "broad";
    if (!broadEligible) continue;
    const terminal = terminalByCandidate.get(candidate.findingId);
    const decisions = ledger.decisions.filter(decision => decision.suppressedFindingId === candidate.findingId);
    if (retainedIds.has(candidate.findingId) && terminal?.terminal !== "broad_excluded") {
      violations.push(accountingViolation("broad_has_retained", { candidateId: candidate.findingId }));
    }
    if (decisions.length > 0 && terminal?.terminal !== "broad_excluded") {
      violations.push(accountingViolation("broad_has_decision", { candidateId: candidate.findingId }, { expectedRetainedCount: 0, actualRetainedCount: decisions.length }));
    }
  }
  const decisionsBySuppressed = new Map<string, StructuralSuppressionDecision[]>();
  for (const decision of ledger.decisions) {
    const existing = decisionsBySuppressed.get(decision.suppressedFindingId) ?? [];
    existing.push(decision);
    decisionsBySuppressed.set(decision.suppressedFindingId, existing);
  }
  for (const [suppressedFindingId, decisions] of decisionsBySuppressed) {
    if (decisions.length > 1) violations.push(accountingViolation("duplicate_decision", { suppressedFindingId }, { expectedRetainedCount: 1, actualRetainedCount: decisions.length }));
  }
  const allowedSuppressReasons = new Set(["equivalent_explicit_group", "coherent_translation", "coherent_resize"]);
  for (const decision of ledger.decisions) {
    const suppressedCandidate = ledger.candidates.find(candidate => candidate.findingId === decision.suppressedFindingId);
    const retainedCandidate = ledger.candidates.find(candidate => candidate.findingId === decision.retainedFindingId);
    const broadTerminal = terminalByCandidate.get(decision.suppressedFindingId)?.terminal === "broad_excluded";
    if (!suppressedCandidate || !retainedCandidate || !retainedIds.has(decision.retainedFindingId)) {
      violations.push(accountingViolation("unknown_decision_id", {
        suppressedFindingId: decision.suppressedFindingId,
        retainedFindingId: decision.retainedFindingId
      }));
      continue;
    }
    if (retainedIds.has(decision.suppressedFindingId)) violations.push(accountingViolation("decision_for_retained_candidate", {
      suppressedFindingId: decision.suppressedFindingId,
      retainedFindingId: decision.retainedFindingId
    }));
    const broadEligible = suppressedCandidate.classificationSource === "vlm_reviewed" && suppressedCandidate.repairLocality === "broad";
    if (broadTerminal || broadEligible) violations.push(accountingViolation("decision_for_broad_candidate", {
      suppressedFindingId: decision.suppressedFindingId,
      retainedFindingId: decision.retainedFindingId
    }));
    const actualSameCriterion = suppressedCandidate.criterion === retainedCandidate.criterion;
    if (decision.criterion !== retainedCandidate.criterion || decision.sameCriterion !== actualSameCriterion) {
      violations.push(accountingViolation("decision_criterion_mismatch", {
        suppressedFindingId: decision.suppressedFindingId,
        retainedFindingId: decision.retainedFindingId
      }));
    }
  const elementLineage = ledger.elementLineage ?? [];
    const derivedSemanticRelation = deriveSemanticRelation(retainedCandidate, suppressedCandidate, elementLineage);
    const semanticFactsMatch = decision.semanticRelation === derivedSemanticRelation
      && decision.semanticDescendant === (derivedSemanticRelation === "descendant")
      && relationMatchesDecisionElements(derivedSemanticRelation, decision, retainedCandidate, suppressedCandidate, elementLineage);
    if (!semanticFactsMatch) {
      violations.push(accountingViolation("decision_semantic_relation_mismatch", {
        suppressedFindingId: decision.suppressedFindingId,
        retainedFindingId: decision.retainedFindingId
      }));
    }
    const relation = classifyStructuralRelation({
      parentFindingId: decision.retainedFindingId,
      childFindingId: decision.suppressedFindingId,
      ...(decision.parentElementId ? { parentElementId: decision.parentElementId } : {}),
      ...(decision.childElementId ? { childElementId: decision.childElementId } : {}),
      criterion: retainedCandidate.criterion,
      sameCriterion: actualSameCriterion,
      semanticRelation: derivedSemanticRelation,
      parentBox: { x: 0, y: 0, width: 1, height: 1 },
      childBox: { x: 0, y: 0, width: 1, height: 1 },
      unionBox: { x: 0, y: 0, width: 1, height: 1 },
      canvas: { width: 1, height: 1 },
      parentAreaRatio: decision.parentAreaRatio,
      unionAreaRatio: decision.locality,
      childContainment: decision.childContainment,
      ...(decision.parentProjectionMismatchKind ? { parentProjectionMismatchKind: decision.parentProjectionMismatchKind } : {}),
      ...(decision.childProjectionMismatchKind ? { childProjectionMismatchKind: decision.childProjectionMismatchKind } : {}),
      ...(decision.explicitFindingGroupId ? { explicitFindingGroupId: decision.explicitFindingGroupId } : {}),
      ...(decision.explicitFindingGroupKind ? { explicitFindingGroupKind: decision.explicitFindingGroupKind } : {}),
      parentMeasurement: decision.parentMeasurement,
      childMeasurement: decision.childMeasurement
    });
    const decisionIds = {
      suppressedFindingId: decision.suppressedFindingId,
      retainedFindingId: decision.retainedFindingId
    } as const;
    if (decision.action !== relation.action) violations.push(accountingViolation("decision_action_mismatch", decisionIds));
    if (decision.reason !== relation.reason) violations.push(accountingViolation("decision_reason_mismatch", decisionIds));
    if (decision.semanticDescendant !== (decision.semanticRelation === "descendant")) {
      violations.push(accountingViolation("decision_semantic_descendant_mismatch", decisionIds));
    }
    if (decision.displacementRelation !== relation.displacementRelation) {
      violations.push(accountingViolation("decision_displacement_mismatch", decisionIds));
    }
    if (decision.measurementRelation !== relation.measurementRelation) {
      violations.push(accountingViolation("decision_measurement_mismatch", decisionIds));
    }
    const terminal = terminalByCandidate.get(decision.suppressedFindingId);
    if (terminal?.terminal === "suppressed_to_retained") {
      if (decision.action !== "suppress") violations.push(accountingViolation("suppressed_mismatched_decision", {
        suppressedFindingId: decision.suppressedFindingId,
        retainedFindingId: decision.retainedFindingId
      }));
      if (terminal.retainedFindingId !== decision.retainedFindingId) violations.push(accountingViolation("suppressed_mismatched_decision", {
        suppressedFindingId: decision.suppressedFindingId,
        retainedFindingId: decision.retainedFindingId
      }));
    }
    if (decision.action !== "suppress" && !retainedIds.has(decision.suppressedFindingId) && !broadTerminal) {
      violations.push(accountingViolation("terminal_violation", {
        suppressedFindingId: decision.suppressedFindingId,
        retainedFindingId: decision.retainedFindingId
      }));
    }
    if (decision.action === "suppress") {
      const compatible = relation.action === "suppress"
        && allowedSuppressReasons.has(relation.reason)
        && decision.measurementRelation === relation.measurementRelation;
      if (!compatible) violations.push(violationRecord(relationViolationCode(relation), decision));
    }
    if (options.requireGroups) {
      const groups = decision.retainedGroupIds ?? (decision.retainedGroupId ? [decision.retainedGroupId] : []);
      if (groups.length === 0) violations.push(violationRecord("missing_retained_group", decision));
      if (groups.length > 1) violations.push(violationRecord("ambiguous_retained_group", decision));
    }
  }
  for (const terminal of ledger.candidateTerminals) {
    if (terminal.terminal === "violation") {
      violations.push(freezeViolation({
        code: terminal.violationCode ?? "missing_retained_lineage",
        candidateId: terminal.candidateId,
        affectedGroupIds: [],
        detail: {
          ...(terminal.detail ?? {}),
          accountingIssue: terminal.detail?.accountingIssue ?? "terminal_violation"
        }
      }));
    }
    if (terminal.terminal === "broad_excluded") {
      const candidate = ledger.candidates.find(item => item.findingId === terminal.candidateId);
      const decisions = decisionsBySuppressed.get(terminal.candidateId) ?? [];
      const broadEligible = candidate?.classificationSource === "vlm_reviewed" && candidate.repairLocality === "broad";
      if (terminal.exclusionReason !== "broad_vlm_evidence" || !broadEligible) {
        violations.push(accountingViolation("broad_ineligible", { candidateId: terminal.candidateId }));
      }
      if (retainedIds.has(terminal.candidateId)) violations.push(accountingViolation("broad_has_retained", { candidateId: terminal.candidateId }));
      if (decisions.length > 0) violations.push(accountingViolation("broad_has_decision", { candidateId: terminal.candidateId }, { expectedRetainedCount: 0, actualRetainedCount: decisions.length }));
    }
    if (terminal.terminal === "suppressed_to_retained") {
      const decisions = decisionsBySuppressed.get(terminal.candidateId) ?? [];
      const retainedFindingId = terminal.retainedFindingId;
      const matching = retainedFindingId === undefined
        ? []
        : decisions.filter(decision => decision.action === "suppress" && decision.retainedFindingId === retainedFindingId);
      if (retainedFindingId === undefined || matching.length === 0) violations.push(accountingViolation("suppressed_missing_decision", {
        suppressedFindingId: terminal.candidateId,
        ...(retainedFindingId !== undefined ? { retainedFindingId } : {})
      }));
      if (matching.length > 1 || decisions.length > 1) violations.push(accountingViolation("duplicate_decision", {
        suppressedFindingId: terminal.candidateId,
        ...(retainedFindingId !== undefined ? { retainedFindingId } : {})
      }, { expectedRetainedCount: 1, actualRetainedCount: decisions.length }));
      if (matching.length === 0 && decisions.length > 0) violations.push(accountingViolation("suppressed_mismatched_decision", {
        suppressedFindingId: terminal.candidateId,
        ...(retainedFindingId !== undefined ? { retainedFindingId } : {})
      }));
    }
  }
  const sorted = violations.sort((a, b) => a.code.localeCompare(b.code)
    || (a.detail?.accountingIssue ?? "").localeCompare(b.detail?.accountingIssue ?? "")
    || (a.candidateId ?? "").localeCompare(b.candidateId ?? "")
    || (a.suppressedFindingId ?? "").localeCompare(b.suppressedFindingId ?? "")
    || (a.retainedFindingId ?? "").localeCompare(b.retainedFindingId ?? ""));
  return Object.freeze({ status: sorted.length > 0 ? "fail" as const : "pass" as const, violations: freezeArray(sorted) });
}
