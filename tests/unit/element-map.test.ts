import { describe, expect, it } from "vitest";
import {
  buildElementMap,
  projectElementsToActual,
  mergeLocatorLanes,
  selectNearestContainingParents
} from "../../src/locator/element-map.js";
import { createImagePairTransform } from "../../src/images/coordinates.js";
import type { LocateAnythingElement } from "../../src/locator/locateanything-client.js";
import type { UiElement, UiElementType } from "../../src/schemas/core.js";

function makeEl(id: string, label: string, x: number, y: number, w: number, h: number): LocateAnythingElement {
  return {
    queryId: id,
    label,
    box: { x, y, width: w, height: h },
    rawBox1000: [x * 5, y * 5, w * 5, h * 5],
    confidence: 0.9
  };
}

function hierarchyElement(
  id: string,
  type: UiElementType,
  x: number,
  y: number,
  width: number,
  height: number,
  compactRoleSource?: "query_mapping" | "deterministic"
): UiElement {
  const element: UiElement = {
    id,
    label: id,
    type,
    box: { x, y, width, height },
    normalizedBox: { x: x / 500, y: y / 500, width: width / 500, height: height / 500 },
    confidence: 1,
    source: "locator",
    childIds: []
  };
  return compactRoleSource === undefined ? element : { ...element, compactRoleSource };
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

  it("removes leaked model grounding tokens while retaining ordinary label text", () => {
    const els = buildElementMap(
      [makeEl("buttons", "tate</ref> buttons and tappable controls", 10, 10, 80, 40)],
      { width: 200, height: 400 }
    );
    expect(els).toHaveLength(1);
    expect(els[0]?.label).toBe("tate buttons and tappable controls");
  });

  it("falls back when a label is empty after stripping model tokens", () => {
    const els = buildElementMap(
      [makeEl("icons", "<ref></ref> <5>", 10, 10, 30, 30)],
      { width: 200, height: 400 }
    );
    expect(els).toHaveLength(1);
    expect(els[0]?.label).toBe("icon-icons-0");
  });

  it("removes only known grounding tags before stable ID creation", () => {
    const els = buildElementMap(
      [makeEl("text_labels", "Score <ref>meter</ref> <box><1, 2, 3, 4></box> <aside>keep</aside> x < y </box>", 10, 10, 80, 40)],
      { width: 200, height: 400 }
    );

    expect(els[0]?.label).toBe("Score meter <aside>keep</aside> x < y");
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
    expect(els[0]?.queryIds).toEqual(["ocr_text", "yolo_ui"]);
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

  it("retains tight cross-role children through NMS before selecting their trusted compact parent", () => {
    const elements = buildElementMap([
      makeEl("buttons", "Filter", 10, 20, 100, 30),
      makeEl("text_labels", "Popular", 10.4, 20.4, 99.2, 29.2),
      makeEl("buttons", "More", 130, 20, 30, 30),
      makeEl("icons", "Chevron", 130.4, 20.4, 29.2, 29.2)
    ], { width: 240, height: 120 });
    const byLabel = new Map(elements.map(element => [element.label, element]));

    expect(elements).toHaveLength(4);
    expect(byLabel.get("Popular")?.parentId).toBe(byLabel.get("Filter")?.id);
    expect(byLabel.get("Chevron")?.parentId).toBe(byLabel.get("More")?.id);
  });

  it("does not grant compact parenting to a button-like label without trusted metadata", () => {
    const elements = buildElementMap([
      makeEl("untrusted_lane", "button-looking wrapper", 10, 20, 100, 30),
      makeEl("text_labels", "Label", 10.4, 20.4, 99.2, 29.2)
    ], { width: 240, height: 120 });
    const byLabel = new Map(elements.map(element => [element.label, element]));

    expect(byLabel.get("button-looking wrapper")?.type).toBe("button");
    expect(byLabel.get("Label")?.parentId).toBeUndefined();
  });

  it("assigns fallback labels and IDs stably across input permutations and exact duplicates", () => {
    const first = makeEl("icons", "Locate icons", 10, 20, 30, 30);
    const duplicate = makeEl("icons", "Locate icons", 10, 20, 30, 30);
    const second = makeEl("icons", "<ref></ref>", 100, 20, 30, 30);
    const summarize = (elements: LocateAnythingElement[]) => buildElementMap(elements, { width: 200, height: 120 })
      .map(element => ({ x: element.box.x, label: element.label, id: element.id }))
      .sort((a, b) => a.x - b.x);

    expect(summarize([first, second, duplicate])).toEqual(summarize([second, duplicate, first]));
    expect(summarize([first, second, duplicate])).toHaveLength(2);
    expect(summarize([first, second, duplicate]).map(element => element.label)).toEqual([
      "icon-icons-0",
      "icon-icons-1"
    ]);
  });
});

describe("selectNearestContainingParents", () => {
  it("selects the smallest enclosing parent and rebuilds stable child lists under input permutations", () => {
    const createElements = () => [
      hierarchyElement("outer", "card", 0, 0, 300, 300),
      hierarchyElement("inner", "card", 50, 50, 100, 100),
      hierarchyElement("leaf", "text", 75, 75, 30, 30)
    ];
    const permutations = [
      createElements(),
      [...createElements()].reverse(),
      [createElements()[1]!, createElements()[2]!, createElements()[0]!]
    ];

    for (const elements of permutations) {
      const selected = selectNearestContainingParents(elements);
      const byId = new Map(selected.map(element => [element.id, element]));
      expect(byId.get("leaf")?.parentId).toBe("inner");
      expect(byId.get("inner")?.parentId).toBe("outer");
      expect(byId.get("outer")?.childIds).toEqual(["inner"]);
      expect(byId.get("inner")?.childIds).toEqual(["leaf"]);
    }
  });

  it("breaks equal-area parent ties by stable ID", () => {
    const selected = selectNearestContainingParents([
      hierarchyElement("z-parent", "card", 0, 0, 100, 100),
      hierarchyElement("a-parent", "card", 50, 0, 100, 100),
      hierarchyElement("child", "text", 60, 40, 10, 10)
    ]);

    expect(selected.find(element => element.id === "child")?.parentId).toBe("a-parent");
  });

  it("allows tight recognized compact buttons to contain text or icons", () => {
    const selected = selectNearestContainingParents([
      hierarchyElement("chip", "button", 0, 0, 100, 30, "query_mapping"),
      hierarchyElement("chip-text", "text", 0.4, 0.4, 99.2, 29.2),
      hierarchyElement("icon-button", "button", 0, 40, 30, 30, "query_mapping"),
      hierarchyElement("icon", "icon", 0.4, 40.4, 29.2, 29.2)
    ]);

    expect(selected.find(element => element.id === "chip-text")?.parentId).toBe("chip");
    expect(selected.find(element => element.id === "icon")?.parentId).toBe("icon-button");
  });

  it("does not parent overlapping siblings or use compact containment for ordinary nodes", () => {
    const selected = selectNearestContainingParents([
      hierarchyElement("left", "card", 0, 0, 100, 100),
      hierarchyElement("right", "card", 50, 0, 100, 100),
      hierarchyElement("tight-card", "card", 0, 150, 100, 30),
      hierarchyElement("tight-text", "text", 0.4, 150.4, 99.2, 29.2)
    ]);
    const byId = new Map(selected.map(element => [element.id, element]));

    expect(byId.get("left")?.parentId).toBeUndefined();
    expect(byId.get("right")?.parentId).toBeUndefined();
    expect(byId.get("tight-text")?.parentId).toBeUndefined();
  });

  it("does not parent partial overlaps even when their centers are contained", () => {
    const selected = selectNearestContainingParents([
      hierarchyElement("ordinary", "card", 0, 0, 100, 100),
      hierarchyElement("ordinary-child", "text", 90, 40, 20, 20),
      hierarchyElement("compact", "button", 0, 150, 100, 30, "query_mapping"),
      hierarchyElement("compact-child", "icon", 0, 149, 100, 30)
    ]);
    const byId = new Map(selected.map(element => [element.id, element]));

    expect(byId.get("ordinary-child")?.parentId).toBeUndefined();
    expect(byId.get("compact-child")?.parentId).toBeUndefined();
  });

  it("does not give a non-button compact-role metadata relaxation", () => {
    const selected = selectNearestContainingParents([
      hierarchyElement("forged-card", "card", 0, 0, 100, 30, "deterministic"),
      hierarchyElement("tight-text", "text", 0.4, 0.4, 99.2, 29.2)
    ]);

    expect(selected.find(element => element.id === "tight-text")?.parentId).toBeUndefined();
  });
});

describe("projectElementsToActual", () => {
  it("returns empty array for empty input", () => {
    expect(projectElementsToActual([], createImagePairTransform({ width: 400, height: 800 }, { width: 400, height: 800 }))).toHaveLength(0);
  });

  it("creates projected elements with source=projected and proj- id prefix", () => {
    const expected = buildElementMap(
      [makeEl("buttons", "Submit", 10, 10, 80, 40)],
      { width: 200, height: 400 }
    );
    const projected = projectElementsToActual(expected, createImagePairTransform({ width: 200, height: 400 }, { width: 200, height: 400 }));
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
    const projected = projectElementsToActual(expected, createImagePairTransform({ width: 300, height: 600 }, { width: 300, height: 600 }));
    expect(projected[0]?.box).toEqual(expected[0]?.box);
  });

  it("scales and clamps box to actual image bounds when actual is smaller", () => {
    const expected = buildElementMap(
      [makeEl("buttons", "Footer button", 150, 350, 100, 50)],
      { width: 300, height: 400 }
    );
    // Actual is narrower — box should be scaled to actual coordinates
    const projected = projectElementsToActual(expected, createImagePairTransform({ width: 300, height: 400 }, { width: 200, height: 400 }));
    const box = projected[0]?.box;
    expect(box).toBeDefined();
    if (box) {
      expect(box.x + box.width).toBeLessThanOrEqual(200);
      expect(box.y + box.height).toBeLessThanOrEqual(400);
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
    }
  });

  it("scales box proportionally when actual is twice the expected size", () => {
    const expected = buildElementMap(
      [makeEl("buttons", "OK", 0, 0, 100, 100)],
      { width: 200, height: 200 }
    );
    const projected = projectElementsToActual(expected, createImagePairTransform({ width: 200, height: 200 }, { width: 400, height: 400 }));
    // Box at (0,0,100,100) in 200x200 expected scales to (0,0,200,200) in 400x400 actual
    expect(projected[0]?.box.width).toBeCloseTo(200);
    expect(projected[0]?.box.height).toBeCloseTo(200);
    // normalizedBox: 200/400 = 0.5
    expect(projected[0]?.normalizedBox.width).toBeCloseTo(0.5);
    expect(projected[0]?.normalizedBox.height).toBeCloseTo(0.5);
  });

  it("attaches projectionMetadata with scale factors from transform", () => {
    const expected = buildElementMap(
      [makeEl("buttons", "Submit", 10, 20, 80, 40)],
      { width: 200, height: 400 }
    );
    const sourceId = expected[0]!.id;
    const transform = createImagePairTransform({ width: 200, height: 400 }, { width: 240, height: 480 });
    const projected = projectElementsToActual(expected, transform);
    const meta = projected[0]?.projectionMetadata;
    expect(meta).toBeDefined();
    expect(meta?.mode).toBe("expected_coordinate_projection");
    expect(meta?.coordinateSpace).toBe("actual_source_image");
    expect(meta?.sourceElementId).toBe(sourceId);
    expect(meta?.scaleExpectedToActualX).toBeCloseTo(240 / 200, 3);
    expect(meta?.scaleExpectedToActualY).toBeCloseTo(480 / 400, 3);
  });

  it("always attaches projectionMetadata (transform is always present)", () => {
    const expected = buildElementMap(
      [makeEl("icons", "back", 5, 5, 30, 30)],
      { width: 200, height: 400 }
    );
    const projected = projectElementsToActual(expected, createImagePairTransform({ width: 200, height: 400 }, { width: 200, height: 400 }));
    expect(projected[0]?.projectionMetadata).toBeDefined();
    expect(projected[0]?.projectionMetadata?.scaleExpectedToActualX).toBeCloseTo(1.0, 5);
  });

  it("halves box dimensions when actual is half the expected size", () => {
    const expected = buildElementMap(
      [makeEl("buttons", "Search", 100, 200, 80, 40)],
      { width: 1200, height: 2400 }
    );
    const projected = projectElementsToActual(expected, createImagePairTransform({ width: 1200, height: 2400 }, { width: 600, height: 1200 }));
    const box = projected[0]?.box;
    expect(box?.x).toBeCloseTo(50);
    expect(box?.y).toBeCloseTo(100);
    expect(box?.width).toBeCloseTo(40);
    expect(box?.height).toBeCloseTo(20);
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
