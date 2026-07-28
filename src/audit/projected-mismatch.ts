import {
  extractImageCrop,
  prepareRgbaForComparison
} from "../images/crop.js";
import type { Box } from "../schemas/core.js";
import { buildDisplacementSearchIndex, isUniqueDisplacementCandidate, searchDisplacementCandidates } from "../diff/displacement-search.js";

export interface ProjectedMismatchResult {
  mismatched: boolean;
  reason: "projected_crop_low_overlap" | "projected_crop_high_diff_mass" | "expected_target_absent_at_projected_location" | "projection_dimension_mismatch";
  changedPercent: number;
  expectedDominant: string;
  actualDominant: string;
  kind?: "absent_at_location" | "displaced";
}

export interface ProjectedDisplacementResult {
  dx: number;
  dy: number;
  edgeOverlap: number;
}

interface CropInput {
  data: Uint8Array;
  width: number;
  height: number;
}

function computeChangedPercent(exp: Uint8Array, act: Uint8Array, minLen: number): number {
  let changed = 0;
  const pixels = Math.floor(minLen / 4);
  for (let i = 0; i < pixels; i++) {
    const base = i * 4;
    const rDiff = Math.abs((exp[base] ?? 0) - (act[base] ?? 0));
    const gDiff = Math.abs((exp[base + 1] ?? 0) - (act[base + 1] ?? 0));
    const bDiff = Math.abs((exp[base + 2] ?? 0) - (act[base + 2] ?? 0));
    if (rDiff + gDiff + bDiff > 30) changed++;
  }
  return pixels > 0 ? (changed / pixels) * 100 : 0;
}

function dominantColorBucket(data: Uint8Array): string {
  const buckets = new Map<string, number>();
  const pixels = Math.floor(data.length / 4);
  for (let i = 0; i < pixels; i++) {
    const r = Math.floor((data[i * 4] ?? 0) / 64) * 64;
    const g = Math.floor((data[i * 4 + 1] ?? 0) / 64) * 64;
    const b = Math.floor((data[i * 4 + 2] ?? 0) / 64) * 64;
    const key = `${r},${g},${b}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  let best = "0,0,0";
  let bestCount = 0;
  for (const [key, count] of buckets) {
    if (count > bestCount) { bestCount = count; best = key; }
  }
  return best;
}

function computeTopColors(data: Uint8Array, topN: number): Set<string> {
  const buckets = new Map<string, number>();
  const pixels = Math.floor(data.length / 4);
  for (let i = 0; i < pixels; i++) {
    const r = Math.floor((data[i * 4] ?? 0) / 64) * 64;
    const g = Math.floor((data[i * 4 + 1] ?? 0) / 64) * 64;
    const b = Math.floor((data[i * 4 + 2] ?? 0) / 64) * 64;
    const key = `${r},${g},${b}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const sorted = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
  return new Set(sorted.slice(0, topN).map(e => e[0]));
}

function computePaletteIntersectionPercent(expData: Uint8Array, actData: Uint8Array): number {
  const expPalette = computeTopColors(expData, 3);
  const actPixels = Math.floor(actData.length / 4);
  if (actPixels === 0) return 0;
  let matches = 0;
  for (let i = 0; i < actPixels; i++) {
    const r = Math.floor((actData[i * 4] ?? 0) / 64) * 64;
    const g = Math.floor((actData[i * 4 + 1] ?? 0) / 64) * 64;
    const b = Math.floor((actData[i * 4 + 2] ?? 0) / 64) * 64;
    if (expPalette.has(`${r},${g},${b}`)) matches++;
  }
  return (matches / actPixels) * 100;
}

function computeEdgePixels(data: Uint8Array, width: number, height: number): Set<number> {
  const edges = new Set<number>();
  if (width < 3 || height < 3) return edges;
  const gray = (row: number, col: number): number => {
    const i = (row * width + col) * 4;
    return ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) / 3;
  };
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx = gray(y - 1, x + 1) + 2 * gray(y, x + 1) + gray(y + 1, x + 1)
               - gray(y - 1, x - 1) - 2 * gray(y, x - 1) - gray(y + 1, x - 1);
      const gy = gray(y + 1, x - 1) + 2 * gray(y + 1, x) + gray(y + 1, x + 1)
               - gray(y - 1, x - 1) - 2 * gray(y - 1, x) - gray(y - 1, x + 1);
      if (Math.sqrt(gx * gx + gy * gy) > 30) edges.add(y * width + x);
    }
  }
  return edges;
}

function pointInBox(x: number, y: number, box: Box): boolean {
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}

