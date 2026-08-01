import type { Box, DiffRecord, ElementPair, GeometryDiagnosticReference, UiElement } from "../schemas/core.js";
import { resolveComparisonBox } from "../images/comparison-geometry.js";
import type { ImagePairTransform } from "../images/coordinates.js";
import { intersect } from "../signals/geometry.js";
import { isStructuralContainer } from "./structural-container.js";
import {
  classifyStructuralRelation,
  buildCandidateTerminalRecords,
  freezeStructuralLedger,
  measurementSignature,
  type StructuralConsolidationLedger,
  type StructuralRelationInput,
  type StructuralSuppressionDecision
} from "./structural-invariants.js";
const MAX_REPAIR_PARENT_AREA_RATIO = 0.3;

interface OwnedFinding {
  finding: DiffRecord;
  parent?: UiElement;
  targetIds: string[];
  fallbackKey: string;
}

interface StructuralMergeContext {
  candidateById: Map<string, DiffRecord>;
  elements: Map<string, UiElement>;
  pairMap: Map<string, ElementPair>;
  viewportArea: number;
}

export interface FindingConsolidationContext {
  canvas: { width: number; height: number };
  imagePairTransform?: ImagePairTransform;
  geometryRejections?: GeometryDiagnosticReference[];
}

export interface FindingFinalization {
  diffs: DiffRecord[];
  broadVlmFindings: DiffRecord[];
  structuralLedger: StructuralConsolidationLedger;
}

function boxArea(box: Box): number {
  return box.width * box.height;
}

function strongOverlap(a: Box, b: Box): boolean {
  const overlap = intersect(a, b);
  if (!overlap) return false;
  return (overlap.width * overlap.height) / Math.min(boxArea(a), boxArea(b)) >= 0.7;
}

function comparableScale(a: Box, b: Box): boolean {
  return Math.max(boxArea(a), boxArea(b)) / Math.max(1, Math.min(boxArea(a), boxArea(b))) <= 8;
}

function centerDistanceRatio(a: Box, b: Box): number {
  const distance = Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
  return distance / Math.max(a.width, a.height, b.width, b.height, 1);
}

function localUnion(a: Box, b: Box, viewportArea: number): boolean {
  const union = unionBoxes([a, b]);
  return (strongOverlap(a, b) || centerDistanceRatio(a, b) <= 1.5)
    && boxArea(union) / Math.max(1, viewportArea) < MAX_REPAIR_PARENT_AREA_RATIO
    && boxArea(union) <= Math.max(1, boxArea(a) + boxArea(b)) * 3;
}

function displacement(finding: DiffRecord): { x: number; y: number } | undefined {
  const horizontal = finding.measurements.find(measurement => measurement.name === "horizontal_shift" || measurement.name === "deltaX")?.value;
  const vertical = finding.measurements.find(measurement => measurement.name === "vertical_shift" || measurement.name === "deltaY")?.value;
  if (typeof horizontal !== "number" || typeof vertical !== "number") return undefined;
  return { x: horizontal, y: vertical };
}

function coherentDisplacement(a: DiffRecord, b: DiffRecord, tolerance = 4): boolean {
  const first = displacement(a);
  const second = displacement(b);
  if (!first || !second) return false;
  return Math.sign(first.x) === Math.sign(second.x)
    && Math.sign(first.y) === Math.sign(second.y)
    && Math.abs(first.x - second.x) <= tolerance
    && Math.abs(first.y - second.y) <= tolerance;
}

function hasSharedTarget(a: OwnedFinding, b: OwnedFinding): boolean {
  const aTargets = new Set([...a.targetIds, ...(a.finding.targetIds ?? [])]);
  return [...b.targetIds, ...(b.finding.targetIds ?? [])].some(targetId => aTargets.has(targetId));
}

function sourceIdsForFinding(finding: DiffRecord): string[] {
  return [...new Set([finding.id, ...(finding.childFindingIds ?? [])])].sort((a, b) => a.localeCompare(b));
}

function sourceRootForMerge(findings: readonly DiffRecord[], context: StructuralMergeContext): DiffRecord | undefined {
  const sourceIds = [...new Set(findings.flatMap(sourceIdsForFinding))].sort((a, b) => a.localeCompare(b));
  if (sourceIds.length === 0) return undefined;
  const sources = sourceIds
    .map(id => context.candidateById.get(id))
    .filter((finding): finding is DiffRecord => finding !== undefined);
  if (sources.length !== sourceIds.length) return undefined;
  return sources.find(root => sources.every(other => root.id === other.id || classifyStructuralRelation(
    structuralRelationInput(root, other, context.elements, context.pairMap, context.viewportArea)
  ).action === "suppress"));
}

