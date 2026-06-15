import { describe, expect, it } from "vitest";
import type { UiElement } from "../../src/schemas/core.js";
import { suppressDuplicateElements } from "../../src/locator/nms.js";

function el(id: string, queryId: string, x: number, y: number, width: number, height: number, confidence: number): UiElement {
  return {
    id,
    label: id,
    type: "unknown",
    queryId,
    box: { x, y, width, height },
    normalizedBox: { x: x / 200, y: y / 400, width: width / 200, height: height / 400 },
    confidence,
    source: "locator",
    childIds: []
  };
}

describe("suppressDuplicateElements", () => {
  it("keeps the best overlapping box and preserves contributing lanes", () => {
    const result = suppressDuplicateElements([
      el("ocr", "ocr_text", 10, 20, 100, 40, 0.70),
      el("yolo", "yolo_ui", 12, 21, 98, 39, 0.95),
      el("icon", "icons", 150, 20, 24, 24, 0.80)
    ], { iouThreshold: 0.72 });

    expect(result).toHaveLength(2);
    expect(result[0]?.queryId).toContain("ocr_text");
    expect(result[0]?.queryId).toContain("yolo_ui");
    expect(result[0]?.confidence).toBe(0.95);
  });
});