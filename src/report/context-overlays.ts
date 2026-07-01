import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Box, DiffRecord, UiArtifact, UiElement, UnresolvedRegion } from "../schemas/core.js";
import { projectActualBoxToExpectedSource, type ImagePairTransform } from "../images/coordinates.js";

type AnnotationKind = "diff" | "unresolved" | "element";

interface Annotation {
  box: Box;
  label: string;
  kind: AnnotationKind;
}

export interface RegionContextOverlayInput {
  actualComparisonPath: string;
  directionalOverlayPath: string;
  artifactDir: string;
  diffs: DiffRecord[];
  unresolvedRegions: UnresolvedRegion[];
  elements?: UiElement[];
  actualElements?: UiElement[];
  imagePairTransform?: ImagePairTransform;
}

const SEMANTIC_ELEMENT_TYPES = new Set<UiElement["type"]>([
  "card",
  "chart",
  "nav",
  "list_item",
  "button",
  "image"
]);

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clampBox(box: Box, width: number, height: number): Box {
  const x = Math.max(0, Math.min(Math.round(box.x), Math.max(0, width - 1)));
  const y = Math.max(0, Math.min(Math.round(box.y), Math.max(0, height - 1)));
  const right = Math.max(x + 1, Math.min(Math.round(box.x + box.width), width));
  const bottom = Math.max(y + 1, Math.min(Math.round(box.y + box.height), height));
  return { x, y, width: right - x, height: bottom - y };
}

function style(kind: AnnotationKind): { stroke: string; fill: string } {
  switch (kind) {
    case "diff":
      return { stroke: "#25d366", fill: "rgba(37,211,102,0.18)" };
    case "unresolved":
      return { stroke: "#ff3bda", fill: "rgba(255,59,218,0.20)" };
    case "element":
      return { stroke: "#ffd23f", fill: "rgba(255,210,63,0.06)" };
  }
}

function labelForDiff(diff: DiffRecord): string {
  return `${diff.id} ${diff.criterion}`.slice(0, 52);
}

function labelForRegion(region: UnresolvedRegion): string {
  return `${region.id} ${region.pixelCount}px`.slice(0, 52);
}

function labelForElement(element: UiElement): string {
  return `${element.type} ${element.label}`.slice(0, 52);
}

function elementAnnotations(
  elements: UiElement[] | undefined,
  actualElements: UiElement[] | undefined,
  transform: ImagePairTransform | undefined
): Annotation[] {
  const expected = (elements ?? [])
    .filter(element => SEMANTIC_ELEMENT_TYPES.has(element.type))
    .map(element => ({ box: element.box, label: labelForElement(element), kind: "element" as const }));
  const actual = (actualElements ?? [])
    .filter(element => SEMANTIC_ELEMENT_TYPES.has(element.type))
    .map(element => ({
      box: transform ? projectActualBoxToExpectedSource(element.box, transform) : element.box,
      label: `actual ${labelForElement(element)}`,
      kind: "element" as const
    }));
  return [...expected, ...actual];
}

function svgForAnnotations(width: number, height: number, annotations: Annotation[]): Buffer {
  const rects = annotations.map(annotation => {
    const box = clampBox(annotation.box, width, height);
    const s = style(annotation.kind);
    const label = escapeXml(annotation.label);
    const labelY = Math.max(12, box.y - 4);
    const labelWidth = Math.min(width - box.x, Math.max(48, label.length * 7 + 8));
    return `
      <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="3" vector-effect="non-scaling-stroke"/>
      <rect x="${box.x}" y="${labelY - 12}" width="${labelWidth}" height="14" fill="rgba(0,0,0,0.72)" rx="2"/>
      <text x="${box.x + 4}" y="${labelY - 2}" fill="${s.stroke}" font-family="Arial, sans-serif" font-size="10">${label}</text>`;
  }).join("\n");

  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      ${rects}
    </svg>
  `);
}

async function writeAnnotatedImage(
  baseImagePath: string,
  outPath: string,
  annotations: Annotation[]
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const metadata = await sharp(baseImagePath).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const svg = svgForAnnotations(width, height, annotations);
  await sharp(baseImagePath)
    .composite([{ input: svg, blend: "over" }])
    .png()
    .toFile(outPath);
}

export async function writeRegionContextOverlays(input: RegionContextOverlayInput): Promise<UiArtifact[]> {
  const elementBoxes = elementAnnotations(input.elements, input.actualElements, input.imagePairTransform);
  const diffBoxes: Annotation[] = input.diffs.map(diff => ({
    box: diff.location,
    label: labelForDiff(diff),
    kind: "diff"
  }));
  const unresolvedBoxes: Annotation[] = input.unresolvedRegions.map(region => ({
    box: region.location,
    label: labelForRegion(region),
    kind: "unresolved"
  }));

  const finalDiffPath = path.join(input.artifactDir, "final-diff-regions-overlay.png");
  const unresolvedPath = path.join(input.artifactDir, "unresolved-regions-overlay.png");
  const contextPath = path.join(input.artifactDir, "region-context-overlay.png");

  await writeAnnotatedImage(input.actualComparisonPath, finalDiffPath, [...elementBoxes, ...diffBoxes]);
  await writeAnnotatedImage(input.actualComparisonPath, unresolvedPath, [...elementBoxes, ...unresolvedBoxes]);
  await writeAnnotatedImage(input.directionalOverlayPath, contextPath, [...elementBoxes, ...diffBoxes, ...unresolvedBoxes]);

  return [
    { role: "final_diff_regions_overlay", path: finalDiffPath },
    { role: "unresolved_regions_overlay", path: unresolvedPath },
    { role: "region_context_overlay", path: contextPath }
  ];
}
