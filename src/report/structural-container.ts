import type { UiElement } from "../schemas/core.js";

export const SEMANTIC_CONTAINER_TYPES = new Set<UiElement["type"]>([
  "card", "chart", "nav", "list_item", "button", "image"
]);

export function isStructuralContainer(
  element: Pick<UiElement, "type" | "source">,
  validChildCount: number
): boolean {
  return element.source !== "merged"
    && (SEMANTIC_CONTAINER_TYPES.has(element.type) || validChildCount >= 2);
}
