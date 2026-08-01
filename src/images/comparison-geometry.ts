import type {
  Box,
  ComparisonBoxRejectionReason,
  ComparisonBoxResolution,
  ComparisonBoxSourceSpace,
  GeometryDiagnosticReference,
  GeometryDiagnostics
} from "../schemas/core.js";
import type { ImagePairTransform } from "./coordinates.js";
import { projectActualBoxToExpectedSource } from "./coordinates.js";

export interface ResolveComparisonBoxInput {
  box: Box;
  sourceSpace: ComparisonBoxSourceSpace;
  canvas: { width: number; height: number };
  transform?: ImagePairTransform;
  minimumSize?: { width: number; height: number };
}

export interface ComparisonExtractionBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type ComparisonExtractionResolution =
  | {
    status: "valid";
    box: Box;
    bounds: ComparisonExtractionBounds;
    clipped: boolean;
    sourceSpace: ComparisonBoxSourceSpace;
  }
  | {
    status: "rejected";
    reason: ComparisonBoxRejectionReason;
    sourceSpace: ComparisonBoxSourceSpace;
  };

export interface ComparisonSpaceDeltaInput {
  expectedBox: Box;
  actualBox: Box;
  transform?: ImagePairTransform;
}

export type ComparisonSpaceDelta =
  | {
    comparable: true;
    coordinateSpace: "comparison_expected_normalized";
    dx: number;
    dy: number;
    dw: number;
    dh: number;
    positionDeltaPx: number;
    geometryDeltaPx: number;
  }
  | {
    comparable: false;
    coordinateSpace: "comparison_expected_normalized";
    reason: "no_comparable_intersection";
  };

const MINIMUM_ARTIFACT_SIZE = 2;

