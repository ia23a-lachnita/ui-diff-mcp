import { describe, expect, it } from "vitest";
import type { UiElement } from "../../src/schemas/core.js";
import { suppressDuplicateElements } from "../../src/locator/nms.js";

function el(
  id: string,
  queryId: string,
  x: number,
  y: number,
  width: number,
  height: number,
  confidence: number,
  type: UiElement["type"] = "unknown"
): UiElement {
  return {
    id,
    label: id,
    type,
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
    expect(result[0]?.queryIds).toEqual(["ocr_text", "yolo_ui"]);
    expect(result[0]?.confidence).toBe(0.95);
  });

  it("normalizes legacy and explicit query IDs into sorted unique provenance", () => {
    const merged = suppressDuplicateElements([
      { ...el("a", "yolo_ui+ocr_text", 10, 20, 100, 40, 0.9), queryIds: ["z_lane", "ocr_text"] },
      { ...el("b", "ocr_text", 11, 21, 98, 38, 0.8), queryIds: ["ocr_text", "cv_components"] }
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.queryIds).toEqual(["cv_components", "ocr_text", "yolo_ui", "z_lane"]);
  });

  it("populates normalized provenance for an unmerged element", () => {
    const result = suppressDuplicateElements([
      { ...el("single", "yolo_ui+ocr_text", 10, 20, 20, 20, 0.9), queryIds: ["ocr_text", "z_lane"] }
    ]);

    expect(result[0]?.queryIds).toEqual(["ocr_text", "yolo_ui", "z_lane"]);
  });

  it("retains overlapping elements with different semantic roles for hierarchy selection", () => {
    const result = suppressDuplicateElements([
      el("button", "buttons", 10, 20, 100, 30, 0.95, "button"),
      el("text", "text_labels", 10.4, 20.4, 99.2, 29.2, 0.90, "text")
    ]);

    expect(result.map(element => element.type).sort()).toEqual(["button", "text"]);
  });
});
