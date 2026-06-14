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
  it("produces cyan for expected-only pixels (expected brighter)", async () => {
    const width = 4;
    const height = 4;
    // Expected: bright white; Actual: black — expected is brighter, so cyan
    const expected = solidRgba(width, height, 255, 255, 255);
    const actual = solidRgba(width, height, 0, 0, 0);
    const diffMask = new Uint8Array(width * height).fill(1);

    const outPath = path.join(tmpDir, "overlay-cyan.png");
    await createDirectionalDiffOverlay(expected, actual, diffMask, width, height, outPath);

    const [r, g, b] = await readPixel(outPath, 0, 0);
    expect(r).toBe(0);
    expect(g).toBe(255);
    expect(b).toBe(255);
  });

  it("produces magenta for actual-only pixels (actual brighter)", async () => {
    const width = 4;
    const height = 4;
    // Actual: bright white; Expected: black — actual is brighter, so magenta
    const expected = solidRgba(width, height, 0, 0, 0);
    const actual = solidRgba(width, height, 255, 255, 255);
    const diffMask = new Uint8Array(width * height).fill(1);

    const outPath = path.join(tmpDir, "overlay-magenta.png");
    await createDirectionalDiffOverlay(expected, actual, diffMask, width, height, outPath);

    const [r, g, b] = await readPixel(outPath, 0, 0);
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBe(255);
  });

  it("produces neutral gray for unchanged pixels (diffMask=0)", async () => {
    const width = 4;
    const height = 4;
    const expected = solidRgba(width, height, 255, 0, 0);
    const actual = solidRgba(width, height, 0, 0, 255);
    const diffMask = new Uint8Array(width * height).fill(0); // no diff

    const outPath = path.join(tmpDir, "overlay-neutral.png");
    await createDirectionalDiffOverlay(expected, actual, diffMask, width, height, outPath);

    const [r, g, b] = await readPixel(outPath, 0, 0);
    expect(r).toBe(128);
    expect(g).toBe(128);
    expect(b).toBe(128);
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
