import type { Box, DiffRecord, ElementPair, UiElement } from "../schemas/core.js";
import { intersect } from "../signals/geometry.js";

const SEMANTIC_PARENT_TYPES = new Set<UiElement["type"]>([
  "card", "chart", "nav", "list_item", "button", "image"
]);

interface OwnedFinding {
  finding: DiffRecord;
  parent?: UiElement;
  targetIds: string[];
  fallbackKey: string;
}

function boxArea(box: Box): number {
  return box.width * box.height;
}

function strongOverlap(a: Box, b: Box): boolean {
  const overlap = intersect(a, b);
  if (!overlap) return false;
  return (overlap.width * overlap.height) / Math.min(boxArea(a), boxArea(b)) >= 0.7;
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
    .map(element => ({ element, overlap: intersect(finding.location, element.box) }))
    .filter((entry): entry is { element: UiElement; overlap: Box } => entry.overlap !== undefined)
    .filter(entry => boxArea(entry.overlap) / boxArea(finding.location) >= 0.5)
    .sort((a, b) => boxArea(a.element.box) - boxArea(b.element.box))[0]?.element;
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
    .sort((a, b) => boxArea(a.box) - boxArea(b.box));
  const parent = semanticParents[0] ?? overlappingSemanticParent(finding, elements);
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
  const primary = group.reduce((best, current) =>
    severityRank[current.finding.severity] > severityRank[best.finding.severity] ? current : best
  );
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
  const childFindingIds = [...new Set(allFindings.flatMap(finding => [finding.id, ...(finding.childFindingIds ?? [])]))];
  const targetIds = [...new Set(group.flatMap(entry => [...entry.targetIds, ...(entry.finding.targetIds ?? [])]))];
  const criterionLabel = primary.finding.criterion.replaceAll("_", " ");

  return {
    ...primary.finding,
    title: parent ? `${parent.label}: ${criterionLabel}` : primary.finding.title,
    location: unionBoxes(allFindings.map(finding => finding.location)),
    severity: primary.finding.severity,
    evidence: [...new Set(allFindings.flatMap(finding => finding.evidence))],
    measurements: [...measurements.values()],
    artifactPaths: [...artifacts.values()],
    childFindingIds,
    targetIds,
    reviewerStatus
  };
}

export function consolidateFindings(
  findings: DiffRecord[],
  elements: UiElement[],
  pairs: ElementPair[]
): DiffRecord[] {
  const elementMap = new Map(elements.map(element => [element.id, element]));
  const pairMap = new Map(pairs.map(pair => [pair.id, pair]));
  const groups = new Map<string, OwnedFinding[]>();

  for (const finding of findings) {
    const owned = resolveOwnership(finding, elements, elementMap, pairMap);
    let key = owned.parent
      ? `parent:${owned.parent.id}:${finding.criterion}`
      : `fallback:${owned.fallbackKey}`;
    if (!owned.parent) {
      const existing = groups.get(key);
      if (existing && !existing.some(entry => strongOverlap(entry.finding.location, finding.location))) {
        key = `${key}:${finding.id}`;
      }
    }
    const group = groups.get(key) ?? [];
    group.push(owned);
    groups.set(key, group);
  }

  return [...groups.values()].map(mergeGroup);
}
