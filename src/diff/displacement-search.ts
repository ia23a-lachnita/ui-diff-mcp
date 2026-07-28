import type { Box } from "../schemas/core.js";
import type { ComparisonExtractionBounds } from "../images/comparison-geometry.js";
import { prepareRgbaForComparison } from "../images/crop.js";

export interface RgbaSearchImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface DisplacementCandidate {
  dx: number;
  dy: number;
  score: number;
  edgeOverlap: number;
  colorAgreement: number;
  improvement: number;
  runnerUpMargin: number;
}

export interface DisplacementSearchIndex {
  width: number;
  height: number;
  edgeMap: Uint8Array;
  edgeProximityMap: Uint8Array;
  colorMap: Uint16Array;
}

interface ScoredOffset {
  dx: number;
  dy: number;
  score: number;
  edgeOverlap: number;
  colorAgreement: number;
}

function quantizeColor(r: number, g: number, b: number): number {
  return ((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5);
}

function buildMaps(image: RgbaSearchImage): Pick<DisplacementSearchIndex, "edgeMap" | "edgeProximityMap" | "colorMap"> {
  const size = image.width * image.height;
  const gray = new Uint8Array(size);
  const alpha = new Uint8Array(size);
  const colorMap = new Uint16Array(size);
  for (let pixel = 0; pixel < size; pixel++) {
    const offset = pixel * 4;
    const r = image.data[offset] ?? 0;
    const g = image.data[offset + 1] ?? 0;
    const b = image.data[offset + 2] ?? 0;
    alpha[pixel] = image.data[offset + 3] ?? 0;
    gray[pixel] = Math.round((r + g + b) / 3);
    colorMap[pixel] = quantizeColor(r, g, b);
  }

  const edgeMap = new Uint8Array(size);
  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      let opaqueNeighborhood = true;
      for (let oy = -1; oy <= 1 && opaqueNeighborhood; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if ((alpha[(y + oy) * image.width + x + ox] ?? 0) < 128) {
            opaqueNeighborhood = false;
            break;
          }
        }
      }
      if (!opaqueNeighborhood) continue;
      const at = (row: number, col: number) => gray[row * image.width + col] ?? 0;
      const gx = at(y - 1, x + 1) + 2 * at(y, x + 1) + at(y + 1, x + 1)
        - at(y - 1, x - 1) - 2 * at(y, x - 1) - at(y + 1, x - 1);
      const gy = at(y + 1, x - 1) + 2 * at(y + 1, x) + at(y + 1, x + 1)
        - at(y - 1, x - 1) - 2 * at(y - 1, x) - at(y - 1, x + 1);
      if (Math.sqrt(gx * gx + gy * gy) > 30) edgeMap[y * image.width + x] = 255;
    }
  }

  const edgeProximityMap = edgeMap.slice();
  for (let y = 1; y < image.height - 1; y++) {
    for (let x = 1; x < image.width - 1; x++) {
      const index = y * image.width + x;
      if (edgeMap[index] !== 255) continue;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nearby = (y + oy) * image.width + x + ox;
          if (edgeProximityMap[nearby] !== 255) edgeProximityMap[nearby] = 128;
        }
      }
    }
  }
  return { edgeMap, edgeProximityMap, colorMap };
}

export function buildDisplacementSearchIndex(image: RgbaSearchImage): DisplacementSearchIndex {
  return { width: image.width, height: image.height, ...buildMaps(image) };
}

function pointInBox(x: number, y: number, box: Box): boolean {
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}

function sampleEdgePoints(edgeMap: Uint8Array, colorMap: Uint16Array, width: number, maxPoints = 256): Array<{ x: number; y: number; color: number }> {
  const all: Array<{ x: number; y: number; color: number }> = [];
  for (let index = 0; index < edgeMap.length; index++) {
    if (edgeMap[index] !== 255) continue;
    all.push({ x: index % width, y: Math.floor(index / width), color: colorMap[index] ?? 0 });
  }
  if (all.length <= maxPoints) return all;
  const sampled: typeof all = [];
  const stride = all.length / maxPoints;
  for (let index = 0; index < maxPoints; index++) sampled.push(all[Math.floor(index * stride)]!);
  return sampled;
}

function offsetDistance(a: Pick<ScoredOffset, "dx" | "dy">, b: Pick<ScoredOffset, "dx" | "dy">): number {
  return Math.hypot(a.dx - b.dx, a.dy - b.dy);
}

function suppressNearby(candidates: ScoredOffset[], radius: number, limit: number): ScoredOffset[] {
  const kept: ScoredOffset[] = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score || Math.abs(a.dx) + Math.abs(a.dy) - Math.abs(b.dx) - Math.abs(b.dy))) {
    if (kept.some(existing => offsetDistance(existing, candidate) < radius)) continue;
    kept.push(candidate);
    if (kept.length === limit) break;
  }
  return kept;
}

