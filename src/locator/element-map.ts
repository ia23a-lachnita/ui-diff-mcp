import crypto from "node:crypto";
import type { UiElement, UiElementType, LocatorLaneMetadata } from "../schemas/core.js";
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

// Second net behind the sidecar's own sanitizer: any grounding token that
// still reaches this layer marks the whole label as junk, because partial
// fragments ("tate</ref> buttons…") are truncation artifacts, not names.
const MODEL_TOKEN_TEST = /<\/?ref>|<box>|<-?\d+>/;

function normalizeElementLabel(rawLabel: string, queryId: string, type: UiElementType, index: number): string {
  const trimmed = rawLabel.trim();
  if (
    MODEL_TOKEN_TEST.test(trimmed) ||
    trimmed.length === 0 ||
    /^\d+$/.test(trimmed) ||
    trimmed.toLowerCase().startsWith("locate ")
  ) {
    return `${type}-${queryId}-${index}`;
  }
  return trimmed;
}

function resolveType(queryId: string | undefined, label: string): UiElementType {
  if (queryId && queryId in QUERY_ID_TYPE_MAP) {
    return QUERY_ID_TYPE_MAP[queryId] as UiElementType;
  }
  return guessTypeFromLabel(label);
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

  for (let i = 0; i < rawElements.length; i++) {
    const raw = rawElements[i];
    if (!raw) continue;

    const type = resolveType(raw.queryId, raw.label);
    const box = { ...raw.box };

    const normalizedBox = toNormalizedBox(box, imageSize.width, imageSize.height);
    const label = normalizeElementLabel(raw.label, raw.queryId ?? "unknown", type, i);
    const id = stableId(type, label, box.x, box.y, box.width, box.height);

    elements.push({
      id,
      label,
      type,
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
        box: detBox,
        normalizedBox,
        confidence: 1.0,
        source: "deterministic",
        childIds: []
      });
    }
  }

  elements = suppressDuplicateElements(elements);

  for (let i = 0; i < elements.length; i++) {
    for (let j = 0; j < elements.length; j++) {
      if (i === j) continue;
      const parent = elements[i];
      const child = elements[j];
      if (!parent || !child) continue;
      if (
        containsCenter(parent.box, child.box) &&
        area(parent.box) > area(child.box) * 1.5
      ) {
        if (!parent.childIds.includes(child.id)) {
          parent.childIds.push(child.id);
        }
        if (child.parentId === undefined) {
          child.parentId = parent.id;
        }
      }
    }
  }

  return elements;
}

export { QUERY_ID_TYPE_MAP };

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
        scaleExpectedToActualY: transform.scaleExpectedToActualY
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
