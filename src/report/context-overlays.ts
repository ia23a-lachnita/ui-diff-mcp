import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Box, DiffRecord, UiArtifact, UiElement, UnresolvedRegion } from "../schemas/core.js";
import { projectActualBoxToExpectedSource, type ImagePairTransform } from "../images/coordinates.js";

type AnnotationKind = "diff" | "unresolved" | "element" | "hierarchy";

interface Annotation {
  box: Box;
  label: string;
  kind: AnnotationKind;
}

export interface FindingGroup {
  id: string;
  box: Box;
  diffIds: string[];
  criteria: string[];
  severity: "low" | "medium" | "high";
  label: string;
}

export interface SemanticHierarchyNode {
  id: string;
  elementId?: string;
  label: string;
  type: UiElement["type"] | "screen";
  box: Box;
  parentNodeId?: string;
  childNodeIds: string[];
}

export interface OverlayStyle {
  fontSize: number;
  strokeWidth: number;
  labelHeight: number;
  diffFillOpacity: number;
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

function boxArea(box: Box): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function intersectBox(a: Box, b: Box): Box | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return undefined;
  return { x, y, width: right - x, height: bottom - y };
}

function overlapRatio(a: Box, b: Box): number {
  const overlap = intersectBox(a, b);
  if (!overlap) return 0;
  return boxArea(overlap) / Math.max(1, Math.min(boxArea(a), boxArea(b)));
}

function centerDistanceRatio(a: Box, b: Box): number {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  const distance = Math.hypot(ax - bx, ay - by);
  const scale = Math.max(a.width, a.height, b.width, b.height, 1);
  return distance / scale;
}

