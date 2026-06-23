import { describe, expect, it } from "vitest";
import { buildDeterministicDiffs, unionBox } from "../../src/diff/deterministic-diffs.js";
import { createImagePairTransform } from "../../src/images/coordinates.js";
import type { ElementPair, UiElement } from "../../src/schemas/core.js";

function makeElement(id: string, x: number, y: number, w: number, h: number): UiElement {
  return {
    id,
    label: `element-${id}`,
    type: "button",
    box: { x, y, width: w, height: h },
    normalizedBox: { x: x / 400, y: y / 800, width: w / 400, height: h / 800 },
    confidence: 1,
    source: "locator",
    childIds: []
  };
}

function makePair(id: string, status: ElementPair["status"], expectedId?: string, actualId?: string): ElementPair {
  return { id, status, score: 1, reasons: [], expectedId, actualId };
}

describe("unionBox", () => {
  it("covers two non-overlapping boxes", () => {
    const a = { x: 10, y: 10, width: 20, height: 20 };
    const b = { x: 50, y: 50, width: 20, height: 20 };
    expect(unionBox(a, b)).toEqual({ x: 10, y: 10, width: 60, height: 60 });
  });

  it("is idempotent for identical boxes", () => {
    const a = { x: 5, y: 5, width: 10, height: 10 };
    expect(unionBox(a, a)).toEqual(a);
  });

  it("covers partially overlapping boxes", () => {
    const a = { x: 0, y: 0, width: 30, height: 30 };
    const b = { x: 20, y: 20, width: 30, height: 30 };
    expect(unionBox(a, b)).toEqual({ x: 0, y: 0, width: 50, height: 50 });
  });
});

