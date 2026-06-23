import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  buildDisplacementSearchIndex,
  isUniqueDisplacementCandidate,
  searchDisplacementCandidates
} from "../../src/diff/displacement-search.js";

function rgba(width: number, height: number, value = 12): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return data;
}

function asymmetricTemplate(width = 24, height = 18): Uint8Array {
  const data = rgba(width, height, 18);
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      if (x < 6 || y > height - 7 || (x > 14 && y < 7)) {
        const offset = (y * width + x) * 4;
        data[offset] = 30;
        data[offset + 1] = 210;
        data[offset + 2] = 120;
      }
    }
  }
  return data;
}

function blit(target: Uint8Array, targetWidth: number, targetHeight: number, source: Uint8Array, sourceWidth: number, sourceHeight: number, x: number, y: number): void {
  for (let sy = 0; sy < sourceHeight; sy++) {
    for (let sx = 0; sx < sourceWidth; sx++) {
      const tx = x + sx;
      const ty = y + sy;
      if (tx < 0 || ty < 0 || tx >= targetWidth || ty >= targetHeight) continue;
      const sourceOffset = (sy * sourceWidth + sx) * 4;
      const targetOffset = (ty * targetWidth + tx) * 4;
      target.set(source.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
}

describe("displacement search", () => {
  it("finds a translation beyond the old 32px search radius", async () => {
    const width = 180;
    const height = 260;
    const expected = asymmetricTemplate();
    const actual = rgba(width, height);
    blit(actual, width, height, expected, 24, 18, 48, 170);
    const index = buildDisplacementSearchIndex({ data: actual, width, height });

    const candidates = await searchDisplacementCandidates({
      expected: { data: expected, width: 24, height: 18 },
      index,
      projectedBox: { x: 48, y: 30, width: 24, height: 18 },
      maxDx: 40,
      maxDy: 170
    });

    expect(candidates[0]?.dx).toBe(0);
    expect(candidates[0]?.dy).toBe(140);
    expect(candidates[0]?.edgeOverlap).toBeGreaterThanOrEqual(0.65);
    expect(isUniqueDisplacementCandidate(candidates[0])).toBe(true);
  });

  it("keeps repeated targets ambiguous instead of accepting the first best match", async () => {
    const width = 140;
    const height = 240;
    const expected = asymmetricTemplate(18, 18);
    const actual = rgba(width, height);
    blit(actual, width, height, expected, 18, 18, 30, 70);
    blit(actual, width, height, expected, 18, 18, 30, 160);
    const candidates = await searchDisplacementCandidates({
      expected: { data: expected, width: 18, height: 18 },
      index: buildDisplacementSearchIndex({ data: actual, width, height }),
      projectedBox: { x: 30, y: 20, width: 18, height: 18 },
      maxDx: 20,
      maxDy: 180
    });

    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0]!.runnerUpMargin).toBeLessThan(0.1);
    expect(isUniqueDisplacementCandidate(candidates[0])).toBe(false);
  });

  it("does not accept a low-scoring absent target", async () => {
    const expected = asymmetricTemplate();
    const actual = rgba(120, 180, 18);
    const candidates = await searchDisplacementCandidates({
      expected: { data: expected, width: 24, height: 18 },
      index: buildDisplacementSearchIndex({ data: actual, width: 120, height: 180 }),
      projectedBox: { x: 20, y: 20, width: 24, height: 18 }
    });

    expect(isUniqueDisplacementCandidate(candidates[0])).toBe(false);
  });

  it("builds reusable edge and color maps once per actual image", () => {
    const index = buildDisplacementSearchIndex({ data: rgba(40, 80), width: 40, height: 80 });
    expect(index.edgeMap).toBeInstanceOf(Uint8Array);
    expect(index.colorMap).toBeInstanceOf(Uint16Array);
    expect(index.edgeMap).toHaveLength(40 * 80);
    expect(index.colorMap).toHaveLength(40 * 80);
  });

  it("keeps a broad 256x512 search within the documented performance bound", async () => {
    const width = 256;
    const height = 512;
    const expected = asymmetricTemplate(32, 24);
    const actual = rgba(width, height);
    blit(actual, width, height, expected, 32, 24, 100, 360);
    const index = buildDisplacementSearchIndex({ data: actual, width, height });
    const run = () => searchDisplacementCandidates({
      expected: { data: expected, width: 32, height: 24 },
      index,
      projectedBox: { x: 100, y: 80, width: 32, height: 24 },
      maxDx: 60,
      maxDy: 320
    });
    await run();
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      await run();
      times.push(performance.now() - started);
    }
    expect(Math.min(...times)).toBeLessThan(250);
  });
});