function severityRank(severity: "low" | "medium" | "high"): number {
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function groupShouldAbsorb(group: FindingGroup, diff: DiffRecord): boolean {
  const smaller = Math.max(1, Math.min(boxArea(group.box), boxArea(diff.location)));
  const larger = Math.max(boxArea(group.box), boxArea(diff.location));
  if (larger / smaller > 8) return false;
  return overlapRatio(group.box, diff.location) >= 0.35 || centerDistanceRatio(group.box, diff.location) <= 0.45;
}

export function buildFindingGroups(diffs: DiffRecord[]): FindingGroup[] {
  const groups: FindingGroup[] = [];
  const sorted = [...diffs].sort((a, b) => {
    const severityDelta = severityRank(b.severity) - severityRank(a.severity);
    return severityDelta !== 0 ? severityDelta : boxArea(b.location) - boxArea(a.location);
  });

  for (const diff of sorted) {
    const group = groups.find(existing => groupShouldAbsorb(existing, diff));
    if (!group) {
      const label = `G${groups.length + 1}`;
      groups.push({
        id: `group-${String(groups.length + 1).padStart(3, "0")}`,
        box: diff.location,
        diffIds: [diff.id],
        criteria: [diff.criterion],
        severity: diff.severity,
        label
      });
      continue;
    }

    group.box = unionBox(group.box, diff.location);
    group.diffIds.push(diff.id);
    group.criteria = [...new Set([...group.criteria, diff.criterion])].sort();
    if (severityRank(diff.severity) > severityRank(group.severity)) group.severity = diff.severity;
  }

  return groups;
}

export function overlayStyleForImage(width: number, height: number): OverlayStyle {
  const minSide = Math.min(width, height);
  const fontSize = Math.max(18, Math.round(minSide * 0.018));
  const strokeWidth = Math.max(3, Math.round(minSide * 0.004));
  return {
    fontSize,
    strokeWidth,
    labelHeight: Math.round(fontSize * 1.45),
    diffFillOpacity: 0.04
  };
}

function style(kind: AnnotationKind, overlayStyle: OverlayStyle): { stroke: string; fill: string } {
  switch (kind) {
    case "diff":
      return { stroke: "#22c55e", fill: `rgba(34,197,94,${overlayStyle.diffFillOpacity})` };
    case "unresolved":
      return { stroke: "#ff3bda", fill: "rgba(255,59,218,0.08)" };
    case "element":
      return { stroke: "#ffd23f", fill: "rgba(255,210,63,0.03)" };
    case "hierarchy":
      return { stroke: "#38bdf8", fill: "rgba(56,189,248,0.025)" };
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

function semanticParentId(element: UiElement, elementMap: Map<string, UiElement>): string | undefined {
  let current = element.parentId ? elementMap.get(element.parentId) : undefined;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (SEMANTIC_ELEMENT_TYPES.has(current.type)) return current.id;
    current = current.parentId ? elementMap.get(current.parentId) : undefined;
  }
  return undefined;
}

export function buildSemanticHierarchy(elements: UiElement[] = [], imageWidth: number, imageHeight: number): SemanticHierarchyNode[] {
  const semanticElements = elements.filter(element => SEMANTIC_ELEMENT_TYPES.has(element.type));
  const elementMap = new Map(elements.map(element => [element.id, element]));
  const nodes = new Map<string, SemanticHierarchyNode>();
  nodes.set("screen", {
    id: "screen",
    label: "Screen",
    type: "screen",
    box: { x: 0, y: 0, width: imageWidth, height: imageHeight },
    childNodeIds: []
  });

  for (const element of semanticElements) {
    nodes.set(element.id, {
      id: element.id,
      elementId: element.id,
      label: element.label,
      type: element.type,
      box: element.box,
      childNodeIds: []
    });
  }

  for (const element of semanticElements) {
    const parentId = semanticParentId(element, elementMap) ?? "screen";
    const node = nodes.get(element.id);
    const parent = nodes.get(parentId);
    if (!node || !parent || parent.id === node.id) continue;
    node.parentNodeId = parent.id;
    if (!parent.childNodeIds.includes(node.id)) parent.childNodeIds.push(node.id);
  }

  return [...nodes.values()];
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

function hierarchyAnnotations(nodes: SemanticHierarchyNode[]): Annotation[] {
  return nodes.map((node, index) => ({
    box: node.box,
    label: `H${String(index + 1).padStart(3, "0")} ${node.type} ${node.label}`.slice(0, 52),
    kind: "hierarchy" as const
  }));
}

function svgForAnnotations(width: number, height: number, annotations: Annotation[]): Buffer {
  const overlayStyle = overlayStyleForImage(width, height);
  const rects = annotations.map(annotation => {
    const box = clampBox(annotation.box, width, height);
    const s = style(annotation.kind, overlayStyle);
    const label = escapeXml(annotation.label);
    const labelY = Math.max(overlayStyle.labelHeight, box.y - 4);
    const labelWidth = Math.min(width - box.x, Math.max(80, label.length * overlayStyle.fontSize * 0.58 + 12));
    return `
      <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${s.fill}" stroke="${s.stroke}" stroke-width="${overlayStyle.strokeWidth}" vector-effect="non-scaling-stroke"/>
      <rect x="${box.x}" y="${labelY - overlayStyle.labelHeight}" width="${labelWidth}" height="${overlayStyle.labelHeight}" fill="rgba(0,0,0,0.78)" rx="4"/>
      <text x="${box.x + 6}" y="${labelY - Math.round(overlayStyle.fontSize * 0.32)}" fill="${s.stroke}" font-family="Arial, sans-serif" font-size="${overlayStyle.fontSize}" font-weight="700">${label}</text>`;
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

async function writeZoomPanel(
  baseImagePath: string,
  outPath: string,
  group: FindingGroup,
  index: number
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const metadata = await sharp(baseImagePath).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const pad = Math.max(32, Math.round(Math.max(group.box.width, group.box.height) * 0.35));
  const crop = clampBox({
    x: group.box.x - pad,
    y: group.box.y - pad,
    width: group.box.width + pad * 2,
    height: group.box.height + pad * 2
  }, width, height);
  const localBox = {
    x: group.box.x - crop.x,
    y: group.box.y - crop.y,
    width: group.box.width,
    height: group.box.height
  };
  const svg = svgForAnnotations(crop.width, crop.height, [{
    box: localBox,
    label: `${group.label} ${group.criteria.join(",")}`.slice(0, 52),
    kind: "diff"
  }]);
  await sharp(baseImagePath)
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .composite([{ input: svg, blend: "over" }])
    .png()
    .toFile(outPath);
}

async function writeJson(outPath: string, value: unknown): Promise<void> {
  await fs.writeFile(outPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeRegionContextOverlays(input: RegionContextOverlayInput): Promise<UiArtifact[]> {
  const metadata = await sharp(input.actualComparisonPath).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const elementBoxes = elementAnnotations(input.elements, input.actualElements, input.imagePairTransform);
  const hierarchyNodes = buildSemanticHierarchy(input.elements, width, height);
  const findingGroups = buildFindingGroups(input.diffs);
  const diffBoxes: Annotation[] = findingGroups.map(group => ({
    box: group.box,
    label: `${group.label} ${group.diffIds.length} ${group.criteria.join(",")}`.slice(0, 52),
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
  const groupPath = path.join(input.artifactDir, "final-diff-groups-overlay.png");
  const legendPath = path.join(input.artifactDir, "final-diff-groups-legend.json");
  const hierarchyPath = path.join(input.artifactDir, "semantic-hierarchy-overlay.png");
  const hierarchyLegendPath = path.join(input.artifactDir, "semantic-hierarchy-legend.json");

  await writeAnnotatedImage(input.actualComparisonPath, finalDiffPath, [...elementBoxes, ...diffBoxes]);
  await writeAnnotatedImage(input.actualComparisonPath, groupPath, diffBoxes);
  await writeAnnotatedImage(input.actualComparisonPath, unresolvedPath, [...elementBoxes, ...unresolvedBoxes]);
  await writeAnnotatedImage(input.directionalOverlayPath, contextPath, [...elementBoxes, ...diffBoxes, ...unresolvedBoxes]);
  await writeAnnotatedImage(input.actualComparisonPath, hierarchyPath, hierarchyAnnotations(hierarchyNodes));

  const maxZooms = Number.parseInt(process.env["UI_DIFF_MAX_CONTEXT_ZOOMS"] ?? "8", 10);
  const zoomGroups = findingGroups
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || boxArea(b.box) - boxArea(a.box))
    .slice(0, Math.max(0, maxZooms));
  const zoomArtifacts: UiArtifact[] = [];
  const legendGroups = [];
  for (const [index, group] of zoomGroups.entries()) {
    const zoomPath = path.join(input.artifactDir, `final-diff-zoom-${String(index + 1).padStart(3, "0")}.png`);
    await writeZoomPanel(input.actualComparisonPath, zoomPath, group, index + 1);
    zoomArtifacts.push({ role: "final_diff_zoom", path: zoomPath });
    legendGroups.push({
      id: group.id,
      label: group.label,
      box: group.box,
      diffIds: group.diffIds,
      criteria: group.criteria,
      severity: group.severity,
      zoomArtifact: zoomPath
    });
  }
  await writeJson(legendPath, { groups: legendGroups });
  await writeJson(hierarchyLegendPath, { nodes: hierarchyNodes });

  return [
    { role: "final_diff_regions_overlay", path: finalDiffPath },
    { role: "final_diff_groups_overlay", path: groupPath },
    { role: "final_diff_groups_legend", path: legendPath },
    ...zoomArtifacts,
    { role: "semantic_hierarchy_overlay", path: hierarchyPath },
    { role: "semantic_hierarchy_legend", path: hierarchyLegendPath },
    { role: "unresolved_regions_overlay", path: unresolvedPath },
    { role: "region_context_overlay", path: contextPath }
  ];
}
