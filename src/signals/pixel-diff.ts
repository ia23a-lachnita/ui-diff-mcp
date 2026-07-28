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
  comparablePixels: number;
  excludedPixels: number;
  components: PixelComponent[];
  diffBuffer: Buffer;
  diffMask: Uint8Array;
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
  actualPngPath: string,
  validRect?: Box
): PixelDiffResult {
  const expected = PNG.sync.read(fs.readFileSync(expectedPngPath));
  const actual = PNG.sync.read(fs.readFileSync(actualPngPath));

  const { width, height } = expected;

  let actualData = actual.data as unknown as Uint8Array;
  if (actual.width !== width || actual.height !== height) {
    const canvas = new Uint8Array(width * height * 4);
    const copyW = Math.min(actual.width, width);
    const copyH = Math.min(actual.height, height);
    for (let row = 0; row < copyH; row++) {
      const src = row * actual.width * 4;
      const dst = row * width * 4;
      canvas.set((actual.data as unknown as Uint8Array).subarray(src, src + copyW * 4), dst);
    }
    actualData = canvas;
  }

  const diffData = new Uint8Array(width * height * 4);
  pixelmatch(
    expected.data as unknown as Uint8Array,
    actualData,
    diffData,
    width,
    height,
    {
      threshold: 0.1,
      includeAA: false,
      diffColor: [255, 0, 0],
      diffColorAlt: [0, 0, 255],
      aaColor: [255, 255, 0]
    }
  );

  const validLeft = Math.max(0, Math.ceil(validRect?.x ?? 0));
  const validTop = Math.max(0, Math.ceil(validRect?.y ?? 0));
  const validRight = Math.min(width, Math.floor(
    validRect === undefined ? width : validRect.x + validRect.width
  ));
  const validBottom = Math.min(height, Math.floor(
    validRect === undefined ? height : validRect.y + validRect.height
  ));
  const comparablePixels = Math.max(0, validRight - validLeft)
    * Math.max(0, validBottom - validTop);
  const mask = new Uint8Array(width * height);
  let changedPixels = 0;
  for (let i = 0; i < width * height; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    const comparable = x >= validLeft && x < validRight && y >= validTop && y < validBottom;
    if (!comparable) {
      diffData[i * 4] = 0;
      diffData[i * 4 + 1] = 0;
      diffData[i * 4 + 2] = 0;
      diffData[i * 4 + 3] = 0;
      continue;
    }
    const r = diffData[i * 4];
    const g = diffData[i * 4 + 1];
    const b = diffData[i * 4 + 2];
    const isDiffRed = r !== undefined && g !== undefined && b !== undefined && r > 200 && g < 80 && b < 80;
    const isDiffBlue = r !== undefined && g !== undefined && b !== undefined && b > 200 && r < 80 && g < 80;
    if (isDiffRed || isDiffBlue) {
      mask[i] = 255;
      changedPixels++;
    }
  }

  const components = labelComponents(mask, width, height);
  const changedPercent = comparablePixels > 0
    ? (changedPixels / comparablePixels) * 100
    : 0;

  return {
    changedPixels,
    changedPercent,
    comparablePixels,
    excludedPixels: width * height - comparablePixels,
    components,
    diffBuffer: Buffer.from(diffData),
    diffMask: mask,
    width,
    height
  };
}
