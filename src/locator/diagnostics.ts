import type { LocatorInputSizing, UiElement } from "../schemas/core.js";
import type { ImageLocatorCoverage } from "./coverage.js";

export function buildTargetMapJson(input: {
  imageRole: "expected" | "actual";
  coverage: ImageLocatorCoverage;
  elements: UiElement[];
  elementsSource?: "independent" | "projected";
  locatorInputSizing?: LocatorInputSizing["expected"] | LocatorInputSizing["actual"];
}) {
  return {
    imageRole: input.imageRole,
    ...(input.elementsSource !== undefined ? { elementsSource: input.elementsSource } : {}),
    ...(input.locatorInputSizing !== undefined ? { locatorInputSizing: input.locatorInputSizing } : {}),
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
