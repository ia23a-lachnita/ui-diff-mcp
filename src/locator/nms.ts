import type { UiElement } from "../schemas/core.js";
import { iou } from "../signals/geometry.js";

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

export function suppressDuplicateElements(
  elements: UiElement[],
  options: { iouThreshold?: number } = {}
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

  return kept;
}