export async function searchDisplacementCandidates(input: {
  expected: RgbaSearchImage;
  index: DisplacementSearchIndex;
  projectedBox: Box;
  actualBounds?: ComparisonExtractionBounds;
  maxDx?: number;
  maxDy?: number;
  coarseStride?: number;
  excludedBoxes?: Box[];
}): Promise<DisplacementCandidate[]> {
  const targetWidth = input.actualBounds?.width ?? Math.max(1, Math.round(input.projectedBox.width));
  const targetHeight = input.actualBounds?.height ?? Math.max(1, Math.round(input.projectedBox.height));
  const templateData = input.expected.width === targetWidth && input.expected.height === targetHeight
    ? input.expected.data
    : (await prepareRgbaForComparison(
        input.expected,
        targetWidth,
        targetHeight
      )).data;
  const templateMaps = buildMaps({ data: templateData, width: targetWidth, height: targetHeight });
  const points = sampleEdgePoints(templateMaps.edgeMap, templateMaps.colorMap, targetWidth);
  if (points.length < 4) return [];

  const originX = input.actualBounds?.left ?? Math.round(input.projectedBox.x);
  const originY = input.actualBounds?.top ?? Math.round(input.projectedBox.y);
  const maxDx = Math.max(0, Math.min(input.maxDx ?? Math.max(40, Math.round(input.index.width * 0.2)), 256));
  const maxDy = Math.max(0, Math.min(input.maxDy ?? Math.max(40, Math.round(input.index.height * 0.35)), 640));
  const coarseStride = Math.max(1, Math.round(input.coarseStride ?? 4));
  const excludedBoxes = input.excludedBoxes ?? [];

  const scoreAt = (dx: number, dy: number): ScoredOffset | undefined => {
    const left = originX + dx;
    const top = originY + dy;
    if (left < 0 || top < 0 || left + targetWidth > input.index.width || top + targetHeight > input.index.height) return undefined;
    const centerX = left + targetWidth / 2;
    const centerY = top + targetHeight / 2;
    if (excludedBoxes.some(box => pointInBox(centerX, centerY, box))) return undefined;
    let edgeScore = 0;
    let colorMatches = 0;
    let considered = 0;
    for (const point of points) {
      const x = left + point.x;
      const y = top + point.y;
      if (excludedBoxes.some(box => pointInBox(x, y, box))) continue;
      const index = y * input.index.width + x;
      edgeScore += (input.index.edgeProximityMap[index] ?? 0) / 255;
      if (input.index.colorMap[index] === point.color) colorMatches++;
      considered++;
    }
    if (considered < Math.max(4, Math.ceil(points.length * 0.25))) return undefined;
    const edgeOverlap = edgeScore / considered;
    const colorAgreement = colorMatches / considered;
    return { dx, dy, edgeOverlap, colorAgreement, score: edgeOverlap * 0.8 + colorAgreement * 0.2 };
  };

  const originScore = scoreAt(0, 0)?.score ?? 0;
  const coarse: ScoredOffset[] = [];
  for (let dy = -maxDy; dy <= maxDy; dy += coarseStride) {
    for (let dx = -maxDx; dx <= maxDx; dx += coarseStride) {
      if (dx === 0 && dy === 0) continue;
      const score = scoreAt(dx, dy);
      if (score && score.score >= 0.25) coarse.push(score);
    }
  }

  const coarseBest = suppressNearby(coarse, Math.max(6, coarseStride * 2), 12);
  const refined: ScoredOffset[] = [];
  for (const candidate of coarseBest) {
    let best = candidate;
    for (let dy = candidate.dy - coarseStride; dy <= candidate.dy + coarseStride; dy++) {
      for (let dx = candidate.dx - coarseStride; dx <= candidate.dx + coarseStride; dx++) {
        if (dx === 0 && dy === 0) continue;
        const score = scoreAt(dx, dy);
        if (score && (score.score > best.score || (score.score === best.score && Math.abs(dx) + Math.abs(dy) < Math.abs(best.dx) + Math.abs(best.dy)))) best = score;
      }
    }
    refined.push(best);
  }

  const finalists = suppressNearby(refined, Math.max(6, coarseStride * 2), 5);
  return finalists.map((candidate, index) => ({
    ...candidate,
    improvement: candidate.score - originScore,
    runnerUpMargin: Math.max(0, candidate.score - (finalists[index === 0 ? 1 : 0]?.score ?? 0))
  }));
}

export function isUniqueDisplacementCandidate(candidate: DisplacementCandidate | undefined): candidate is DisplacementCandidate {
  return candidate !== undefined
    && candidate.edgeOverlap >= 0.65
    && candidate.improvement >= 0.15
    && candidate.runnerUpMargin >= 0.10;
}
