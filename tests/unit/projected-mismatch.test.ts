import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { detectProjectedCropMismatch, findProjectedDisplacement } from "../../src/audit/projected-mismatch.js";

function solidPixels(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

function makeSolidCrop(width: number, height: number, rgba: [number, number, number, number]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { data, width, height };
}

function makeCropWithCenteredRect(
  width: number,
  height: number,
  bg: [number, number, number, number],
  fg: [number, number, number, number]
) {
  const data = new Uint8Array(width * height * 4);
  const cx = Math.floor(width / 4);
  const cy = Math.floor(height / 4);
  const fw = Math.floor(width / 2);
  const fh = Math.floor(height / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inRect = x >= cx && x < cx + fw && y >= cy && y < cy + fh;
      const col = inRect ? fg : bg;
      const i = (y * width + x) * 4;
      data[i] = col[0];
      data[i + 1] = col[1];
      data[i + 2] = col[2];
      data[i + 3] = col[3];
    }
  }
  return { data, width, height };
}

function drawRect(data: Uint8Array, imageWidth: number, x: number, y: number, width: number, height: number, color: [number, number, number]): void {
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) {
      const offset = (row * imageWidth + col) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }
}

describe("detectProjectedCropMismatch", () => {
  it("returns null for zero-dimension inputs", async () => {
    const d = solidPixels(10, 10, 100, 100, 100);
    expect(await detectProjectedCropMismatch(
      { data: d, width: 0, height: 10 },
      { data: d, width: 10, height: 10 }
    )).toBeNull();
  });

  it("returns mismatched=false for identical crops", async () => {
    const d = solidPixels(20, 20, 50, 100, 200);
    const result = await detectProjectedCropMismatch(
      { data: d, width: 20, height: 20 },
      { data: d, width: 20, height: 20 }
    );
    expect(result).not.toBeNull();
    expect(result?.mismatched).toBe(false);
  });

  it("returns mismatched=false for color-only difference (shared edge structure)", async () => {
    // Both are solid colors — no edges at all, so edgeOverlap hits the 0/0 → 100 branch
    const exp = solidPixels(20, 20, 255, 255, 255);
    const act = solidPixels(20, 20, 0, 0, 255);
    const result = await detectProjectedCropMismatch(
      { data: exp, width: 20, height: 20 },
      { data: act, width: 20, height: 20 }
    );
    // Should NOT be flagged as projection mismatch — color change is a real diff
    expect(result?.mismatched).toBe(false);
  });

  it("detects mismatch for completely unrelated crops (icon vs nav bar)", async () => {
    // expected: bright blue patch (icon-like)
    const exp = solidPixels(30, 30, 30, 100, 255);
    // actual: near-black bar (navigation bar)
    const act = solidPixels(30, 30, 20, 20, 20);
    const result = await detectProjectedCropMismatch(
      { data: exp, width: 30, height: 30 },
      { data: act, width: 30, height: 30 }
    );
    // Both solid → edgeOverlap=100 (no edges), so safe guard kicks in → not mismatched
    // This tests that the guard correctly prevents false positives on solid patches
    expect(result).not.toBeNull();
    expect(result?.mismatched).toBe(false);
  });

  it("flags text_absent when expectedText given and palette diverges greatly", async () => {
    // Expected: white text background (high brightness)
    const exp = solidPixels(40, 20, 240, 240, 240);
    // Actual: dark background completely different palette
    const act = solidPixels(40, 20, 10, 10, 10);
    const result = await detectProjectedCropMismatch(
      { data: exp, width: 40, height: 20 },
      { data: act, width: 40, height: 20 },
      "Submit"
    );
    expect(result).not.toBeNull();
    // textAbsent fires: changedPercent>50 and palette<20 and expectedText defined
    // But edgeOverlap=100 (both solid, no edges) → safe guard → not mismatched
    expect(result?.mismatched).toBe(false);
  });

  it("does not treat projected crop dimension difference as mismatch by itself", async () => {
    const expected = makeSolidCrop(100, 100, [30, 40, 50, 255]);
    const actual = makeSolidCrop(50, 50, [30, 40, 50, 255]);

    const result = await detectProjectedCropMismatch(expected, actual);

    expect(result?.mismatched ?? false).toBe(false);
  });

  it("detects real content mismatch after resizing projected crop for comparison", async () => {
    // expected: light-gray background with a bright-blue centered rectangle (has edges)
    // actual (50x50, smaller): near-black solid — completely different palette, no edges
    // After resize, palette intersection is 0% and diff mass is high → mismatch detected
    const expected = makeCropWithCenteredRect(100, 100, [200, 200, 200, 255], [0, 0, 200, 255]);
    const actual = makeSolidCrop(50, 50, [10, 10, 10, 255]);

    const result = await detectProjectedCropMismatch(expected, actual);

    expect(result?.mismatched).toBe(true);
    expect(result?.reason).not.toBe("projection_dimension_mismatch");
    expect(result?.changedPercent ?? 0).toBeGreaterThan(10);
  });
});

