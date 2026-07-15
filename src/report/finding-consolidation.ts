import type { Box, DiffRecord, ElementPair, GeometryDiagnosticReference, UiElement } from "../schemas/core.js";
import { resolveComparisonBox } from "../images/comparison-geometry.js";
import type { ImagePairTransform } from "../images/coordinates.js";
import { intersect } from "../signals/geometry.js";

const SEMANTIC_PARENT_TYPES = new Set<UiElement["type"]>([
  "card", "chart", "nav", "list_item", "button", "image"
]);
const MAX_REPAIR_PARENT_AREA_RATIO = 0.3;

interface OwnedFinding {
  finding: DiffRecord;
  parent?: UiElement;
  targetIds: string[];
  fallbackKey: string;
}

export interface FindingConsolidationContext {
  canvas: { width: number; height: number };
  imagePairTransform?: ImagePairTransform;
  geometryRejections?: GeometryDiagnosticReference[];
}

export interface FindingFinalization {
  diffs: DiffRecord[];
  broadVlmFindings: DiffRecord[];
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

function unionBoxes(boxes: Box[]): Box {
  const x = Math.min(...boxes.map(box => box.x));
  const y = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width));
  const bottom = Math.max(...boxes.map(box => box.y + box.height));
  return { x, y, width: right - x, height: bottom - y };
}

function eligibleParent(element: UiElement): boolean {
  return SEMANTIC_PARENT_TYPES.has(element.type) && element.source !== "merged";
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
    if (eligibleParent(current)) return current;
    current = current.parentId ? elements.get(current.parentId) : undefined;
  }
  return undefined;
}

function overlappingSemanticParent(finding: DiffRecord, elements: UiElement[]): UiElement | undefined {
  return elements
    .filter(eligibleParent)
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

function mergeGroup(group: OwnedFinding[]): DiffRecord {
  const severityRank = { low: 0, medium: 1, high: 2 } as const;
  const reviewRank = { rejected: 0, not_reviewed: 1, accepted: 2, needs_escalation: 3 } as const;
  const primaryRank = (entry: OwnedFinding): number => {
    if (entry.finding.scopeKind) return 3;
    if (entry.finding.classificationSource === "vlm_reviewed") return 2;
    if (entry.finding.findingGroupKind) return 1;
    return 0;
  };
  const primary = group.reduce((best, current) => {
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

function mergeOverlappingOwnedGroups(groups: OwnedFinding[][]): OwnedFinding[][] {
  const merged: OwnedFinding[][] = [];
  for (const group of groups) {
    const existing = merged.find(candidate => shouldMergeOwnedGroups(candidate, group));
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

function mergeFinalFindingGroup(group: DiffRecord[]): DiffRecord {
  const merged = mergeGroup(group.map(finding => ({
    finding,
    targetIds: finding.targetIds ?? [],
    fallbackKey: `${finding.id}:${finding.criterion}`
  })));
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

function mergeFinalDuplicateFindings(findings: DiffRecord[]): DiffRecord[] {
  const groups: DiffRecord[][] = [];
  for (const finding of findings) {
    const existing = groups.find(group => group.some(candidate => shouldMergeFinalFindings(candidate, finding)));
    if (existing) {
      existing.push(finding);
    } else {
      groups.push([finding]);
    }
  }
  return groups.map(group => group.length === 1 ? group[0]! : mergeFinalFindingGroup(group));
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

function parentExplainsChildLayout(
  parent: DiffRecord,
  child: DiffRecord,
  elements: Map<string, UiElement>,
  pairMap: Map<string, ElementPair>,
  viewportArea: number
): boolean {
  if (parent.id === child.id) return false;
  if (!isLayoutFinding(parent) || parent.criterion !== child.criterion) return false;
  if (boxArea(parent.location) / Math.max(1, viewportArea) >= MAX_REPAIR_PARENT_AREA_RATIO) return false;
  if (boxArea(parent.location) <= boxArea(child.location)) return false;
  const parentTargets = targetIdsForFinding(parent, pairMap);
  const childTargets = targetIdsForFinding(child, pairMap);
  if (parentTargets.length === 0 || childTargets.length === 0) return false;
  const descendant = parentTargets.some(parentId =>
    childTargets.some(childId => childId !== parentId && isDescendantOf(childId, parentId, elements))
  );
  if (!descendant || !coherentDisplacement(parent, child)) return false;
  const normalizeEvidence = (values: string[]) => [...new Set(values.map(value => value.trim().toLocaleLowerCase()).filter(Boolean))].sort();
  const parentEvidence = normalizeEvidence(parent.evidence);
  const childEvidence = normalizeEvidence(child.evidence);
  return parentEvidence.length === childEvidence.length && parentEvidence.every((value, index) => value === childEvidence[index]);
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
  viewportArea: number
): DiffRecord | undefined {
  const elementMap = new Map(elements.map(element => [element.id, element]));
  const pairMap = new Map(pairs.map(pair => [pair.id, pair]));
  return candidates
    .filter(isLayoutFinding)
    .sort((a, b) => boxArea(b.location) - boxArea(a.location) || a.id.localeCompare(b.id))
    .find(candidate => candidate.id !== child.id && parentExplainsChildLayout(candidate, child, elementMap, pairMap, viewportArea));
}

function suppressLayoutChildrenCoveredByParent(
  findings: DiffRecord[],
  elements: UiElement[],
  pairs: ElementPair[],
  viewportArea: number
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
      viewportArea
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

export function consolidateFindings(
  findings: DiffRecord[],
  elements: UiElement[],
  pairs: ElementPair[],
  context?: FindingConsolidationContext
): DiffRecord[] {
  const canonicalFindings = context ? canonicalizeFinalFindings(findings, context, pairs) : findings;
  const ownershipCanvas = context?.canvas ?? estimateOwnershipCanvas(elements);
  const viewportArea = ownershipCanvas.width * ownershipCanvas.height;
  const ownershipElements = projectElementsToCanvas(elements, ownershipCanvas);
  const elementMap = new Map(ownershipElements.map(element => [element.id, element]));
  const pairMap = new Map(pairs.map(pair => [pair.id, pair]));
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
    const group = groups.get(key) ?? [];
    group.push(owned);
    groups.set(key, group);
  }

  const initiallyMerged = mergeOverlappingOwnedGroups([...groups.values()]).map(mergeGroup);
  const finalMerged = mergeFinalDuplicateFindings(initiallyMerged);
  return suppressLayoutChildrenCoveredByParent(finalMerged, ownershipElements, pairs, viewportArea)
    .map(finding => ({
      ...finding,
      childFindingIds: [...new Set(finding.childFindingIds ?? [])]
        .filter(id => id !== finding.id)
        .sort((a, b) => a.localeCompare(b))
    }))
    .sort((a, b) => a.location.y - b.location.y || a.location.x - b.location.x || a.id.localeCompare(b.id));
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
  return {
    diffs: consolidateFindings(
      canonical.filter(finding => !broadVlmFindings.some(broad => broad.id === finding.id)),
      elements,
      pairs,
      context
    ).sort((a, b) => a.location.y - b.location.y || a.location.x - b.location.x || a.id.localeCompare(b.id)),
    broadVlmFindings
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
