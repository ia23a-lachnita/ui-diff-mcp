import crypto from "node:crypto";
import type { CompactRoleSource, UiElement, UiElementType, LocatorLaneMetadata } from "../schemas/core.js";
import type { LocateAnythingElement } from "./locateanything-client.js";
import { suppressDuplicateElements } from "./nms.js";
import { iou, toNormalizedBox, containsCenter, area } from "../signals/geometry.js";
import type { EdgeComponent } from "../signals/edge.js";
import { type ImagePairTransform, projectExpectedBoxToActualSource } from "../images/coordinates.js";

interface ImageSize {
  width: number;
  height: number;
}

interface DeterministicBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  type?: UiElementType;
}

function stableId(type: string, label: string, x: number, y: number, w: number, h: number): string {
  const raw = `${type}:${label}:${Math.round(x)}:${Math.round(y)}:${Math.round(w)}:${Math.round(h)}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

const QUERY_ID_TYPE_MAP: Readonly<Record<string, UiElementType>> = {
  text_labels: "text",
  buttons: "button",
  cards_panels_containers: "card",
  icons: "icon",
  charts_indicators: "chart",
  tab_bar_nav_elements: "nav",
  list_items: "list_item",
  image_thumbnails_avatars: "image"
};

const REF_TOKEN = /<\/?ref>/g;
const BOX_TOKEN = /<\/?box>/g;
const COORD_TOKEN = /<-?\d+(?:\s*,\s*-?\d+)*>/g;
const COMPACT_CONTAINMENT_TOLERANCE = 0.5;

function sanitizeElementLabel(rawLabel: string): string {
  return rawLabel
    .replace(REF_TOKEN, "")
    .replace(BOX_TOKEN, "")
    .replace(COORD_TOKEN, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeElementLabel(label: string, queryId: string, type: UiElementType, fallbackRank: number): string {
  const trimmed = label.trim();
  if (
    trimmed.length === 0 ||
    /^\d+$/.test(trimmed) ||
    trimmed.toLowerCase().startsWith("locate ")
  ) {
    return `${type}-${queryId}-${fallbackRank}`;
  }
  return trimmed;
}

function resolveType(queryId: string | undefined, label: string): {
  type: UiElementType;
  compactRoleSource?: CompactRoleSource;
} {
  if (queryId && queryId in QUERY_ID_TYPE_MAP) {
    const type = QUERY_ID_TYPE_MAP[queryId] as UiElementType;
    return {
      type,
      ...(type === "button" ? { compactRoleSource: "query_mapping" as const } : {})
    };
  }
  return { type: guessTypeFromLabel(label) };
}

interface RawLocatorCandidate {
  raw: LocateAnythingElement;
  type: UiElementType;
  compactRoleSource?: CompactRoleSource;
  sanitizedLabel: string;
  canonicalKey: string;
  fallbackRank: number;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRawLocatorCandidates(a: RawLocatorCandidate, b: RawLocatorCandidate): number {
  const aQueryId = a.raw.queryId ?? "";
  const bQueryId = b.raw.queryId ?? "";
  const stringFields: Array<[string, string]> = [
    [aQueryId, bQueryId],
    [a.type, b.type]
  ];
  for (const [left, right] of stringFields) {
    const comparison = compareStrings(left, right);
    if (comparison !== 0) return comparison;
  }
  const numericFields: Array<[number, number]> = [
    [a.raw.box.x, b.raw.box.x],
    [a.raw.box.y, b.raw.box.y],
    [a.raw.box.width, b.raw.box.width],
    [a.raw.box.height, b.raw.box.height]
  ];
  for (const [left, right] of numericFields) {
    if (left !== right) return left - right;
  }
  const contentFields: Array<[string, string]> = [
    [a.sanitizedLabel, b.sanitizedLabel],
    [a.raw.rawText ?? "", b.raw.rawText ?? ""]
  ];
  for (const [left, right] of contentFields) {
    const comparison = compareStrings(left, right);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function canonicalRawLocatorKey(candidate: Omit<RawLocatorCandidate, "canonicalKey" | "fallbackRank">): string {
  const { raw, type, sanitizedLabel } = candidate;
  return JSON.stringify([
    raw.queryId,
    type,
    raw.box.x,
    raw.box.y,
    raw.box.width,
    raw.box.height,
    sanitizedLabel,
    raw.rawText ?? ""
  ]);
}

function guessTypeFromLabel(label: string): UiElementType {
  const l = label.toLowerCase();
  if (/button|btn|submit|cancel|ok/.test(l)) return "button";
  if (/icon|logo|chevron|arrow/.test(l)) return "icon";
  if (/card|tile|panel/.test(l)) return "card";
  if (/chart|graph|plot/.test(l)) return "chart";
  if (/nav|tab|menu/.test(l)) return "nav";
  if (/list/.test(l)) return "list_item";
  if (/image|img|photo|avatar/.test(l)) return "image";
  return "text";
}

export function buildElementMap(
  rawElements: LocateAnythingElement[],
  imageSize: ImageSize,
  deterministicBoxes: DeterministicBox[] = []
): UiElement[] {
  let elements: UiElement[] = [];

  const candidates = rawElements
    .filter((raw): raw is LocateAnythingElement => raw !== undefined)
    .map(raw => {
      const resolvedType = resolveType(raw.queryId, raw.label);
      const base = {
        raw,
        type: resolvedType.type,
        ...(resolvedType.compactRoleSource !== undefined
          ? { compactRoleSource: resolvedType.compactRoleSource }
          : {}),
        sanitizedLabel: sanitizeElementLabel(raw.label)
      };
      return { ...base, canonicalKey: canonicalRawLocatorKey(base), fallbackRank: 0 };
    })
    .sort(compareRawLocatorCandidates);

  let fallbackRank = -1;
  let previousCanonicalKey: string | undefined;
  for (const candidate of candidates) {
    if (candidate.canonicalKey !== previousCanonicalKey) fallbackRank++;
    candidate.fallbackRank = fallbackRank;
    previousCanonicalKey = candidate.canonicalKey;
  }

  for (const candidate of candidates) {
    const { raw, type } = candidate;
    const box = { ...raw.box };

    const normalizedBox = toNormalizedBox(box, imageSize.width, imageSize.height);
    const label = normalizeElementLabel(
      candidate.sanitizedLabel,
      raw.queryId ?? "unknown",
      type,
      candidate.fallbackRank
    );
    const id = stableId(type, label, box.x, box.y, box.width, box.height);

    elements.push({
      id,
      label,
      type,
      ...(candidate.compactRoleSource !== undefined
        ? { compactRoleSource: candidate.compactRoleSource }
        : {}),
      queryId: raw.queryId,
      box,
      normalizedBox,
      text: raw.rawText ?? undefined,
      confidence: raw.confidence,
      source: "locator",
      childIds: []
    });
  }

  for (const det of deterministicBoxes) {
    const detBox = { x: det.x, y: det.y, width: det.width, height: det.height };
    const already = elements.some(e => iou(e.box, detBox) >= 0.55);
    if (!already) {
      const type = det.type ?? "unknown";
      const label = det.label ?? "unknown";
      const normalizedBox = toNormalizedBox(detBox, imageSize.width, imageSize.height);
      const id = stableId(type, label, det.x, det.y, det.width, det.height);
      elements.push({
        id,
        label,
        type,
        ...(det.type === "button" ? { compactRoleSource: "deterministic" as const } : {}),
        box: detBox,
        normalizedBox,
        confidence: 1.0,
        source: "deterministic",
        childIds: []
      });
    }
  }

  elements = suppressDuplicateElements(elements);
  return selectNearestContainingParents(elements);
}

export { QUERY_ID_TYPE_MAP };

function hasUsableBox(element: UiElement): boolean {
  const { x, y, width, height } = element.box;
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0;
}

function containsBoxWithinTolerance(parent: UiElement, child: UiElement): boolean {
  const parentRight = parent.box.x + parent.box.width;
  const parentBottom = parent.box.y + parent.box.height;
  const childRight = child.box.x + child.box.width;
  const childBottom = child.box.y + child.box.height;
  return (
    child.box.x >= parent.box.x - COMPACT_CONTAINMENT_TOLERANCE &&
    child.box.y >= parent.box.y - COMPACT_CONTAINMENT_TOLERANCE &&
    childRight <= parentRight + COMPACT_CONTAINMENT_TOLERANCE &&
    childBottom <= parentBottom + COMPACT_CONTAINMENT_TOLERANCE
  );
}

function isEligibleParent(parent: UiElement, child: UiElement): boolean {
  if (parent === child || !hasUsableBox(parent) || !hasUsableBox(child)) return false;

  const parentArea = area(parent.box);
  const childArea = area(child.box);
  if (parentArea <= childArea) return false;
  if (!containsBoxWithinTolerance(parent, child) || !containsCenter(parent.box, child.box)) return false;

  if (parent.type === "button" && parent.compactRoleSource !== undefined) {
    return true;
  }

  return parentArea >= childArea * 1.5;
}

/**
 * Select one deterministic nearest parent per element after duplicate suppression.
 * Every parent must contain the full child box within the 0.5px raster tolerance.
 * Trusted compact metadata relaxes only the ordinary 1.5x area-ratio requirement.
 */
export function selectNearestContainingParents(elements: UiElement[]): UiElement[] {
  const selected = elements.map<UiElement>(element => ({ ...element, parentId: undefined, childIds: [] }));

  for (const child of selected) {
    const eligibleParents = selected
      .filter(parent => isEligibleParent(parent, child))
      .sort((a, b) => {
        const areaDifference = area(a.box) - area(b.box);
        return areaDifference !== 0 ? areaDifference : a.id.localeCompare(b.id);
      });
    const parent = eligibleParents[0];
    if (parent) child.parentId = parent.id;
  }

  for (const parent of selected) {
    parent.childIds = selected
      .filter(child => child.parentId === parent.id)
      .map(child => child.id)
      .sort((a, b) => a.localeCompare(b));
  }

  return selected;
}

export function projectElementsToActual(
  expectedElements: UiElement[],
  transform: ImagePairTransform
): UiElement[] {
  return expectedElements.map(exp => {
    const scaledBox = projectExpectedBoxToActualSource(exp.box, transform);
    const x = Math.max(0, Math.min(scaledBox.x, transform.actualSize.width - 1));
    const y = Math.max(0, Math.min(scaledBox.y, transform.actualSize.height - 1));
    const width = Math.max(1, Math.min(scaledBox.width, transform.actualSize.width - x));
    const height = Math.max(1, Math.min(scaledBox.height, transform.actualSize.height - y));
    const clampedBox = { x, y, width, height };
    const normalizedBox = toNormalizedBox(clampedBox, transform.actualSize.width, transform.actualSize.height);
    return {
      ...exp,
      id: `proj-${exp.id}`,
      box: clampedBox,
      normalizedBox,
      source: "projected" as const,
      projectionMetadata: {
        mode: "expected_coordinate_projection" as const,
        coordinateSpace: "actual_source_image" as const,
        sourceElementId: exp.id,
        scaleExpectedToActualX: transform.scaleExpectedToActualX,
        scaleExpectedToActualY: transform.scaleExpectedToActualY,
        mappingMode: transform.mappingMode,
        offsetExpectedToActualX: transform.offsetExpectedToActualX,
        offsetExpectedToActualY: transform.offsetExpectedToActualY
      }
    };
  });
}

const LANE_STATUS_RANK: Record<string, number> = { failed: 3, not_configured: 2, skipped: 1, complete: 0 };

/** Merge two lane-metadata records, taking the worse status and summing element counts. */
export function mergeLocatorLanes(
  a: Record<string, LocatorLaneMetadata>,
  b: Record<string, LocatorLaneMetadata>
): Record<string, LocatorLaneMetadata> {
  const result: Record<string, LocatorLaneMetadata> = { ...a };
  for (const [lane, bMeta] of Object.entries(b)) {
    const aMeta = result[lane];
    if (!aMeta) {
      result[lane] = bMeta;
    } else {
      const bWins = (LANE_STATUS_RANK[bMeta.status] ?? 0) > (LANE_STATUS_RANK[aMeta.status] ?? 0);
      const winner = bWins ? bMeta : aMeta;
      const { detail: _drop, ...aBase } = aMeta;
      result[lane] = {
        ...aBase,
        status: winner.status,
        count: aMeta.count + bMeta.count,
        ...(winner.detail !== undefined ? { detail: winner.detail } : {})
      };
    }
  }
  return result;
}

export function computeLocatorMetadata(
  elements: UiElement[],
  promptCount: number
): { promptCount: number; queryCounts: Record<string, number> } {
  const queryCounts: Record<string, number> = {};
  for (const el of elements) {
    if (el.queryId) {
      queryCounts[el.queryId] = (queryCounts[el.queryId] ?? 0) + 1;
    }
  }
  return { promptCount, queryCounts };
}


export function computeLocatorCoverageStatus(
  elements: UiElement[],
  promptCount: number,
  failed: boolean
): "complete" | "weak" | "failed" | "not_run" {
  if (failed) return "failed";
  if (promptCount === 0) return "not_run";
  const queryIds = new Set(elements.map(e => e.queryId).filter(Boolean));
  if (queryIds.size >= promptCount * 0.75) return "complete";
  if (elements.length > 0) return "weak";
  return "failed";
}

export interface SnapWarning {
  elementId: string;
  deltaX: number;
  deltaY: number;
}

export function snapElementBoxesToSignals(
  elements: UiElement[],
  edgeComponents: EdgeComponent[],
  textBoxes: Array<{ x: number; y: number; width: number; height: number }>
): { elements: UiElement[]; warnings: SnapWarning[] } {
  const warnings: SnapWarning[] = [];
  const allSignalBoxes = [
    ...edgeComponents.map(c => c.box),
    ...textBoxes
  ];

  const snapped = elements.map(el => {
    let best: typeof allSignalBoxes[0] | null = null;
    let bestScore = -Infinity;

    for (const sig of allSignalBoxes) {
      const overlapScore = iou(el.box, sig);
      const centerInside = containsCenter(el.box, sig) &&
        area(sig) / area(el.box) >= 0.35 &&
        area(sig) / area(el.box) <= 2.2;
      const score = centerInside ? Math.max(overlapScore, 0.55) : overlapScore;
      if (score >= 0.55 && score > bestScore) {
        bestScore = score;
        best = sig;
      }
    }

    if (!best) return el;

    const deltaX = Math.abs(best.x - el.box.x);
    const deltaY = Math.abs(best.y - el.box.y);
    if (deltaX > 12 || deltaY > 12) {
      warnings.push({ elementId: el.id, deltaX, deltaY });
    }

    const snappedBox = { x: best.x, y: best.y, width: best.width, height: best.height };
    return {
      ...el,
      box: snappedBox,
      normalizedBox: toNormalizedBox(snappedBox, 1, 1)
    };
  });

  return { elements: snapped, warnings };
}
