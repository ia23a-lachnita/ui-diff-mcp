import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadNormalizedImage } from "../../src/images/normalize.js";
import { writeRectPng } from "../../src/testing/fixture-images.js";
import { area, containsCenter, expandBox, fromNormalizedBox, intersect, iou, toNormalizedBox } from "../../src/signals/geometry.js";
import { computePixelDiff } from "../../src/signals/pixel-diff.js";
import { sampleColorStats } from "../../src/signals/color.js";
import { extractEdgeMask } from "../../src/signals/edge.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-signals-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("geometry", () => {
  it("computes area", () => {
    expect(area({ x: 0, y: 0, width: 10, height: 20 })).toBe(200);
  });

  it("intersect: partial overlap", () => {
    const i = intersect(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 }
    );
    expect(i).not.toBeNull();
    expect(i!.width).toBe(5);
    expect(i!.height).toBe(5);
  });

  it("intersect: no overlap returns null", () => {
    expect(intersect(
      { x: 0, y: 0, width: 5, height: 5 },
      { x: 10, y: 10, width: 5, height: 5 }
    )).toBeNull();
  });

  it("iou: exact overlap is 1", () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(iou(box, box)).toBeCloseTo(1);
  });

  it("iou: no overlap is 0", () => {
    expect(iou(
      { x: 0, y: 0, width: 5, height: 5 },
      { x: 10, y: 10, width: 5, height: 5 }
    )).toBe(0);
  });

  it("iou: partial overlap is between 0 and 1", () => {
    const v = iou(
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 }
    );
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
  });

  it("normalized box round-trip", () => {
    const box = { x: 20, y: 40, width: 60, height: 80 };
    const nb = toNormalizedBox(box, 200, 400);
    const back = fromNormalizedBox(nb, 200, 400);
    expect(back.x).toBeCloseTo(box.x);
    expect(back.y).toBeCloseTo(box.y);
  });

  it("containsCenter", () => {
    const outer = { x: 0, y: 0, width: 100, height: 100 };
    const inner = { x: 40, y: 40, width: 20, height: 20 };
    expect(containsCenter(outer, inner)).toBe(true);
  });

  it("expandBox clamps to image bounds", () => {
    const box = { x: 0, y: 0, width: 10, height: 10 };
    const expanded = expandBox(box, 5, 100, 100);
    expect(expanded.x).toBe(0);
    expect(expanded.y).toBe(0);
    expect(expanded.width).toBe(15);
    expect(expanded.height).toBe(15);
  });
});

describe("pixelDiff", () => {
  it("detects components when a red rectangle shifts by 10px", async () => {
    const expectedPath = await writeRectPng(
      tmpDir, "expected.png", 100, 100,
      240, 240, 240,
      10, 10, 30, 30,
      255, 0, 0
    );
    const actualPath = await writeRectPng(
      tmpDir, "actual.png", 100, 100,
      240, 240, 240,
      20, 20, 30, 30,
      255, 0, 0
    );

    const result = computePixelDiff(expectedPath, actualPath);
    expect(result.changedPixels).toBeGreaterThan(0);
    expect(result.components.length).toBeGreaterThanOrEqual(1);
    const maskPixels = result.diffMask.reduce((count, v) => count + (v > 0 ? 1 : 0), 0);
    expect(maskPixels).toBe(result.changedPixels);
    expect(maskPixels).toBeLessThan(2000);

    const boxA = { x: 10, y: 10, width: 30, height: 30 };
    const boxB = { x: 20, y: 20, width: 30, height: 30 };
    expect(iou(boxA, boxB)).toBeLessThan(1);
  });
});

describe("colorSampling", () => {
  it("samples red inside a red rectangle fixture", async () => {
    const fixturePath = await writeRectPng(
      tmpDir, "color-fixture.png", 100, 100,
      240, 240, 240,
      10, 10, 40, 40,
      255, 0, 0
    );
    const normalized = await loadNormalizedImage(
      fixturePath,
      path.join(tmpDir, "norm.png")
    );

    const stats = sampleColorStats(normalized.rgba, normalized.width, { x: 10, y: 10, width: 40, height: 40 });
    expect(stats.avgR).toBeGreaterThan(200);
    expect(stats.avgG).toBeLessThan(50);
    expect(stats.avgB).toBeLessThan(50);
  });
});

describe("edgeDetection", () => {
  it("finds edges of a sharp rectangle", async () => {
    const fixturePath = await writeRectPng(
      tmpDir, "edge-fixture.png", 100, 100,
      255, 255, 255,
      20, 20, 60, 60,
      0, 0, 0
    );
    const normalized = await loadNormalizedImage(
      fixturePath,
      path.join(tmpDir, "norm-edge.png")
    );

    const result = extractEdgeMask(normalized.rgba, normalized.width, normalized.height);
    expect(result.components.length).toBeGreaterThan(0);

    const totalEdgePixels = result.components.reduce((sum, c) => sum + c.pixelCount, 0);
    // Perimeter of a 60x60 box is 240. Expect something in that ballpark.
    expect(totalEdgePixels).toBeGreaterThan(200);
    expect(totalEdgePixels).toBeLessThan(500);
  });
});
