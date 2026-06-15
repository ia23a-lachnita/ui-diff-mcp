import { describe, expect, it } from "vitest";
import { buildElementMap } from "../../src/locator/element-map.js";
import type { LocateAnythingElement } from "../../src/locator/locateanything-client.js";

function makeEl(id: string, label: string, x: number, y: number, w: number, h: number): LocateAnythingElement {
  return {
    queryId: id,
    label,
    box: { x, y, width: w, height: h },
    rawBox1000: [x * 5, y * 5, w * 5, h * 5],
    confidence: 0.9
  };
}

describe("buildElementMap", () => {
  it("creates elements from raw sidecar output", () => {
    const els = buildElementMap(
      [makeEl("q1", "Submit button", 10, 10, 80, 40)],
      { width: 200, height: 400 }
    );
    expect(els).toHaveLength(1);
    expect(els[0]?.label).toBe("Submit button");
    expect(els[0]?.type).toBe("button");
  });

  it("merges two locator boxes with IoU >= 0.82 into one element", () => {
    const a = makeEl("q1", "OK button", 10, 10, 80, 40);
    const b = makeEl("q2", "OK button", 11, 11, 80, 40);
    const els = buildElementMap([a, b], { width: 200, height: 400 });
    expect(els).toHaveLength(1);
  });

  it("does not merge boxes with low IoU", () => {
    const a = makeEl("q1", "button A", 10, 10, 40, 20);
    const b = makeEl("q2", "button B", 100, 100, 40, 20);
    const els = buildElementMap([a, b], { width: 300, height: 300 });
    expect(els).toHaveLength(2);
  });

  it("assigns parent/child when one box contains another", () => {
    const parent = makeEl("q1", "card", 0, 0, 200, 200);
    const child = makeEl("q2", "icon", 50, 50, 30, 30);
    const els = buildElementMap([parent, child], { width: 400, height: 400 });
    const parentEl = els.find(e => e.label === "card");
    const childEl = els.find(e => e.label === "icon");
    expect(parentEl?.childIds).toContain(childEl?.id);
    expect(childEl?.parentId).toBe(parentEl?.id);
  });

  it("generates stable IDs (same inputs → same ID)", () => {
    const input = [makeEl("q1", "button", 10, 20, 60, 30)];
    const r1 = buildElementMap(input, { width: 200, height: 400 });
    const r2 = buildElementMap(input, { width: 200, height: 400 });
    expect(r1[0]?.id).toBe(r2[0]?.id);
  });

  it("normalizes numeric-only label to type-queryId-index pattern", () => {
    const els = buildElementMap(
      [makeEl("buttons", "0", 10, 10, 80, 40)],
      { width: 200, height: 400 }
    );
    expect(els).toHaveLength(1);
    expect(els[0]?.label).not.toBe("0");
    expect(els[0]?.label).toMatch(/^button-buttons-/);
  });

  it("preserves source lane in queryId while merging overlapping boxes", () => {
    const els = buildElementMap([
      makeEl("ocr_text", "Calories", 10, 20, 100, 24),
      makeEl("yolo_ui", "Text", 12, 19, 98, 26)
    ], { width: 200, height: 400 });

    expect(els).toHaveLength(1);
    expect(els[0]?.queryId).toContain("ocr_text");
  });

  it("normalizes prompt-echo label starting with 'locate' to type-queryId-index pattern", () => {
    const els = buildElementMap(
      [makeEl("image_thumbnails_avatars", "Locate images thumbnails and avatars", 10, 10, 80, 80)],
      { width: 200, height: 400 }
    );
    expect(els).toHaveLength(1);
    expect(els[0]?.label).not.toMatch(/^locate /i);
    expect(els[0]?.label).toMatch(/^image-image_thumbnails_avatars-/);
  });

  it("preserves non-trivial labels unchanged", () => {
    const els = buildElementMap(
      [makeEl("buttons", "Submit button", 10, 10, 80, 40)],
      { width: 200, height: 400 }
    );
    expect(els[0]?.label).toBe("Submit button");
  });
});
