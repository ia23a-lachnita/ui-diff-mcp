import type { UiElement } from "../schemas/core.js";
import type { ImageLocatorCoverage } from "./coverage.js";

export function buildTargetMapJson(input: {
  imageRole: "expected" | "actual";
  coverage: ImageLocatorCoverage;
  elements: UiElement[];
  elementsSource?: "independent" | "projected";
}) {
  return {
    imageRole: input.imageRole,
    ...(input.elementsSource !== undefined ? { elementsSource: input.elementsSource } : {}),
    coverage: input.coverage,
    elements: input.elements.map(e => ({
      id: e.id,
      label: e.label,
      type: e.type,
      queryId: e.queryId,
      source: e.source,
      confidence: e.confidence,
      box: e.box,
      text: e.text
    }))
  };
}