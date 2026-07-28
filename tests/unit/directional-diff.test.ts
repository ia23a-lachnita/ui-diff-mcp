import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDirectionalDiffOverlay } from "../../src/images/directional-diff.js";
import type { Rgba } from "../../src/images/directional-diff.js";
import sharp from "sharp";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dir-diff-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function solidRgba(width: number, height: number, r: number, g: number, b: number): Rgba {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

async function readPixel(pngPath: string, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(pngPath).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset] ?? 0, data[offset + 1] ?? 0, data[offset + 2] ?? 0];
}

describe("createDirectionalDiffOverlay", () => {
  it("produces cyan for expected-only interior pixels (expected brighter)", async () => {
    // Use 6x6 grid so interior pixels (2,2) have all-diff neighbors and won't be yellow outlines
    const width = 6;
    const height = 6;
    const expected = solidRgba(width, height, 255, 255, 255);
    const actual = solidRgba(width, height, 0, 0, 0);
    const diffMask = new Uint8Array(width * height).fill(1);

    const outPath = path.join(tmpDir, "overlay-cyan.png");
    await createDirectionalDiffOverlay(expected, actual, diffMask, width, height, outPath);

    // Read center pixel — not an outline since all neighbors are also diff
    const [r, g, b] = await readPixel(outPath, 2, 2);
    expect(r).toBe(0);
    expect(g).toBe(255);
    expect(b).toBe(255);
  });

  it("produces magenta for actual-only interior pixels (actual brighter)", async () => {
    const width = 6;
    const height = 6;
    const expected = solidRgba(width, height, 0, 0, 0);
    const actual = solidRgba(width, height, 255, 255, 255);
    const diffMask = new Uint8Array(width * height).fill(1);

    const outPath = path.join(tmpDir, "overlay-magenta.png");
    await createDirectionalDiffOverlay(expected, actual, diffMask, width, height, outPath);

    const [r, g, b] = await readPixel(outPath, 2, 2);
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBe(255);
  });

  it("produces yellow outline at diff region border", async () => {
    const width = 6;
    const height = 6;
    const expected = solidRgba(width, height, 255, 255, 255);
    const actual = solidRgba(width, height, 0, 0, 0);
    // Only center 2x2 is diff — border pixels of the diff region are outlines
    const diffMask = new Uint8Array(width * height).fill(0);
    diffMask[2 * width + 2] = 1;
    diffMask[2 * width + 3] = 1;
    diffMask[3 * width + 2] = 1;
    diffMask[3 * width + 3] = 1;

    const outPath = path.join(tmpDir, "overlay-yellow.png");
    await createDirectionalDiffOverlay(expected, actual, diffMask, width, height, outPath);

    // (2,2) is a diff pixel adjacent to non-diff neighbors → yellow outline
    const [r, g, b] = await readPixel(outPath, 2, 2);
    expect(r).toBe(255);
    expect(g).toBe(255);
    expect(b).toBe(0);
  });

  it("produces neutral gray for unchanged pixels (diffMask=0)", async () => {
    const width = 4;
    const height = 4;
    const expected = solidRgba(width, height, 255, 0, 0);
    const actual = solidRgba(width, height, 0, 0, 255);
    const diffMask = new Uint8Array(width * height).fill(0);

    const outPath = path.join(tmpDir, "overlay-neutral.png");
    await createDirectionalDiffOverlay(expected, actual, diffMask, width, height, outPath);

    const [r, g, b] = await readPixel(outPath, 0, 0);
    expect(r).toBe(128);
    expect(g).toBe(128);
    expect(b).toBe(128);
  });

  it("hatches pixels outside the comparable rectangle", async () => {
    const width = 6;
    const height = 4;
    const expected = solidRgba(width, height, 100, 100, 100);
    const actual = solidRgba(width, height, 100, 100, 100);
    const diffMask = new Uint8Array(width * height);

    const outPath = path.join(tmpDir, "overlay-excluded.png");
    await createDirectionalDiffOverlay(
      expected,
      actual,
      diffMask,
      width,
      height,
      outPath,
      { x: 1, y: 0, width: 4, height: 4 }
    );

    expect(await readPixel(outPath, 0, 0)).not.toEqual([128, 128, 128]);
    expect(await readPixel(outPath, 2, 0)).toEqual([128, 128, 128]);
  });

  it("writes a valid PNG file", async () => {
    const width = 8;
    const height = 8;
    const expected = solidRgba(width, height, 100, 100, 100);
    const actual = solidRgba(width, height, 200, 200, 200);
    const diffMask = new Uint8Array(width * height).fill(1);

    const outPath = path.join(tmpDir, "overlay-valid.png");
    const result = await createDirectionalDiffOverlay(expected, actual, diffMask, width, height, outPath);

    expect(result).toBe(outPath);
    const stat = await fs.stat(outPath);
    expect(stat.size).toBeGreaterThan(0);
    const { info } = await sharp(outPath).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(width);
    expect(info.height).toBe(height);
  });
});