function sourceRootAllowsMerge(findings: readonly DiffRecord[], context: StructuralMergeContext): boolean {
  return sourceRootForMerge(findings, context) !== undefined;
}

function sourceRootAllowsOwnedMerge(groups: readonly OwnedFinding[], context: StructuralMergeContext): boolean {
  return sourceRootAllowsMerge(groups.map(entry => entry.finding), context);
}

function unionBoxes(boxes: Box[]): Box {
  const x = Math.min(...boxes.map(box => box.x));
  const y = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width));
  const bottom = Math.max(...boxes.map(box => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

function hasValidGeometry(element: UiElement): boolean {
  return Number.isFinite(element.box.x) && Number.isFinite(element.box.y)
    && Number.isFinite(element.box.width) && Number.isFinite(element.box.height)
    && element.box.width > 0 && element.box.height > 0;
}

function validStructuralChildCount(element: UiElement, elements: Map<string, UiElement>): number {
  const childIds = new Set(element.childIds);
  for (const child of elements.values()) {
    if (child.parentId === element.id) childIds.add(child.id);
  }
  return [...childIds].filter(childId => {
    const child = elements.get(childId);
    return child !== undefined && hasValidGeometry(child);
  }).length;
}

function eligibleParent(element: UiElement, elements: Map<string, UiElement>): boolean {
  return isStructuralContainer(element, validStructuralChildCount(element, elements));
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function estimateOwnershipCanvas(elements: UiElement[]): { width: number; height: number } {
  const inferredWidths = elements
    .flatMap(element => element.normalizedBox.width > 0
      ? [element.box.width / element.normalizedBox.width]
      : [])
    .filter(width => width > 0 && Number.isFinite(width));
  const inferredHeights = elements
    .flatMap(element => element.normalizedBox.height > 0
      ? [element.box.height / element.normalizedBox.height]
      : [])
    .filter(height => height > 0 && Number.isFinite(height));
  const right = Math.max(1, ...elements.map(element => element.box.x + element.box.width));
  const bottom = Math.max(1, ...elements.map(element => element.box.y + element.box.height));
  return {
    width: median(inferredWidths) ?? right,
    height: median(inferredHeights) ?? bottom
  };
}

function projectElementBoxToCanvas(element: UiElement, canvas: { width: number; height: number }): Box {
  return {
    x: element.normalizedBox.x * canvas.width,
    y: element.normalizedBox.y * canvas.height,
    width: element.normalizedBox.width * canvas.width,
    height: element.normalizedBox.height * canvas.height
  };
}

function projectElementsToCanvas(elements: UiElement[], canvas: { width: number; height: number }): UiElement[] {
  return elements.map(element => ({
    ...element,
    box: projectElementBoxToCanvas(element, canvas)
  }));
}

function isOversizedRepairParent(element: UiElement): boolean {
  return boxArea(element.normalizedBox) >= MAX_REPAIR_PARENT_AREA_RATIO;
}

function ascendToSemanticParent(element: UiElement, elements: Map<string, UiElement>): UiElement | undefined {
  let current: UiElement | undefined = element;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (eligibleParent(current, elements)) return current;
    current = current.parentId ? elements.get(current.parentId) : undefined;
  }
  return undefined;
}

function overlappingSemanticParent(finding: DiffRecord, elements: UiElement[]): UiElement | undefined {
  const elementMap = new Map(elements.map(element => [element.id, element]));
  return elements
    .filter(element => eligibleParent(element, elementMap))
    .filter(element => !isOversizedRepairParent(element))
    .map(element => ({ element, overlap: intersect(finding.location, element.box) }))
    .filter((entry): entry is { element: UiElement; overlap: Box } => entry.overlap !== undefined && entry.overlap !== null)
    .filter(entry => boxArea(entry.overlap) / boxArea(finding.location) >= 0.5)
    .sort((a, b) => boxArea(a.element.box) - boxArea(b.element.box) || a.element.id.localeCompare(b.element.id))[0]?.element;
}

function resolveOwnership(
  finding: DiffRecord,
  elements: UiElement[],
  elementMap: Map<string, UiElement>,
  pairMap: Map<string, ElementPair>
): OwnedFinding {
  const pair = finding.pairId ? pairMap.get(finding.pairId) : undefined;
  const pairTargets = [pair?.expectedId, pair?.actualId].filter((id): id is string => id !== undefined);
  const targetIds = [...new Set([...(finding.targetIds ?? []), ...pairTargets])];
  const semanticParents = targetIds
    .map(id => elementMap.get(id))
    .filter((element): element is UiElement => element !== undefined)
    .map(element => ascendToSemanticParent(element, elementMap))
    .filter((element): element is UiElement => element !== undefined)
    .filter(element => !isOversizedRepairParent(element))
    .sort((a, b) => {
      const sourceRank = (element: UiElement) => element.source === "projected" ? 1 : 0;
      return sourceRank(a) - sourceRank(b) || boxArea(a.box) - boxArea(b.box) || a.id.localeCompare(b.id);
    });
  const parent = semanticParents[0] ?? (targetIds.length === 0 ? overlappingSemanticParent(finding, elements) : undefined);
  if (parent && !targetIds.includes(parent.id)) targetIds.push(parent.id);
  return {
    finding,
    ...(parent ? { parent } : {}),
    targetIds,
    fallbackKey: `${finding.pairId ?? finding.id}:${finding.criterion}`
  };
}

function mergeGroup(group: OwnedFinding[], context?: StructuralMergeContext): DiffRecord {
  const severityRank = { low: 0, medium: 1, high: 2 } as const;
  const reviewRank = { rejected: 0, not_reviewed: 1, accepted: 2, needs_escalation: 3 } as const;
  const primaryRank = (entry: OwnedFinding): number => {
    if (entry.finding.scopeKind) return 3;
    if (entry.finding.classificationSource === "vlm_reviewed") return 2;
    if (entry.finding.findingGroupKind) return 1;
    return 0;
  };
  const structuralRoot = context === undefined ? undefined : sourceRootForMerge(group.map(entry => entry.finding), context);
  const structuralRootEntry = structuralRoot === undefined
    ? undefined
    : group.find(entry => sourceIdsForFinding(entry.finding).includes(structuralRoot.id));
  const primary = structuralRootEntry ?? group.reduce((best, current) => {
    const severityDelta = severityRank[current.finding.severity] - severityRank[best.finding.severity];
    if (severityDelta !== 0) return severityDelta > 0 ? current : best;
    return primaryRank(current) > primaryRank(best) ? current : best;
  });
  const parent = group[0]?.parent;
  const allFindings = group.map(entry => entry.finding);
  const artifacts = new Map<string, NonNullable<DiffRecord["artifactPaths"]>[number]>();
  for (const artifact of allFindings.flatMap(finding => finding.artifactPaths)) {
    artifacts.set(`${artifact.role}:${artifact.path}`, artifact);
  }
  const measurements = new Map<string, NonNullable<DiffRecord["measurements"]>[number]>();
  for (const measurement of allFindings.flatMap(finding => finding.measurements)) {
    measurements.set(JSON.stringify(measurement), measurement);
  }
  const reviewerStatus = allFindings.reduce((best, finding) =>
    reviewRank[finding.reviewerStatus] > reviewRank[best] ? finding.reviewerStatus : best,
  allFindings[0]!.reviewerStatus);
  const childFindingIds = [...new Set(allFindings.flatMap(finding => [finding.id, ...(finding.childFindingIds ?? [])]))]
    .filter(id => id !== primary.finding.id)
    .sort((a, b) => a.localeCompare(b));
  const targetIds = [...new Set(group.flatMap(entry => [...entry.targetIds, ...(entry.finding.targetIds ?? [])]))];
  const criterionLabel = primary.finding.criterion.replaceAll("_", " ");
  const coverageLocations = new Map<string, Box>();
  for (const location of allFindings.flatMap(finding => finding.coverageLocations ?? [finding.location])) {
    coverageLocations.set(JSON.stringify(location), location);
  }
  const explicitDisplacementGroup = primary.finding.findingGroupKind === "coherent_displacement";
  const explicitStructuralGroup = primary.finding.findingGroupKind === "structural_region_mismatch";

  return {
    ...primary.finding,
    title: explicitDisplacementGroup
      ? `${primary.finding.groupLabel ?? "UI region"} displaced from expected position`
      : explicitStructuralGroup
        ? `${primary.finding.groupLabel ?? "UI region"} layout differs from expected`
      : parent ? `${parent.label}: ${criterionLabel}` : primary.finding.title,
    location: unionBoxes(allFindings.map(finding => finding.location)),
    coverageLocations: [...coverageLocations.values()],
    severity: primary.finding.severity,
    evidence: [...new Set(allFindings.flatMap(finding => finding.evidence))],
    measurements: [...measurements.values()],
    artifactPaths: [...artifacts.values()],
    childFindingIds,
    targetIds,
    reviewerStatus
  };
}

function shouldMergeOwnedGroups(a: OwnedFinding[], b: OwnedFinding[]): boolean {
  return a.some(aEntry => b.some(bEntry =>
    aEntry.finding.criterion === bEntry.finding.criterion &&
    hasSharedTarget(aEntry, bEntry) &&
    comparableScale(aEntry.finding.location, bEntry.finding.location) &&
    strongOverlap(aEntry.finding.location, bEntry.finding.location)
  ));
}

function mergeOverlappingOwnedGroups(groups: OwnedFinding[][], context: StructuralMergeContext): OwnedFinding[][] {
  const merged: OwnedFinding[][] = [];
  for (const group of groups) {
    const existing = merged.find(candidate => shouldMergeOwnedGroups(candidate, group)
      && sourceRootAllowsOwnedMerge([...candidate, ...group], context));
    if (existing) {
      existing.push(...group);
    } else {
      merged.push([...group]);
    }
  }
  return merged;
}

function shouldMergeFinalFindings(a: DiffRecord, b: DiffRecord): boolean {
  const aTargets = new Set(a.targetIds ?? []);
  const sharedTarget = (b.targetIds ?? []).some(targetId => aTargets.has(targetId));
  return sharedTarget && a.criterion === b.criterion && strongOverlap(a.location, b.location);
}

function mergeFinalFindingGroup(group: DiffRecord[], context: StructuralMergeContext): DiffRecord {
  const merged = mergeGroup(group.map(finding => ({
    finding,
    targetIds: finding.targetIds ?? [],
    fallbackKey: `${finding.id}:${finding.criterion}`
  })), context);
  const retainedFindingIds = [...new Set(merged.childFindingIds ?? group.map(finding => finding.id))]
    .filter(id => id !== merged.id)
    .sort((a, b) => a.localeCompare(b));
  return {
    ...merged,
    ...(retainedFindingIds.length > 0 ? {
      suppression: {
        reason: "duplicate_child_of_group" as const,
        retainedFindingIds
      }
    } : {})
  };
}

function mergeFinalDuplicateFindings(findings: DiffRecord[], context: StructuralMergeContext): DiffRecord[] {
  const groups: DiffRecord[][] = [];
  for (const finding of findings) {
    const existing = groups.find(group => group.some(candidate => shouldMergeFinalFindings(candidate, finding))
      && sourceRootAllowsMerge([...group, finding], context));
    if (existing) {
      existing.push(finding);
    } else {
      groups.push([finding]);
    }
  }
  return groups.map(group => group.length === 1 ? group[0]! : mergeFinalFindingGroup(group, context));
}

const LAYOUT_CRITERIA = new Set<DiffRecord["criterion"]>([
  "geometry",
  "spacing_alignment",
  "chart_special_geometry"
]);

function isLayoutFinding(finding: DiffRecord): boolean {
  return LAYOUT_CRITERIA.has(finding.criterion);
}

function containedRatio(inner: Box, outer: Box): number {
  const overlap = intersect(inner, outer);
  return overlap ? boxArea(overlap) / boxArea(inner) : 0;
}

function isDescendantOf(childId: string, parentId: string, elements: Map<string, UiElement>): boolean {
  let current = elements.get(childId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === parentId) return true;
    visited.add(current.id);
    current = current.parentId ? elements.get(current.parentId) : undefined;
  }
  return false;
}

function targetIdsForFinding(finding: DiffRecord, pairMap: Map<string, ElementPair>): string[] {
  const pair = finding.pairId ? pairMap.get(finding.pairId) : undefined;
  return [...new Set([
    ...(finding.targetIds ?? []),
    ...(pair?.expectedId ? [pair.expectedId] : []),
    ...(pair?.actualId ? [pair.actualId] : [])
  ])];
}

function structuralRelationInput(
  parent: DiffRecord,
  child: DiffRecord,
  elements: Map<string, UiElement>,
  pairMap: Map<string, ElementPair>,
  viewportArea: number
): StructuralRelationInput {
  const parentTargets = targetIdsForFinding(parent, pairMap);
  const childTargets = targetIdsForFinding(child, pairMap);
  let semanticRelation: StructuralRelationInput["semanticRelation"] = "unrelated";
  let parentElementId: string | undefined;
  let childElementId: string | undefined;
  for (const parentId of parentTargets) {
    for (const childId of childTargets) {
      const parentElement = elements.get(parentId);
      const childElement = elements.get(childId);
      if (!parentElement || !childElement) continue;
      if (parentId === childId) {
        semanticRelation = "descendant";
        parentElementId = parentId;
        childElementId = childId;
        continue;
      }
      if (isDescendantOf(childId, parentId, elements)) {
        semanticRelation = "descendant";
        parentElementId = parentId;
        childElementId = childId;
        continue;
      }
      if (parentElement.parentId !== undefined && parentElement.parentId === childElement.parentId) {
        if (semanticRelation === "unrelated") semanticRelation = "sibling";
        parentElementId ??= parentId;
        childElementId ??= childId;
      }
    }
  }
  const unionBox = unionBoxes([parent.location, child.location]);
  const explicitGroup = parent.findingGroupId !== undefined
    && parent.findingGroupKind !== undefined
    && parent.findingGroupId === child.findingGroupId
    && parent.findingGroupKind === child.findingGroupKind;
  const explicitGroupFields: Pick<StructuralRelationInput, "explicitFindingGroupId" | "explicitFindingGroupKind"> = explicitGroup
    ? { explicitFindingGroupId: parent.findingGroupId!, explicitFindingGroupKind: parent.findingGroupKind! }
    : {};
  return {
    parentFindingId: parent.id,
    childFindingId: child.id,
    ...(parentElementId ? { parentElementId } : {}),
    ...(childElementId ? { childElementId } : {}),
    criterion: parent.criterion,
    sameCriterion: parent.criterion === child.criterion,
    semanticRelation,
    parentBox: parent.location,
    childBox: child.location,
    unionBox,
    canvas: { width: Math.sqrt(viewportArea), height: Math.sqrt(viewportArea) },
    parentAreaRatio: boxArea(parent.location) / Math.max(1, viewportArea),
    unionAreaRatio: boxArea(unionBox) / Math.max(1, viewportArea),
    childContainment: containedRatio(child.location, parent.location),
    ...(parent.projectionMismatchKind && child.projectionMismatchKind
      ? { parentProjectionMismatchKind: parent.projectionMismatchKind, childProjectionMismatchKind: child.projectionMismatchKind }
      : {}),
    ...explicitGroupFields,
    parentMeasurement: measurementSignature(parent.measurements),
    childMeasurement: measurementSignature(child.measurements)
  };
}

function parentExplainsChildLayout(
  parent: DiffRecord,
  child: DiffRecord,
  elements: Map<string, UiElement>,
  pairMap: Map<string, ElementPair>,
  viewportArea: number,
  mergeContext?: StructuralMergeContext
): boolean {
  if (!isLayoutFinding(parent) || parent.criterion !== child.criterion || boxArea(parent.location) <= boxArea(child.location)) return false;
  if (mergeContext !== undefined && !sourceRootAllowsMerge([parent, child], mergeContext)) return false;
  return classifyStructuralRelation(structuralRelationInput(parent, child, elements, pairMap, viewportArea)).action === "suppress";
}

function mergeChildIntoParent(parent: DiffRecord, children: DiffRecord[]): DiffRecord {
  const allFindings = [parent, ...children];
  const artifacts = new Map<string, NonNullable<DiffRecord["artifactPaths"]>[number]>();
  for (const artifact of allFindings.flatMap(finding => finding.artifactPaths)) {
    artifacts.set(`${artifact.role}:${artifact.path}`, artifact);
  }
  const measurements = new Map<string, NonNullable<DiffRecord["measurements"]>[number]>();
  for (const measurement of allFindings.flatMap(finding => finding.measurements)) {
    measurements.set(JSON.stringify(measurement), measurement);
  }
  const coverageLocations = new Map<string, Box>();
  for (const location of allFindings.flatMap(finding => finding.coverageLocations ?? [finding.location])) {
    coverageLocations.set(JSON.stringify(location), location);
  }
  const targetIds = [...new Set(allFindings.flatMap(finding => finding.targetIds ?? []))];
  const childFindingIds = [...new Set(allFindings.flatMap(finding => [finding.id, ...(finding.childFindingIds ?? [])]))]
    .filter(id => id !== parent.id)
    .sort((a, b) => a.localeCompare(b));
  const reviewRank = { rejected: 0, not_reviewed: 1, accepted: 2, needs_escalation: 3 } as const;
  const reviewerStatus: DiffRecord["reviewerStatus"] = parent.reviewerStatus === "rejected"
    ? "rejected"
    : allFindings.reduce<DiffRecord["reviewerStatus"]>((best, finding) =>
      reviewRank[finding.reviewerStatus] > reviewRank[best] ? finding.reviewerStatus : best,
    parent.reviewerStatus);
  const retainedFindingIds = [...new Set(childFindingIds)]
    .filter(id => id !== parent.id)
    .sort((a, b) => a.localeCompare(b));

  return {
    ...parent,
    evidence: [...new Set(allFindings.flatMap(finding => finding.evidence))],
    measurements: [...measurements.values()],
    artifactPaths: [...artifacts.values()],
    coverageLocations: [...coverageLocations.values()],
    childFindingIds,
    targetIds,
    reviewerStatus,
    ...(retainedFindingIds.length > 0 ? {
      suppression: {
        reason: "duplicate_child_of_group" as const,
        retainedFindingIds
      }
    } : {})
  };
}

export function selectSuppressionParent(
  candidates: DiffRecord[],
  child: DiffRecord,
  elements: UiElement[],
  pairs: ElementPair[],
  viewportArea: number,
  mergeContext?: StructuralMergeContext
): DiffRecord | undefined {
  const elementMap = new Map(elements.map(element => [element.id, element]));
  const pairMap = new Map(pairs.map(pair => [pair.id, pair]));
  return candidates
    .filter(isLayoutFinding)
    .sort((a, b) => boxArea(b.location) - boxArea(a.location) || a.id.localeCompare(b.id))
    .find(candidate => candidate.id !== child.id && parentExplainsChildLayout(candidate, child, elementMap, pairMap, viewportArea, mergeContext));
}

function suppressLayoutChildrenCoveredByParent(
  findings: DiffRecord[],
  elements: UiElement[],
  pairs: ElementPair[],
  viewportArea: number,
  mergeContext?: StructuralMergeContext
): DiffRecord[] {
  const consumed = new Set<string>();
  const parentToChildren = new Map<string, DiffRecord[]>();

  for (const child of findings) {
    if (!isLayoutFinding(child)) continue;
    const parent = selectSuppressionParent(
      findings.filter(candidate => !consumed.has(candidate.id)),
      child,
      elements,
      pairs,
      viewportArea,
      mergeContext
    );
    if (!parent) continue;
    const children = parentToChildren.get(parent.id) ?? [];
    children.push(child);
    parentToChildren.set(parent.id, children);
    consumed.add(child.id);
  }

  return findings
    .filter(finding => !consumed.has(finding.id))
    .map(finding => {
      const children = parentToChildren.get(finding.id);
      return children ? mergeChildIntoParent(finding, children) : finding;
    });
}

interface ConsolidationWithLedger {
  diffs: DiffRecord[];
  ledger: StructuralConsolidationLedger;
}

function consolidateFindingsWithLedger(
  findings: DiffRecord[],
  elements: UiElement[],
  pairs: ElementPair[],
  context?: FindingConsolidationContext,
  ledgerCandidates: DiffRecord[] = findings,
  broadExcludedIds: readonly string[] = []
): ConsolidationWithLedger {
  const canonicalFindings = context ? canonicalizeFinalFindings(findings, context, pairs) : findings;
  const ownershipCanvas = context?.canvas ?? estimateOwnershipCanvas(elements);
  const viewportArea = ownershipCanvas.width * ownershipCanvas.height;
  const ownershipElements = projectElementsToCanvas(elements, ownershipCanvas);
  const elementMap = new Map(ownershipElements.map(element => [element.id, element]));
  const pairMap = new Map(pairs.map(pair => [pair.id, pair]));
  const candidateById = new Map<string, DiffRecord>();
  for (const candidate of ledgerCandidates) candidateById.set(candidate.id, candidate);
  for (const candidate of canonicalFindings) if (!candidateById.has(candidate.id)) candidateById.set(candidate.id, candidate);
  const mergeContext: StructuralMergeContext = { candidateById, elements: elementMap, pairMap, viewportArea };
  const groups = new Map<string, OwnedFinding[]>();

  for (const finding of [...canonicalFindings].sort((a, b) => a.location.y - b.location.y || a.location.x - b.location.x || a.id.localeCompare(b.id))) {
    const owned = resolveOwnership(finding, ownershipElements, elementMap, pairMap);
    const explicitGroup = finding.findingGroupId && finding.findingGroupKind
      ? `explicit:${finding.findingGroupKind}:${finding.findingGroupId}:${finding.criterion}`
      : undefined;
    let key = explicitGroup ?? (owned.parent
      ? `parent:${owned.parent.id}:${finding.criterion}`
      : `fallback:${owned.fallbackKey}`);
    const isSemanticChildFinding = owned.parent !== undefined && owned.targetIds.some(id => id !== owned.parent!.id);
    if (!explicitGroup && !owned.parent) {
      const existing = groups.get(key);
      if (existing && !existing.some(entry => strongOverlap(entry.finding.location, finding.location))) {
        key = `${key}:${finding.id}`;
      }
    }
    const existing = groups.get(key);
    if (!explicitGroup && existing && (isSemanticChildFinding || !existing.every(entry =>
      localUnion(entry.finding.location, finding.location, viewportArea) && coherentDisplacement(entry.finding, finding)
    ))) {
      key = `${key}:${finding.id}`;
    }
    const bucket = groups.get(key);
    if (bucket !== undefined && !sourceRootAllowsOwnedMerge([...bucket, owned], mergeContext)) {
      key = `${key}:${finding.id}`;
    }
    const group = groups.get(key) ?? [];
    group.push(owned);
    groups.set(key, group);
  }

  const initiallyMerged = mergeOverlappingOwnedGroups([...groups.values()], mergeContext).map(group => mergeGroup(group, mergeContext));
  const finalMerged = mergeFinalDuplicateFindings(initiallyMerged, mergeContext);
  const diffs = suppressLayoutChildrenCoveredByParent(finalMerged, ownershipElements, pairs, viewportArea, mergeContext)
    .map(finding => ({
      ...finding,
      childFindingIds: [...new Set(finding.childFindingIds ?? [])]
        .filter(id => id !== finding.id)
        .sort((a, b) => a.localeCompare(b))
    }))
    .sort((a, b) => a.location.y - b.location.y || a.location.x - b.location.x || a.id.localeCompare(b.id));
  return {
    diffs,
    ledger: buildStructuralLedger(ledgerCandidates, diffs, ownershipElements, pairs, ownershipCanvas, broadExcludedIds)
  };
}

export function consolidateFindings(
  findings: DiffRecord[],
  elements: UiElement[],
  pairs: ElementPair[],
  context?: FindingConsolidationContext
): DiffRecord[] {
  return consolidateFindingsWithLedger(findings, elements, pairs, context).diffs;
}

function buildStructuralLedger(
  candidates: DiffRecord[],
  retained: DiffRecord[],
  elements: UiElement[],
  pairs: ElementPair[],
  canvas: { width: number; height: number },
  broadExcludedIds: readonly string[] = []
): StructuralConsolidationLedger {
  const elementMap = new Map(elements.map(element => [element.id, element]));
  const pairMap = new Map(pairs.map(pair => [pair.id, pair]));
  const candidateIds = new Set(candidates.map(candidate => candidate.id));
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const candidateRecords = candidates.map(candidate => ({
    findingId: candidate.id,
    criterion: candidate.criterion,
    elementIds: targetIdsForFinding(candidate, pairMap).sort((a, b) => a.localeCompare(b)),
    ...(candidate.classificationSource !== undefined ? { classificationSource: candidate.classificationSource } : {}),
    ...(candidate.repairLocality !== undefined ? { repairLocality: candidate.repairLocality } : {})
  }));
  const involvedElementIds = new Set(candidateRecords.flatMap(candidate => candidate.elementIds));
  const elementLineage = elements
    .filter(element => involvedElementIds.has(element.id) || involvedElementIds.size > 0)
    .map(element => ({
      elementId: element.id,
      ...(element.parentId ? { parentId: element.parentId } : {})
    }));
  for (const elementId of involvedElementIds) {
    if (!elementLineage.some(lineage => lineage.elementId === elementId)) elementLineage.push({ elementId });
  }
  const removedLineage = new Map<string, string[]>();
  for (const retainedFinding of retained) {
    for (const suppressedFindingId of retainedFinding.childFindingIds ?? []) {
      if (!candidateIds.has(suppressedFindingId)) continue;
      const lineage = removedLineage.get(suppressedFindingId) ?? [];
      lineage.push(retainedFinding.id);
      removedLineage.set(suppressedFindingId, lineage);
    }
  }
  const decisions: StructuralSuppressionDecision[] = [];
  for (const retainedFinding of retained) {
    const retainedSource = candidateById.get(retainedFinding.id);
    if (retainedSource === undefined) {
      throw new Error(`structural consolidation: retained output ${retainedFinding.id} has no original candidate`);
    }
    for (const suppressedFindingId of retainedFinding.childFindingIds ?? []) {
      if (!candidateIds.has(suppressedFindingId)) continue;
      const suppressedFinding = candidates.find(candidate => candidate.id === suppressedFindingId);
      if (!suppressedFinding) continue;
      const suppressedSource = candidateById.get(suppressedFinding.id);
      if (suppressedSource === undefined) {
        throw new Error(`structural consolidation: suppressed output ${suppressedFinding.id} has no original candidate`);
      }
      const input = structuralRelationInput(
        retainedSource,
        suppressedSource,
        elementMap,
        pairMap,
        canvas.width * canvas.height
      );
      const relation = classifyStructuralRelation(input);
      decisions.push({
        action: relation.action,
        reason: relation.reason,
        suppressedFindingId,
        retainedFindingId: retainedFinding.id,
        ...(input.parentElementId ? { parentElementId: input.parentElementId } : {}),
        ...(input.childElementId ? { childElementId: input.childElementId } : {}),
        criterion: input.criterion,
        sameCriterion: input.sameCriterion,
        semanticDescendant: input.semanticRelation === "descendant",
        semanticRelation: input.semanticRelation,
        parentAreaRatio: input.parentAreaRatio,
        locality: input.unionAreaRatio,
        childContainment: input.childContainment,
        parentMeasurement: input.parentMeasurement,
        childMeasurement: input.childMeasurement,
        ...(input.parentProjectionMismatchKind ? { parentProjectionMismatchKind: input.parentProjectionMismatchKind } : {}),
        ...(input.childProjectionMismatchKind ? { childProjectionMismatchKind: input.childProjectionMismatchKind } : {}),
        ...(input.explicitFindingGroupId ? { explicitFindingGroupId: input.explicitFindingGroupId } : {}),
        ...(input.explicitFindingGroupKind ? { explicitFindingGroupKind: input.explicitFindingGroupKind } : {}),
        displacementRelation: relation.displacementRelation,
        measurementRelation: relation.measurementRelation
      });
    }
  }
  return freezeStructuralLedger({
    candidates: candidateRecords,
    decisions,
    retainedFindingIds: retained.map(finding => finding.id),
    elementLineage,
    candidateTerminals: buildCandidateTerminalRecords({
      candidates: candidateRecords,
      retainedFindingIds: retained.map(finding => finding.id),
      broadExcludedIds,
      removedLineage: [...removedLineage.entries()].map(([candidateId, retainedFindingIds]) => ({ candidateId, retainedFindingIds })),
      decisions
    })
  });
}

export function finalizeFindings(
  findings: DiffRecord[],
  elements: UiElement[],
  pairs: ElementPair[],
  context: FindingConsolidationContext
): FindingFinalization {
  const canonical = canonicalizeFinalFindings(findings, context, pairs);
  const broadVlmFindings = canonical
    .filter(finding => finding.repairLocality === "broad" && finding.classificationSource === "vlm_reviewed")
    .sort((a, b) => a.id.localeCompare(b.id));
  const consolidation = consolidateFindingsWithLedger(
      canonical.filter(finding => !broadVlmFindings.some(broad => broad.id === finding.id)),
      elements,
      pairs,
      context,
      canonical,
      broadVlmFindings.map(finding => finding.id)
    );
  return {
    diffs: consolidation.diffs,
    broadVlmFindings,
    structuralLedger: consolidation.ledger
  };
}

function canonicalizeFinalFindings(
  findings: DiffRecord[],
  context: FindingConsolidationContext,
  pairs: ElementPair[] = []
): DiffRecord[] {
  const canvasArea = Math.max(1, context.canvas.width * context.canvas.height);
  return findings.flatMap(finding => {
    const pair = finding.pairId ? pairs.find(candidate => candidate.id === finding.pairId) : undefined;
    const sourceSpace = finding.coordinateSpace === "comparison_expected_normalized"
      ? "comparison_expected_normalized" as const
      : finding.classificationSource === "deterministic_projected_mismatch"
      || (finding.classificationSource === "deterministic_presence" && pair?.status === "extra")
      ? "actual_normalized" as const
      : "comparison_expected_normalized" as const;
    const resolution = resolveComparisonBox({
      box: finding.location,
      sourceSpace,
      canvas: context.canvas,
      ...(context.imagePairTransform ? { transform: context.imagePairTransform } : {})
    });
    if (resolution.status === "rejected") {
      context.geometryRejections?.push({
        producer: "final_finding_canonicalization",
        reason: resolution.reason,
        reference: `diff:${finding.id}`
      });
      return [];
    }
    const canonicalCoverageLocations = (finding.coverageLocations ?? []).flatMap((coverageLocation, index) => {
      const coverageResolution = resolveComparisonBox({
        box: coverageLocation,
        sourceSpace,
        canvas: context.canvas,
        ...(context.imagePairTransform ? { transform: context.imagePairTransform } : {})
      });
      if (coverageResolution.status === "rejected") {
        context.geometryRejections?.push({
          producer: "final_finding_canonicalization_coverage",
          reason: coverageResolution.reason,
          reference: `diff:${finding.id}:coverage:${index}`
        });
        return [];
      }
      return [coverageResolution.box];
    });
    const repairLocality = boxArea(resolution.box) / canvasArea >= MAX_REPAIR_PARENT_AREA_RATIO
      ? "broad" as const
      : "local" as const;
    const broadVlmEvidence = repairLocality === "broad" && finding.classificationSource === "vlm_reviewed";
    return [{
      ...finding,
      location: resolution.box,
      coverageLocations: canonicalCoverageLocations.length > 0 ? canonicalCoverageLocations : [resolution.box],
      coordinateSpace: "comparison_expected_normalized",
      repairLocality,
      ...(broadVlmEvidence ? {
        reviewerStatus: "needs_escalation" as const,
        reviewerReason: finding.reviewerReason ?? "Broad VLM evidence cannot be decomposed into a repair-local finding."
      } : {})
    }];
  });
}
