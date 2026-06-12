import type { Box } from "../schemas/core.js";

export interface ColorStats {
  avgR: number;
  avgG: number;
  avgB: number;
  avgA: number;
  dominantPalette: Array<{ r: number; g: number; b: number; count: number }>;
}

export function sampleColorStats(rgba: Buffer, imageWidth: number, box: Box): ColorStats {
  const x0 = Math.round(box.x);
  const y0 = Math.round(box.y);
  const x1 = Math.round(box.x + box.width);
  const y1 = Math.round(box.y + box.height);

  let sumR = 0, sumG = 0, sumB = 0, sumA = 0, count = 0;
  const buckets = new Map<string, { r: number; g: number; b: number; count: number }>();

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * imageWidth + x) * 4;
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      const a = rgba[i + 3] ?? 255;
      sumR += r; sumG += g; sumB += b; sumA += a;
      count++;

      const qr = Math.round(r / 32) * 32;
      const qg = Math.round(g / 32) * 32;
      const qb = Math.round(b / 32) * 32;
      const key = `${qr},${qg},${qb}`;
      const bucket = buckets.get(key) ?? { r: qr, g: qg, b: qb, count: 0 };
      bucket.count++;
      buckets.set(key, bucket);
    }
  }

  if (count === 0) {
    return { avgR: 0, avgG: 0, avgB: 0, avgA: 0, dominantPalette: [] };
  }

  const dominantPalette = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    avgR: Math.round(sumR / count),
    avgG: Math.round(sumG / count),
    avgB: Math.round(sumB / count),
    avgA: Math.round(sumA / count),
    dominantPalette
  };
}