describe("buildDeterministicDiffs", () => {
  it("produces geometry diff for 20px vertical shift", () => {
    const expected = makeElement("e1", 20, 50, 160, 20);
    const actual = makeElement("a1", 20, 70, 160, 20);
    const pair = makePair("p1", "matched", "e1", "a1");

    const diffs = buildDeterministicDiffs({
      pairs: [pair],
      expectedElements: [expected],
      actualElements: [actual],
      minMovePx: 4
    });

    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.criterion).toBe("geometry");
    expect(diffs[0]!.reviewerStatus).toBe("not_reviewed");
    expect(diffs[0]!.model).toBe("deterministic");
    // union box covers both old (y=50) and new (y=70) positions
    expect(diffs[0]!.location).toEqual({ x: 20, y: 50, width: 160, height: 40 });
  });

  it("sets severity=high for shift >= 12px", () => {
    const expected = makeElement("e1", 0, 0, 100, 30);
    const actual = makeElement("a1", 15, 0, 100, 30);
    const pair = makePair("p1", "matched", "e1", "a1");
    const diffs = buildDeterministicDiffs({ pairs: [pair], expectedElements: [expected], actualElements: [actual], minMovePx: 4 });
    expect(diffs[0]!.severity).toBe("high");
  });

  it("sets severity=medium for shift < 12px", () => {
    const expected = makeElement("e1", 0, 0, 100, 30);
    const actual = makeElement("a1", 5, 0, 100, 30);
    const pair = makePair("p1", "matched", "e1", "a1");
    const diffs = buildDeterministicDiffs({ pairs: [pair], expectedElements: [expected], actualElements: [actual], minMovePx: 4 });
    expect(diffs[0]!.severity).toBe("medium");
  });

  it("skips matched pairs below minMovePx threshold", () => {
    const expected = makeElement("e1", 0, 0, 100, 30);
    const actual = makeElement("a1", 1, 0, 100, 30); // delta = 1px
    const pair = makePair("p1", "matched", "e1", "a1");
    const diffs = buildDeterministicDiffs({ pairs: [pair], expectedElements: [expected], actualElements: [actual], minMovePx: 4 });
    expect(diffs).toHaveLength(0);
  });

  it("produces presence diff (high) for missing expected element", () => {
    const expected = makeElement("e1", 10, 10, 80, 30);
    const pair = makePair("p1", "missing", "e1", undefined);
    const diffs = buildDeterministicDiffs({ pairs: [pair], expectedElements: [expected], actualElements: [], minMovePx: 4 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.criterion).toBe("presence");
    expect(diffs[0]!.severity).toBe("high");
    expect(diffs[0]!.location).toEqual(expected.box);
  });

  it("produces presence diff (medium) for extra actual element", () => {
    const actual = makeElement("a1", 10, 10, 80, 30);
    const pair = makePair("p1", "extra", undefined, "a1");
    const diffs = buildDeterministicDiffs({ pairs: [pair], expectedElements: [], actualElements: [actual], minMovePx: 4 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.criterion).toBe("presence");
    expect(diffs[0]!.severity).toBe("medium");
    expect(diffs[0]!.location).toEqual(actual.box);
  });

  it("skips uncertain pairs", () => {
    const expected = makeElement("e1", 0, 0, 100, 30);
    const actual = makeElement("a1", 50, 0, 100, 30);
    const pair = makePair("p1", "uncertain", "e1", "a1");
    const diffs = buildDeterministicDiffs({ pairs: [pair], expectedElements: [expected], actualElements: [actual], minMovePx: 4 });
    expect(diffs).toHaveLength(0);
  });

  it("geometry diffs have classificationSource deterministic_geometry", () => {
    const expected = makeElement("e1", 0, 0, 100, 30);
    const actual = makeElement("a1", 0, 20, 100, 30);
    const pair = makePair("p1", "matched", "e1", "a1");
    const diffs = buildDeterministicDiffs({ pairs: [pair], expectedElements: [expected], actualElements: [actual], minMovePx: 4 });
    expect(diffs[0]!.classificationSource).toBe("deterministic_geometry");
  });

  it("missing element diffs have classificationSource deterministic_presence", () => {
    const expected = makeElement("e1", 10, 10, 80, 30);
    const pair = makePair("p1", "missing", "e1", undefined);
    const diffs = buildDeterministicDiffs({ pairs: [pair], expectedElements: [expected], actualElements: [], minMovePx: 4 });
    expect(diffs[0]!.classificationSource).toBe("deterministic_presence");
  });

  it("extra element diffs have classificationSource deterministic_presence", () => {
    const actual = makeElement("a1", 10, 10, 80, 30);
    const pair = makePair("p1", "extra", undefined, "a1");
    const diffs = buildDeterministicDiffs({ pairs: [pair], expectedElements: [], actualElements: [actual], minMovePx: 4 });
    expect(diffs[0]!.classificationSource).toBe("deterministic_presence");
  });

  it("each diff has unique id and at least one evidence string", () => {
    const expected = makeElement("e1", 0, 0, 100, 30);
    const actual = makeElement("a1", 0, 20, 100, 30);
    const pair = makePair("p1", "matched", "e1", "a1");
    const diffs = buildDeterministicDiffs({ pairs: [pair], expectedElements: [expected], actualElements: [actual], minMovePx: 4 });
    expect(diffs[0]!.id).toBeTruthy();
    expect(diffs[0]!.evidence.length).toBeGreaterThan(0);
  });

  it("includes delta measurements in geometry diffs", () => {
    const expected = makeElement("e1", 10, 10, 100, 30);
    const actual = makeElement("a1", 10, 30, 100, 30);
    const pair = makePair("p1", "matched", "e1", "a1");
    const diffs = buildDeterministicDiffs({ pairs: [pair], expectedElements: [expected], actualElements: [actual], minMovePx: 4 });
    const measurements = diffs[0]!.measurements;
    const names = measurements.map(m => m.name);
    expect(names).toContain("deltaX");
    expect(names).toContain("deltaY");
    expect(measurements.find(m => m.name === "deltaY")?.value).toBe(20);
  });

  it("with transform: normalizes actual.box to expected-space for delta, location, and evidence", () => {
    // Expected image 500×1000; actual image 1000×2000 (2× scale).
    const transform = createImagePairTransform({ width: 500, height: 1000 }, { width: 1000, height: 2000 });
    // Element at same relative position but 10px offset in expected-space.
    // In actual-image pixels that is 20px offset (2× scale).
    const expected = makeElement("e1", 0, 0, 100, 50);
    const actual = makeElement("a1", 20, 20, 200, 100); // 2× scale + 20px actual offset → 10px in expected space
    const pair = makePair("p1", "matched", "e1", "a1");

    const diffs = buildDeterministicDiffs({
      pairs: [pair], expectedElements: [expected], actualElements: [actual],
      minMovePx: 4, transform
    });
    expect(diffs).toHaveLength(1);
    const diff = diffs[0]!;

    // Delta must be in expected-space (10px), not raw actual-space (20px).
    expect(diff.measurements.find(m => m.name === "deltaX")?.value).toBe(10);
    expect(diff.measurements.find(m => m.name === "deltaY")?.value).toBe(10);

    // location must use normalised actual box so the union is in expected-space.
    // unionBox({0,0,100,50}, {10,10,100,50}) = {0,0,110,60}
    expect(diff.location.x).toBe(0);
    expect(diff.location.y).toBe(0);
    expect(diff.location.width).toBe(110);
    expect(diff.location.height).toBe(60);

    // Evidence must not report raw actual-space coordinates (20, 20, 200, 100).
    const evidenceText = diff.evidence.join(" ");
    expect(evidenceText).toContain("expected-space");
    expect(evidenceText).not.toContain("x=20");
    expect(evidenceText).not.toContain("w=200");
  });
});