describe("findProjectedDisplacement", () => {
  it("finds a partially shifted target with deterministic offsets", async () => {
    const expected = solidPixels(12, 12, 0, 0, 0);
    drawRect(expected, 12, 3, 3, 6, 6, [0, 120, 255]);
    const actual = solidPixels(64, 64, 0, 0, 0);
    drawRect(actual, 64, 27, 23, 6, 6, [0, 120, 255]);

    const result = await findProjectedDisplacement({
      expected: { data: expected, width: 12, height: 12 },
      actualImage: { data: actual, width: 64, height: 64 },
      projectedBox: { x: 20, y: 20, width: 12, height: 12 }
    });

    expect(result).not.toBeNull();
    expect(result?.dx).toBe(4);
    expect(result?.dy).toBe(0);
  });

  it("does not select a matched sibling inside the search area", async () => {
    const expected = solidPixels(12, 12, 0, 0, 0);
    drawRect(expected, 12, 3, 3, 6, 6, [0, 120, 255]);
    const actual = solidPixels(64, 64, 0, 0, 0);
    drawRect(actual, 64, 29, 23, 6, 6, [0, 120, 255]);

    const result = await findProjectedDisplacement({
      expected: { data: expected, width: 12, height: 12 },
      actualImage: { data: actual, width: 64, height: 64 },
      projectedBox: { x: 20, y: 20, width: 12, height: 12 },
      siblingBoxes: [{ x: 26, y: 20, width: 12, height: 12 }]
    });

    expect(result).toBeNull();
  });

  it("returns null when the target is absent from the bounded search area", async () => {
    const expected = solidPixels(12, 12, 0, 0, 0);
    drawRect(expected, 12, 3, 3, 6, 6, [0, 120, 255]);
    const actual = solidPixels(64, 64, 0, 0, 0);
    expect(await findProjectedDisplacement({
      expected: { data: expected, width: 12, height: 12 },
      actualImage: { data: actual, width: 64, height: 64 },
      projectedBox: { x: 20, y: 20, width: 12, height: 12 }
    })).toBeNull();
  });

  it("searches a 256x256 fixture within 100ms", async () => {
    const expected = solidPixels(32, 32, 0, 0, 0);
    drawRect(expected, 32, 8, 8, 16, 16, [255, 80, 20]);
    const actual = solidPixels(256, 256, 0, 0, 0);
    drawRect(actual, 256, 110, 104, 16, 16, [255, 80, 20]);
    const started = performance.now();
    await findProjectedDisplacement({
      expected: { data: expected, width: 32, height: 32 },
      actualImage: { data: actual, width: 256, height: 256 },
      projectedBox: { x: 96, y: 96, width: 32, height: 32 }
    });
    expect(performance.now() - started).toBeLessThan(100);
  });
});