export async function findProjectedDisplacement(input: {
  expected: CropInput;
  actualImage: CropInput;
  projectedBox: Box;
  siblingBoxes?: Box[];
}): Promise<ProjectedDisplacementResult | null> {
  const candidates = await searchDisplacementCandidates({
    expected: input.expected,
    index: buildDisplacementSearchIndex(input.actualImage),
    projectedBox: input.projectedBox,
    ...(input.siblingBoxes ? { excludedBoxes: input.siblingBoxes } : {})
  });
  const best = candidates[0];
  return isUniqueDisplacementCandidate(best)
    ? { dx: best.dx, dy: best.dy, edgeOverlap: best.edgeOverlap }
    : null;
}

function computeEdgeOverlapPercent(
  expEdges: Set<number>,
  actEdges: Set<number>,
  width: number,
  height: number,
): number {
  if (expEdges.size === 0 && actEdges.size === 0) return 100;
  if (expEdges.size === 0 || actEdges.size === 0) return 0;
  let overlap = 0;
  for (const px of expEdges) {
    const x = px % width;
    const y = Math.floor(px / width);
    let found = false;
    // Check 3x3 neighborhood for a match
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < height) {
          if (actEdges.has(px + dx + dy * width)) {
            found = true;
            break;
          }
        }
      }
      if (found) break;
    }
    if (found) overlap++;
  }
  return (overlap / Math.max(expEdges.size, actEdges.size)) * 100;
}

export async function detectProjectedCropMismatch(
  expected: CropInput,
  actual: CropInput,
  expectedText?: string
): Promise<ProjectedMismatchResult | null> {
  if (expected.width <= 0 || expected.height <= 0 || actual.width <= 0 || actual.height <= 0) return null;
  if (expected.data.length < 4 || actual.data.length < 4) return null;
  const expectedDominant = dominantColorBucket(expected.data);
  const actualDominant = dominantColorBucket(actual.data);

  // When dimensions differ due to projection scaling, resize actual to expected dimensions
  // using Sharp/Lanczos3 before comparison. Nearest-neighbor would create artificial edges
  // in UI text, rings, and icons. Original crop buffers are not mutated.
  const preparedActual = await prepareRgbaForComparison(
    actual,
    expected.width,
    expected.height
  );
  const validRect = preparedActual.transform.rasterValidRect;
  if (validRect.width <= 0 || validRect.height <= 0) return null;
  const expectedComparableData = extractImageCrop(
    expected.data,
    expected.width,
    expected.height,
    validRect
  );
  const comparisonActualData = extractImageCrop(
    preparedActual.data,
    preparedActual.width,
    preparedActual.height,
    validRect
  );

  const comparisonActual: CropInput = {
    data: comparisonActualData,
    width: validRect.width,
    height: validRect.height
  };

  const minLen = Math.min(expectedComparableData.length, comparisonActual.data.length);
  const changedPercent = computeChangedPercent(expectedComparableData, comparisonActual.data, minLen);
  const paletteIntersection = computePaletteIntersectionPercent(expectedComparableData, comparisonActual.data);
  const expEdges = computeEdgePixels(expectedComparableData, validRect.width, validRect.height);
  const actEdges = computeEdgePixels(comparisonActual.data, comparisonActual.width, comparisonActual.height);
  const edgeOverlap = computeEdgeOverlapPercent(expEdges, actEdges, validRect.width, validRect.height);

  // If edge structure is well-preserved, it's a genuine element diff, not a projection miss
  if (edgeOverlap >= 30) {
    return { mismatched: false, reason: "projected_crop_high_diff_mass", changedPercent, expectedDominant, actualDominant };
  }

  const highDiffMass = changedPercent > 70;
  const lowEdgeOverlap = edgeOverlap < 15;
  const lowPaletteIntersection = paletteIntersection < 10;
  const textAbsent = !!expectedText && changedPercent > 50 && paletteIntersection < 20;

  const signals = [highDiffMass, lowEdgeOverlap, lowPaletteIntersection].filter(Boolean).length;
  const mismatched = signals >= 2 || textAbsent;

  if (!mismatched) {
    return { mismatched: false, reason: "projected_crop_high_diff_mass", changedPercent, expectedDominant, actualDominant };
  }

  const reason: ProjectedMismatchResult["reason"] = textAbsent
    ? "expected_target_absent_at_projected_location"
    : lowPaletteIntersection
    ? "projected_crop_low_overlap"
    : "projected_crop_high_diff_mass";

  return { mismatched: true, reason, changedPercent, expectedDominant, actualDominant, kind: "absent_at_location" };
}
