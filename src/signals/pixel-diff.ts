import fs from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import type { Box } from "../schemas/core.js";

export interface PixelComponent {
  box: Box;
  pixelCount: number;
}

export interface PixelDiffResult {
  changedPixels: number;
  changedPercent: number;
  components: PixelComponent[];
  diffBuffer: Buffer;
  width: number;
  height: number;
}

function labelComponents(mask: Uint8Array, width: number, height: number): PixelComponent[] {
  const labels = new Int32Array(width * height).fill(-1);
  let nextLabel = 0;
  const componentPixels: Map<number, { minX: number; minY: number; maxX: number; maxY: number; count: number }> = new Map();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] === 0) continue;

      const above = y > 0 ? (labels[(y - 1) * width + x] ?? -1) : -1;
      const left = x > 0 ? (labels[y * width + (x - 1)] ?? -1) : -1;

      let label: number;
      if (above >= 0) {
        label = above;
      } else if (left >= 0) {
        label = left;
      } else {
        label = nextLabel++;
      }

      labels[idx] = label;
      const c = componentPixels.get(label) ?? { minX: x, minY: y, maxX: x, maxY: y, count: 0 };
      c.minX = Math.min(c.minX, x);
      c.minY = Math.min(c.minY, y);
      c.maxX = Math.max(c.maxX, x);
      c.maxY = Math.max(c.maxY, y);
      c.count++;
      componentPixels.set(label, c);
    }
  }

  return [...componentPixels.values()].map(c => ({
    box: { x: c.minX, y: c.minY, width: c.maxX - c.minX + 1, height: c.maxY - c.minY + 1 },
    pixelCount: c.count
  }));
}

export function computePixelDiff(
  expectedPngPath: string,
  actualPngPath: string
): PixelDiffResult {
  const expected = PNG.sync.read(fs.readFileSync(expectedPngPath));
  const actual = PNG.sync.read(fs.readFileSync(actualPngPath));

  const { width, height } = expected;
  const diffData = new Uint8Array(width * height * 4);
  const changed = pixelmatch(
    expected.data as unknown as Uint8Array,
    actual.data as unknown as Uint8Array,
    diffData,
    width,
    height,
    { threshold: 0.1, includeAA: false }
  );

  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = diffData[i * 4];
    mask[i] = r !== undefined && r > 128 ? 1 : 0;
  }

  const components = labelComponents(mask, width, height);
  const changedPercent = (changed / (width * height)) * 100;

  return {
    changedPixels: changed,
    changedPercent,
    components,
    diffBuffer: Buffer.from(diffData),
    width,
    height
  };
}
