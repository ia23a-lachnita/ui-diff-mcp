import type { Box } from "../schemas/core.js";

export interface EdgeComponent {
  box: Box;
  pixelCount: number;
  strength: number;
}

export interface EdgeMaskResult {
  mask: Uint8Array;
  width: number;
  height: number;
  components: EdgeComponent[];
}

function toGray(rgba: Buffer, idx: number): number {
  const r = rgba[idx] ?? 0;
  const g = rgba[idx + 1] ?? 0;
  const b = rgba[idx + 2] ?? 0;
  return Math.round(0.299 * r + 0.587 * g + 0.114 * b);
}

export function extractEdgeMask(
  rgba: Buffer,
  width: number,
  height: number,
  threshold = 30
): EdgeMaskResult {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = toGray(rgba, i * 4);
  }

  const edgeStrength = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const g = (row: number, col: number) => gray[row * width + col] ?? 0;
      const gx =
        -g(y - 1, x - 1) + g(y - 1, x + 1) +
        -2 * g(y, x - 1) + 2 * g(y, x + 1) +
        -g(y + 1, x - 1) + g(y + 1, x + 1);
      const gy =
        -g(y - 1, x - 1) - 2 * g(y - 1, x) - g(y - 1, x + 1) +
         g(y + 1, x - 1) + 2 * g(y + 1, x) + g(y + 1, x + 1);
      edgeStrength[y * width + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    mask[i] = (edgeStrength[i] ?? 0) >= threshold ? 1 : 0;
  }

  const components = labelEdgeComponents(mask, edgeStrength, width, height);
  return { mask, width, height, components };
}

function labelEdgeComponents(
  mask: Uint8Array,
  strength: Float32Array,
  width: number,
  height: number
): EdgeComponent[] {
  const labels = new Int32Array(width * height).fill(-1);
  let nextLabel = 0;
  const comps = new Map<number, { minX: number; minY: number; maxX: number; maxY: number; count: number; totalStrength: number }>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] === 0) continue;

      const above = y > 0 ? (labels[(y - 1) * width + x] ?? -1) : -1;
      const left = x > 0 ? (labels[y * width + (x - 1)] ?? -1) : -1;

      let label: number;
      if (above >= 0) label = above;
      else if (left >= 0) label = left;
      else label = nextLabel++;

      labels[idx] = label;
      const c = comps.get(label) ?? { minX: x, minY: y, maxX: x, maxY: y, count: 0, totalStrength: 0 };
      c.minX = Math.min(c.minX, x);
      c.minY = Math.min(c.minY, y);
      c.maxX = Math.max(c.maxX, x);
      c.maxY = Math.max(c.maxY, y);
      c.count++;
      c.totalStrength += strength[idx] ?? 0;
      comps.set(label, c);
    }
  }

  return [...comps.values()].map(c => ({
    box: { x: c.minX, y: c.minY, width: c.maxX - c.minX + 1, height: c.maxY - c.minY + 1 },
    pixelCount: c.count,
    strength: c.totalStrength / c.count
  }));
}
