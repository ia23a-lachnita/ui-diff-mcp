import type { UiElement } from "../schemas/core.js";
import { iou, intersect, area } from "../signals/geometry.js";

function mergeQueryIds(a?: string, b?: string): string | undefined {
  const parts = new Set<string>();
  for (const value of [a, b]) {
    if (!value) continue;
    for (const part of value.split("+")) parts.add(part);
  }
  return parts.size > 0 ? [...parts].sort().join("+") : undefined;
}

function mergeElement(primary: UiElement, duplicate: UiElement): UiElement {
  return {
    ...primary,
    confidence: Math.max(primary.confidence, duplicate.confidence),
    queryId: mergeQueryIds(primary.queryId, duplicate.queryId),
    label: primary.confidence >= duplicate.confidence ? primary.label : duplicate.label,
    text: primary.text ?? duplicate.text,
    source: "merged"
  };
}

// Suppress a smaller element when it is mostly contained within a larger one, but only
// when the larger element is close enough in size that the VLM will still see the detail.
// containmentThreshold: fraction of smaller element's area that must overlap the larger (default 0.85).
// maxAreaRatio: if larger/smaller > this, keep smaller — the large crop would hide fine detail (default 6).
function suppressContainedElements(
  elements: UiElement[],
  containmentThreshold = 0.85,
  maxAreaRatio = 6
): UiElement[] {
  const byAreaDesc = [...elements].sort((a, b) => area(b.box) - area(a.box));
  const suppressed = new Set<string>();

  for (let i = 0; i < byAreaDesc.length; i++) {
    const large = byAreaDesc[i]!;
    if (suppressed.has(large.id)) continue;
    const largeArea = area(large.box);
    for (let j = i + 1; j < byAreaDesc.length; j++) {
      const small = byAreaDesc[j]!;
      if (suppressed.has(small.id)) continue;
      const smallArea = area(small.box);
      if (smallArea === 0 || largeArea / smallArea > maxAreaRatio) continue;
      const inter = intersect(large.box, small.box);
      if (!inter) continue;
      const containment = area(inter) / smallArea;
      if (containment >= containmentThreshold) suppressed.add(small.id);
    }
  }

  return elements.filter(e => !suppressed.has(e.id));
}

export function suppressDuplicateElements(
  elements: UiElement[],
  options: { iouThreshold?: number; containmentThreshold?: number; maxAreaRatio?: number } = {}
): UiElement[] {
  const iouThreshold = options.iouThreshold ?? 0.72;
  const sorted = [...elements].sort((a, b) => b.confidence - a.confidence);
  const kept: UiElement[] = [];

  for (const element of sorted) {
    const index = kept.findIndex(existing => iou(existing.box, element.box) >= iouThreshold);
    if (index === -1) {
      kept.push(element);
      continue;
    }
    kept[index] = mergeElement(kept[index]!, element);
  }

  return suppressContainedElements(
    kept,
    options.containmentThreshold ?? 0.85,
    options.maxAreaRatio ?? 6
  );
}