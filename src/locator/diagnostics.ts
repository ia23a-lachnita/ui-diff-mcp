import type { UiElement } from "../schemas/core.js";
import type { ImageLocatorCoverage } from "./coverage.js";

export function buildTargetMapJson(input: {
  imageRole: "expected" | "actual";
  coverage: ImageLocatorCoverage;
  elements: UiElement[];
}) {
  return {
    imageRole: input.imageRole,
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