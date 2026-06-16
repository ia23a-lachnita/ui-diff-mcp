import { describe, expect, it } from "vitest";
import { buildElementMap, projectElementsToActual, mergeLocatorLanes } from "../../src/locator/element-map.js";
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

describe("projectElementsToActual", () => {
  it("returns empty array for empty input", () => {
    expect(projectElementsToActual([], { width: 400, height: 800 })).toHaveLength(0);
  });

  it("creates projected elements with source=projected and proj- id prefix", () => {
    const expected = buildElementMap(
      [makeEl("buttons", "Submit", 10, 10, 80, 40)],
      { width: 200, height: 400 }
    );
    const projected = projectElementsToActual(expected, { width: 200, height: 400 });
    expect(projected).toHaveLength(1);
    expect(projected[0]?.source).toBe("projected");
    expect(projected[0]?.id).toMatch(/^proj-/);
    expect(projected[0]?.label).toBe(expected[0]?.label);
  });

  it("copies box coordinates unchanged when actual is same size as expected", () => {
    const expected = buildElementMap(
      [makeEl("buttons", "Save", 20, 30, 60, 25)],
      { width: 300, height: 600 }
    );
    const projected = projectElementsToActual(expected, { width: 300, height: 600 });
    expect(projected[0]?.box).toEqual(expected[0]?.box);
  });

  it("clamps box to actual image bounds when actual is smaller", () => {
    const expected = buildElementMap(
      [makeEl("buttons", "Footer button", 150, 350, 100, 50)],
      { width: 300, height: 400 }
    );
    // Actual is narrower — box should be clamped
    const projected = projectElementsToActual(expected, { width: 200, height: 400 });
    const box = projected[0]?.box;
    expect(box).toBeDefined();
    if (box) {
      expect(box.x + box.width).toBeLessThanOrEqual(200);
      expect(box.y + box.height).toBeLessThanOrEqual(400);
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
  });

  it("recomputes normalizedBox for actual image size", () => {
    const expected = buildElementMap(
      [makeEl("buttons", "OK", 0, 0, 100, 100)],
      { width: 200, height: 200 }
    );
    const projected = projectElementsToActual(expected, { width: 400, height: 400 });
    // Same pixel box but normalized differently
    expect(projected[0]?.normalizedBox.width).toBeCloseTo(0.25);
    expect(projected[0]?.normalizedBox.height).toBeCloseTo(0.25);
  });
});

describe("mergeLocatorLanes", () => {
  it("passes lanes from b that are absent in a through unchanged", () => {
    const result = mergeLocatorLanes(
      { cv_components: { status: "complete", count: 10 } },
      { ocr_text: { status: "complete", count: 5, model: "tesseract" } }
    );
    expect(result["cv_components"]).toEqual({ status: "complete", count: 10 });
    expect(result["ocr_text"]).toEqual({ status: "complete", count: 5, model: "tesseract" });
  });

  it("sums counts when both maps contain the same lane", () => {
    const result = mergeLocatorLanes(
      { cv_components: { status: "complete", count: 12 } },
      { cv_components: { status: "complete", count: 8 } }
    );
    expect(result["cv_components"]?.count).toBe(20);
    expect(result["cv_components"]?.status).toBe("complete");
  });

  it("takes the worse status when merging the same lane", () => {
    const result = mergeLocatorLanes(
      { ocr_text: { status: "complete", count: 7 } },
      { ocr_text: { status: "failed", count: 0, detail: "tesseract unavailable" } }
    );
    expect(result["ocr_text"]?.status).toBe("failed");
    expect(result["ocr_text"]?.count).toBe(7);
  });

  it("status rank: failed > not_configured > skipped > complete", () => {
    const statuses = ["complete", "skipped", "not_configured", "failed"] as const;
    for (let i = 0; i < statuses.length - 1; i++) {
      const worse = mergeLocatorLanes(
        { lane: { status: statuses[i]!, count: 1 } },
        { lane: { status: statuses[i + 1]!, count: 1 } }
      );
      expect(worse["lane"]?.status).toBe(statuses[i + 1]);
    }
  });

  it("preserves model/detail/license from the a-side entry when merging", () => {
    const result = mergeLocatorLanes(
      { cv_components: { status: "complete", count: 3, model: "opencv", license: "MIT" } },
      { cv_components: { status: "complete", count: 4 } }
    );
    expect(result["cv_components"]?.model).toBe("opencv");
    expect(result["cv_components"]?.license).toBe("MIT");
  });

  it("returns empty object when both inputs are empty", () => {
    expect(mergeLocatorLanes({}, {})).toEqual({});
  });

  it("takes detail from the worse (b) side when b wins the status", () => {
    const result = mergeLocatorLanes(
      { ocr_text: { status: "complete", count: 7 } },
      { ocr_text: { status: "failed", count: 0, detail: "tesseract unavailable" } }
    );
    expect(result["ocr_text"]?.detail).toBe("tesseract unavailable");
  });

  it("keeps detail from the better (a) side when a already holds the worse status", () => {
    const result = mergeLocatorLanes(
      { ocr_text: { status: "failed", count: 3, detail: "missing binary" } },
      { ocr_text: { status: "complete", count: 9 } }
    );
    expect(result["ocr_text"]?.status).toBe("failed");
    expect(result["ocr_text"]?.detail).toBe("missing binary");
  });
});
