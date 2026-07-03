import type { Box, DiffRecord, DiffSummary, ScopeDiffSummary, UiCriterion } from "../schemas/core.js";

interface ComponentLike {
  id?: string;
  box: Box;
  pixelCount: number;
}

export interface ScopeSummaryInput {
  imageWidth: number;
  imageHeight: number;
  pixelComponents: ComponentLike[];
  edgeComponents?: ComponentLike[];
  expectedRgba?: { data: Uint8Array; width: number; height: number };
  actualRgba?: { data: Uint8Array; width: number; height: number };
}

function regionBoxes(width: number, height: number): Array<{ id: string; label: string; box: Box }> {
  return [
    { id: "screen", label: "Whole screen", box: { x: 0, y: 0, width, height } },
    { id: "top", label: "Top third", box: { x: 0, y: 0, width, height: height / 3 } },
    { id: "middle", label: "Middle third", box: { x: 0, y: height / 3, width, height: height / 3 } },
    { id: "bottom", label: "Bottom third", box: { x: 0, y: (height * 2) / 3, width, height: height / 3 } },
    { id: "header", label: "Header", box: { x: 0, y: 0, width, height: height * 0.18 } },
    { id: "content", label: "Content", box: { x: 0, y: height * 0.18, width, height: height * 0.66 } },
    { id: "nav", label: "Bottom navigation", box: { x: 0, y: height * 0.84, width, height: height * 0.16 } }
  ];
}

function intersectionArea(a: Box, b: Box): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function componentPixelsInBox(components: ComponentLike[], box: Box): number {
  return components.reduce((sum, component) => {
    const componentArea = Math.max(1, component.box.width * component.box.height);
    const ratio = intersectionArea(component.box, box) / componentArea;
    return sum + component.pixelCount * ratio;
  }, 0);
}

function averageRgb(image: { data: Uint8Array; width: number; height: number } | undefined, box: Box): { r: number; g: number; b: number } | undefined {
  if (image === undefined) return undefined;
  const x1 = Math.max(0, Math.floor(box.x));
  const y1 = Math.max(0, Math.floor(box.y));
  const x2 = Math.min(image.width, Math.ceil(box.x + box.width));
  const y2 = Math.min(image.height, Math.ceil(box.y + box.height));
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const idx = (y * image.width + x) * 4;
      r += image.data[idx] ?? 0;
      g += image.data[idx + 1] ?? 0;
      b += image.data[idx + 2] ?? 0;
      count++;
    }
  }
  if (count === 0) return undefined;
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) };
}

function colorDistance(expected: { r: number; g: number; b: number } | undefined, actual: { r: number; g: number; b: number } | undefined): number {
  if (expected === undefined || actual === undefined) return 0;
  const dr = expected.r - actual.r;
  const dg = expected.g - actual.g;
  const db = expected.b - actual.b;
  return Number((Math.sqrt(dr * dr + dg * dg + db * db) / 441.67295593).toFixed(4));
}

function triggeredCriteria(changedPercent: number, edgePercent: number, box: Box, changedPixels: number, colorDelta: number): Exclude<UiCriterion, "unclassified_visual_change">[] {
  const criteria = new Set<Exclude<UiCriterion, "unclassified_visual_change">>();
  if (changedPercent > 2.5) criteria.add("geometry");
  if (changedPercent > 5) criteria.add("spacing_alignment");
  if (changedPercent > 8 || colorDelta > 0.08) criteria.add("color_appearance");
  if (edgePercent > 12 || (changedPixels > 0 && box.height < 180)) criteria.add("icon_image");
  if (changedPercent > 3 && (box.y === 0 || box.height < 180)) criteria.add("layering_clipping");
  if (changedPercent > 5) criteria.add("typography_content");
  return [...criteria];
}

export function buildScopeDiffSummaries(input: ScopeSummaryInput): ScopeDiffSummary[] {
  return regionBoxes(input.imageWidth, input.imageHeight).map(region => {
    const area = Math.max(1, region.box.width * region.box.height);
    const changedPixels = componentPixelsInBox(input.pixelComponents, region.box);
    const edgePixels = componentPixelsInBox(input.edgeComponents ?? [], region.box);
    const changedPixelPercent = Number(((changedPixels / area) * 100).toFixed(3));
    const edgeChangedPercent = Number(((edgePixels / area) * 100).toFixed(3));
    const expectedAvg = averageRgb(input.expectedRgba, region.box);
    const actualAvg = averageRgb(input.actualRgba, region.box);
    const scopeColorDistance = colorDistance(expectedAvg, actualAvg);
    return {
      id: region.id,
      kind: region.id === "screen" ? "screen" : "region",
      label: region.label,
      box: region.box,
      changedPixelPercent,
      edgeChangedPercent,
      triggeredCriteria: triggeredCriteria(changedPixelPercent, edgeChangedPercent, region.box, changedPixels, scopeColorDistance),
      measurements: [
        { name: "changed_pixel_percent", value: changedPixelPercent, unit: "percent" },
        { name: "edge_changed_percent", value: edgeChangedPercent, unit: "percent" },
        { name: "scope_color_distance", value: scopeColorDistance },
        ...(expectedAvg !== undefined ? [{ name: "scope_expected_avg_rgb", value: `rgb(${expectedAvg.r},${expectedAvg.g},${expectedAvg.b})` }] : []),
        ...(actualAvg !== undefined ? [{ name: "scope_actual_avg_rgb", value: `rgb(${actualAvg.r},${actualAvg.g},${actualAvg.b})` }] : [])
      ]
    };
  });
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export function buildDiffSummary(
  diffs: DiffRecord[],
  unresolvedRegionCount: number,
  scopeSummaries: ScopeDiffSummary[]
): DiffSummary {
  return {
    finalDiffCount: diffs.length,
    unresolvedRegionCount,
    bySeverity: countBy(diffs.map(diff => diff.severity)),
    byCriterion: countBy(diffs.map(diff => diff.criterion)),
    byClassificationSource: countBy(diffs.map(diff => diff.classificationSource ?? "unspecified")),
    scopeSummaries
  };
}
