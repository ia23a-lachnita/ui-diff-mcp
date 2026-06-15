import { describe, expect, it } from "vitest";
import { pairElements } from "../../src/pairing/pair-elements.js";
import type { UiElement } from "../../src/schemas/core.js";

function makeElement(id: string, label: string, x: number, y: number, w: number, h: number, text?: string): UiElement {
  return {
    id,
    label,
    type: "button",
    box: { x, y, width: w, height: h },
    normalizedBox: { x: x / 400, y: y / 800, width: w / 400, height: h / 800 },
    text,
    confidence: 0.9,
    source: "locator",
    childIds: []
  };
}

describe("pairElements", () => {
  it("matches a shifted button pair", () => {
    const expected = [makeElement("e1", "Submit", 10, 50, 80, 40, "Submit")];
    const actual = [makeElement("a1", "Submit", 10, 65, 80, 40, "Submit")];
    const pairs = pairElements(expected, actual);
    expect(pairs.some(p => p.status === "matched" || p.status === "uncertain")).toBe(true);
  });

  it("produces missing for unpaired expected element", () => {
    const expected = [makeElement("e1", "Missing label", 10, 10, 80, 30, "Hello")];
    const actual: UiElement[] = [];
    const pairs = pairElements(expected, actual);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.status).toBe("missing");
    expect(pairs[0]?.expectedId).toBe("e1");
  });

  it("produces extra for unpaired actual element", () => {
    const expected: UiElement[] = [];
    const actual = [makeElement("a1", "Extra icon", 50, 50, 30, 30)];
    const pairs = pairElements(expected, actual);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.status).toBe("extra");
    expect(pairs[0]?.actualId).toBe("a1");
  });

  it("pairs cross-type elements with high geometry overlap (locator misclassification regression)", () => {
    // Simulates: expected is type=text with generated label "0", actual is type=image
    // with prompt-echo label — same region, shifted 20px. After label normalization both
    // get generated labels; pairing should succeed despite type mismatch because IoU >= 0.72.
    const expected: UiElement = {
      id: "e1", label: "text-buttons-0", type: "text",
      box: { x: 20, y: 50, width: 160, height: 20 },
      normalizedBox: { x: 0.05, y: 0.0625, width: 0.4, height: 0.025 },
      confidence: 0.9, source: "locator", childIds: []
    };
    const actual: UiElement = {
      id: "a1", label: "image-image_thumbnails_avatars-0", type: "image",
      box: { x: 20, y: 50, width: 160, height: 20 },
      normalizedBox: { x: 0.05, y: 0.0625, width: 0.4, height: 0.025 },
      confidence: 0.9, source: "locator", childIds: []
    };
    const pairs = pairElements([expected], [actual]);
    const matched = pairs.find(p => p.status === "matched" || p.status === "uncertain");
    expect(matched).toBeDefined();
    expect(matched?.expectedId).toBe("e1");
    expect(matched?.actualId).toBe("a1");
  });

  it("still rejects cross-type pairs with poor geometry overlap", () => {
    const expected: UiElement = {
      id: "e1", label: "text-q-0", type: "text",
      box: { x: 0, y: 0, width: 50, height: 20 },
      normalizedBox: { x: 0, y: 0, width: 0.125, height: 0.025 },
      confidence: 0.9, source: "locator", childIds: []
    };
    const actual: UiElement = {
      id: "a1", label: "image-q-0", type: "image",
      box: { x: 200, y: 300, width: 50, height: 20 },
      normalizedBox: { x: 0.5, y: 0.375, width: 0.125, height: 0.025 },
      confidence: 0.9, source: "locator", childIds: []
    };
    const pairs = pairElements([expected], [actual]);
    const matched = pairs.find(p => p.status === "matched");
    expect(matched).toBeUndefined();
  });

  it("assigns each element to at most one pair", () => {
    const expected = [
      makeElement("e1", "Button A", 10, 10, 80, 40, "A"),
      makeElement("e2", "Button B", 100, 10, 80, 40, "B")
    ];
    const actual = [
      makeElement("a1", "Button A", 10, 10, 80, 40, "A"),
      makeElement("a2", "Button B", 100, 10, 80, 40, "B")
    ];
    const pairs = pairElements(expected, actual);
    const matchedExpected = pairs.map(p => p.expectedId).filter(Boolean);
    const matchedActual = pairs.map(p => p.actualId).filter(Boolean);
    expect(new Set(matchedExpected).size).toBe(matchedExpected.length);
    expect(new Set(matchedActual).size).toBe(matchedActual.length);
  });
});
