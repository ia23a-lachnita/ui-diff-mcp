import type { Box } from "../schemas/core.js";

export interface ColorStats {
  avgR: number;
  avgG: number;
  avgB: number;
  avgA: number;
  dominantPalette: Array<{ r: number; g: number; b: number; count: number }>;
}

export interface ColorEvidence {
  oklabDistance: number;
  threshold: number;
  hasDiff: boolean;
  expectedAvg: { r: number; g: number; b: number; a: number };
  actualAvg: { r: number; g: number; b: number; a: number };
  dominantExpected: ColorStats["dominantPalette"];
  dominantActual: ColorStats["dominantPalette"];
  sampledRegion: Box;
  elementType: string;
}

// OKLab distance thresholds per element type.
// OKLab ranges from 0 (identical) to ~1 (white vs black).
// Anti-aliasing noise is typically < 0.02; values above 0.05 indicate
// a visible color change in controlled UI rendering.
export const COLOR_THRESHOLDS: Record<string, number> = {
  chart_indicator: 0.04,
  chart: 0.04,
  icon: 0.05,
  text_label: 0.05,
  text: 0.05,
  button: 0.06,
  tab_bar: 0.06,
  list_item: 0.06,
  card: 0.07,
  image_thumbnail: 0.08,
  image: 0.08,
  default: 0.07
};

function linearize(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function srgbToOklab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  const lr = linearize(r);
  const lg = linearize(g);
  const lb = linearize(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const lCbrt = Math.cbrt(l);
  const mCbrt = Math.cbrt(m);
  const sCbrt = Math.cbrt(s);

  return {
    L: 0.2104542553 * lCbrt + 0.7936177850 * mCbrt - 0.0040720468 * sCbrt,
    a: 1.9779984951 * lCbrt - 2.4285922050 * mCbrt + 0.4505937099 * sCbrt,
    b: 0.0259040371 * lCbrt + 0.7827717662 * mCbrt - 0.8086757660 * sCbrt
  };
}

export function computeOklabDistance(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number
): number {
  const lab1 = srgbToOklab(r1, g1, b1);
  const lab2 = srgbToOklab(r2, g2, b2);
  return Math.sqrt(
    (lab1.L - lab2.L) ** 2 +
    (lab1.a - lab2.a) ** 2 +
    (lab1.b - lab2.b) ** 2
  );
}

export function sampleColorStats(rgba: Uint8Array, imageWidth: number, box: Box): ColorStats {
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

export function computeColorEvidence(
  expectedRgba: Uint8Array,
  actualRgba: Uint8Array,
  expectedImageWidth: number,
  actualImageWidth: number,
  expectedBox: Box,
  actualBox: Box,
  elementType: string
): ColorEvidence {
  const expStats = sampleColorStats(expectedRgba, expectedImageWidth, expectedBox);
  const actStats = sampleColorStats(actualRgba, actualImageWidth, actualBox);

  const oklabDistance = computeOklabDistance(
    expStats.avgR, expStats.avgG, expStats.avgB,
    actStats.avgR, actStats.avgG, actStats.avgB
  );

  const threshold = COLOR_THRESHOLDS[elementType] ?? COLOR_THRESHOLDS["default"] ?? 0.07;

  // Reduce threshold when both sides are mostly opaque to avoid false positives
  // from semi-transparent or disabled-state elements.
  const bothOpaque = expStats.avgA > 200 && actStats.avgA > 200;
  const hasDiff = bothOpaque
    ? oklabDistance > threshold
    : oklabDistance > threshold * 1.5;

  return {
    oklabDistance: Math.round(oklabDistance * 10000) / 10000,
    threshold,
    hasDiff,
    expectedAvg: { r: expStats.avgR, g: expStats.avgG, b: expStats.avgB, a: expStats.avgA },
    actualAvg: { r: actStats.avgR, g: actStats.avgG, b: actStats.avgB, a: actStats.avgA },
    dominantExpected: expStats.dominantPalette,
    dominantActual: actStats.dominantPalette,
    sampledRegion: expectedBox,
    elementType
  };
}