function intersectBoxes(a: Box, b: Box): Box | undefined {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function hasPositiveFiniteBox(box: Box): boolean {
  return [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.width > 0 && box.height > 0;
}

export function computeComparisonSpaceDelta(input: ComparisonSpaceDeltaInput): ComparisonSpaceDelta {
  if (!hasPositiveFiniteBox(input.expectedBox) || !hasPositiveFiniteBox(input.actualBox)) {
    return { comparable: false, coordinateSpace: "comparison_expected_normalized", reason: "no_comparable_intersection" };
  }

  const expectedComparable = input.transform
    ? intersectBoxes(input.expectedBox, input.transform.validRect)
    : input.expectedBox;
  const projectedActual = input.transform
    ? projectActualBoxToExpectedSource(input.actualBox, input.transform)
    : input.actualBox;
  const actualComparable = input.transform
    ? intersectBoxes(projectedActual, input.transform.validRect)
    : projectedActual;
  if (!expectedComparable || !actualComparable) {
    return { comparable: false, coordinateSpace: "comparison_expected_normalized", reason: "no_comparable_intersection" };
  }

  const dx = actualComparable.x - expectedComparable.x;
  const dy = actualComparable.y - expectedComparable.y;
  const dw = actualComparable.width - expectedComparable.width;
  const dh = actualComparable.height - expectedComparable.height;
  return {
    comparable: true,
    coordinateSpace: "comparison_expected_normalized",
    dx,
    dy,
    dw,
    dh,
    positionDeltaPx: Math.abs(dx) + Math.abs(dy),
    geometryDeltaPx: Math.max(
      Math.abs(dx),
      Math.abs(dy),
      Math.abs(dw),
      Math.abs(dh),
      Math.abs(dx + dw),
      Math.abs(dy + dh)
    )
  };
}

export function summarizeGeometryDiagnostics(references: GeometryDiagnosticReference[]): GeometryDiagnostics {
  const emptyCounts = (): Record<ComparisonBoxRejectionReason, number> => ({
    non_finite: 0,
    non_positive: 0,
    disjoint: 0,
    below_minimum_artifact_size: 0
  });
  const countsByReason = emptyCounts();
  const countsByProducer: Record<string, Record<ComparisonBoxRejectionReason, number>> = {};
  for (const diagnostic of references) {
    countsByReason[diagnostic.reason]++;
    const producerCounts = countsByProducer[diagnostic.producer] ??= emptyCounts();
    producerCounts[diagnostic.reason]++;
  }
  return { countsByReason, countsByProducer, references: [...references] };
}

// Preserve finite fractional comparison coordinates. Task 4 owns integer extraction rounding.
export function resolveComparisonBox(input: ResolveComparisonBoxInput): ComparisonBoxResolution {
  if (!hasFiniteDimensions(input.canvas)) {
    return reject("non_finite", input.sourceSpace);
  }
  if (input.canvas.width <= 0 || input.canvas.height <= 0) {
    return reject("non_positive", input.sourceSpace);
  }

  const minimumSize = resolveMinimumSize(input.minimumSize);
  if (!minimumSize) {
    return reject("below_minimum_artifact_size", input.sourceSpace);
  }

  const box = input.sourceSpace === "actual_normalized"
    ? projectActualBoxToExpectedSource(input.box, requireTransform(input))
    : input.box;

  if (!hasFiniteCoordinates(box)) {
    return reject("non_finite", input.sourceSpace);
  }
  if (box.width <= 0 || box.height <= 0) {
    return reject("non_positive", input.sourceSpace);
  }

  const x = Math.max(box.x, 0);
  const y = Math.max(box.y, 0);
  const boxRight = box.x + box.width;
  const boxBottom = box.y + box.height;
  if (!hasFiniteValues(x, y, boxRight, boxBottom)) {
    return reject("non_finite", input.sourceSpace);
  }

  const right = Math.min(boxRight, input.canvas.width);
  const bottom = Math.min(boxBottom, input.canvas.height);
  const width = right - x;
  const height = bottom - y;
  if (!hasFiniteValues(right, bottom, width, height)) {
    return reject("non_finite", input.sourceSpace);
  }

  if (width <= 0 || height <= 0) {
    return reject("disjoint", input.sourceSpace);
  }
  if (width < minimumSize.width || height < minimumSize.height) {
    return reject("below_minimum_artifact_size", input.sourceSpace);
  }

  return {
    status: "valid",
    box: { x, y, width, height },
    clipped: x !== box.x || y !== box.y || width !== box.width || height !== box.height,
    coordinateSpace: "comparison_expected_normalized",
    sourceSpace: input.sourceSpace
  };
}

// Image libraries require integer rectangles. Keep continuous validation above, then use one
// conservative floor/ceil conversion so fractional coverage is never silently discarded.
export function resolveComparisonExtraction(input: ResolveComparisonBoxInput): ComparisonExtractionResolution {
  const resolution = resolveComparisonBox(input);
  if (resolution.status === "rejected") {
    return { status: "rejected", reason: resolution.reason, sourceSpace: resolution.sourceSpace };
  }

  const left = Math.max(0, Math.floor(resolution.box.x));
  const top = Math.max(0, Math.floor(resolution.box.y));
  const right = Math.min(input.canvas.width, Math.ceil(resolution.box.x + resolution.box.width));
  const bottom = Math.min(input.canvas.height, Math.ceil(resolution.box.y + resolution.box.height));
  const width = right - left;
  const height = bottom - top;
  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(right) || !Number.isFinite(bottom)) {
    return { status: "rejected", reason: "non_finite", sourceSpace: input.sourceSpace };
  }
  if (width < MINIMUM_ARTIFACT_SIZE || height < MINIMUM_ARTIFACT_SIZE) {
    return { status: "rejected", reason: "below_minimum_artifact_size", sourceSpace: input.sourceSpace };
  }

  return {
    status: "valid",
    box: resolution.box,
    bounds: { left, top, width, height },
    clipped: resolution.clipped,
    sourceSpace: resolution.sourceSpace
  };
}

function resolveMinimumSize(
  minimumSize: ResolveComparisonBoxInput["minimumSize"]
): { width: number; height: number } | undefined {
  if (minimumSize === undefined) {
    return { width: MINIMUM_ARTIFACT_SIZE, height: MINIMUM_ARTIFACT_SIZE };
  }
  if (!hasFiniteDimensions(minimumSize)
    || minimumSize.width < MINIMUM_ARTIFACT_SIZE
    || minimumSize.height < MINIMUM_ARTIFACT_SIZE) {
    return undefined;
  }
  return minimumSize;
}

function requireTransform(input: ResolveComparisonBoxInput): ImagePairTransform {
  if (!input.transform) {
    throw new Error("ImagePairTransform is required for actual_normalized comparison boxes.");
  }
  return input.transform;
}

function hasFiniteCoordinates(box: Box): boolean {
  return hasFiniteValues(box.x, box.y, box.width, box.height);
}

function hasFiniteDimensions(dimensions: { width: number; height: number }): boolean {
  return hasFiniteValues(dimensions.width, dimensions.height);
}

function hasFiniteValues(...values: number[]): boolean {
  return values.every(Number.isFinite);
}

function reject(
  reason: Extract<ComparisonBoxResolution, { status: "rejected" }>["reason"],
  sourceSpace: ComparisonBoxSourceSpace
): ComparisonBoxResolution {
  return { status: "rejected", reason, sourceSpace };
}
