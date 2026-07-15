import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Box, ComparisonBoxRejectionReason, DiffRecord, FindingGroupLegendEntry, GeometryDiagnosticReference, SemanticHierarchyNode, UiArtifact, UiElement, UnresolvedRegion } from "../schemas/core.js";
import type { ImagePairTransform } from "../images/coordinates.js";
import { resolveComparisonBox, resolveComparisonExtraction } from "../images/comparison-geometry.js";

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
  retainedFindingIds: string[];
  suppressions: NonNullable<DiffRecord["suppression"]>[];
  targetIds: string[];
  evidenceArea: number;
  coherentDisplacementKey: string | undefined;
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
  findingGroups?: FindingGroup[];
  unresolvedRegions: UnresolvedRegion[];
  elements?: UiElement[];
  actualElements?: UiElement[];
  imagePairTransform?: ImagePairTransform;
  geometryRejections?: GeometryDiagnosticReference[];
}

const SEMANTIC_ELEMENT_TYPES = new Set<UiElement["type"]>([
  "card",
  "chart",
  "nav",
  "list_item",
  "button",
  "image"
]);
const MAX_REPAIR_LOCAL_AREA_RATIO = 0.3;
const FINAL_DIFF_ZOOM_FILE_NAME = /^final-diff-zoom-\d+\.png$/;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clampBox(box: Box, width: number, height: number): Box | undefined {
  const resolution = resolveComparisonExtraction({
    box,
    sourceSpace: "comparison_expected_normalized",
    canvas: { width, height }
  });
  if (resolution.status === "rejected") return undefined;
  return { x: resolution.bounds.left, y: resolution.bounds.top, width: resolution.bounds.width, height: resolution.bounds.height };
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

function sharedSemanticContainer(a: FindingGroup, b: DiffRecord): boolean {
  const targets = new Set(a.targetIds);
  return (b.targetIds ?? []).some(id => targets.has(id));
}

function displacementDirection(finding: DiffRecord): string | undefined {
  if (finding.findingGroupKind === "coherent_displacement" && finding.findingGroupId !== undefined) {
    return `group:${finding.findingGroupId}`;
  }
  const horizontalValue = finding.measurements.find(measurement => measurement.name === "horizontal_shift")?.value;
  const verticalValue = finding.measurements.find(measurement => measurement.name === "vertical_shift")?.value;
  const horizontal = typeof horizontalValue === "number" ? horizontalValue : undefined;
  const vertical = typeof verticalValue === "number" ? verticalValue : undefined;
  if (!horizontal && !vertical) return undefined;
  return `${horizontal === undefined || horizontal === 0 ? "0" : horizontal > 0 ? "+" : "-"},${vertical === undefined || vertical === 0 ? "0" : vertical > 0 ? "+" : "-"}`;
}

function coherentSameDirection(group: FindingGroup, diff: DiffRecord): boolean {
  const direction = displacementDirection(diff);
  return direction !== undefined && group.coherentDisplacementKey === direction;
}

function isBroadFinding(diff: DiffRecord, canvas?: { width: number; height: number }): boolean {
  if (diff.repairLocality === "broad" || diff.scopeKind === "screen") return true;
  return canvas !== undefined && boxArea(diff.location) / Math.max(1, canvas.width * canvas.height) >= MAX_REPAIR_LOCAL_AREA_RATIO;
}

function groupShouldAbsorb(group: FindingGroup, diff: DiffRecord, canvas?: { width: number; height: number }): boolean {
  if (isBroadFinding(diff, canvas)) return false;
  const smaller = Math.max(1, Math.min(boxArea(group.box), boxArea(diff.location)));
  const larger = Math.max(boxArea(group.box), boxArea(diff.location));
  if (larger / smaller > 8) return false;
  const equivalentLocalGeometry = larger / smaller <= 1.25 && overlapRatio(group.box, diff.location) >= 0.9;
  if (equivalentLocalGeometry) return true;
  if (overlapRatio(group.box, diff.location) < 0.35 && centerDistanceRatio(group.box, diff.location) > 1.5) return false;
  if (!sharedSemanticContainer(group, diff) && !coherentSameDirection(group, diff)) return false;
  const union = unionBox(group.box, diff.location);
  if (canvas && boxArea(union) / Math.max(1, canvas.width * canvas.height) >= MAX_REPAIR_LOCAL_AREA_RATIO) return false;
  return boxArea(union) <= Math.max(1, group.evidenceArea + boxArea(diff.location)) * 3;
}

export function buildFindingGroups(diffs: DiffRecord[], canvas?: { width: number; height: number }): FindingGroup[] {
  const groups: FindingGroup[] = [];
  const sorted = [...diffs].sort((a, b) => {
    const severityDelta = severityRank(b.severity) - severityRank(a.severity);
    return severityDelta !== 0
      ? severityDelta
      : a.location.y - b.location.y || a.location.x - b.location.x || a.id.localeCompare(b.id);
  });

  for (const diff of sorted) {
    if (isBroadFinding(diff, canvas)) continue;
    const group = groups.find(existing => groupShouldAbsorb(existing, diff, canvas));
    if (!group) {
      const label = `G${groups.length + 1}`;
      groups.push({
        id: `group-${String(groups.length + 1).padStart(3, "0")}`,
        box: diff.location,
        diffIds: [diff.id],
        criteria: [diff.criterion],
        severity: diff.severity,
        label,
        retainedFindingIds: [...new Set([diff.id, ...(diff.suppression?.retainedFindingIds ?? [])])].sort(),
        suppressions: diff.suppression ? [diff.suppression] : [],
        targetIds: [...new Set(diff.targetIds ?? [])].sort(),
        evidenceArea: boxArea(diff.location),
        coherentDisplacementKey: displacementDirection(diff)
      });
      continue;
    }

    group.box = unionBox(group.box, diff.location);
    group.diffIds.push(diff.id);
    group.criteria = [...new Set([...group.criteria, diff.criterion])].sort();
    group.retainedFindingIds = [...new Set([
      ...group.retainedFindingIds,
      diff.id,
      ...(diff.suppression?.retainedFindingIds ?? [])
    ])].sort();
    if (diff.suppression) group.suppressions.push(diff.suppression);
    group.targetIds = [...new Set([...group.targetIds, ...(diff.targetIds ?? [])])].sort();
    group.evidenceArea += boxArea(diff.location);
    if (severityRank(diff.severity) > severityRank(group.severity)) group.severity = diff.severity;
  }

  return groups.map(group => ({
    ...group,
    diffIds: [...group.diffIds].sort((a, b) => a.localeCompare(b))
  }));
}

export function selectZoomGroups(findingGroups: FindingGroup[], maxZooms: number): FindingGroup[] {
  return findingGroups
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || boxArea(b.box) - boxArea(a.box) || a.id.localeCompare(b.id))
    .slice(0, Math.max(0, maxZooms));
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

// A node covering nearly the whole image duplicates the Screen root and adds
// no structure — its children re-parent upward instead.
const FULL_SCREEN_AREA_RATIO = 0.85;

const REF_TOKEN = /<\/?ref>/g;
const BOX_TOKEN = /<\/?box>/g;
const COORD_TOKEN = /<-?\d+(?:\s*,\s*-?\d+)*>/g;

function normalizeHierarchyLabel(rawLabel: string): string {
  return rawLabel
    .replace(REF_TOKEN, "")
    .replace(BOX_TOKEN, "")
    .replace(COORD_TOKEN, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isMeaningfulHierarchyLabel(label: string): boolean {
  return label.length > 0 && !/^\d+$/.test(label) && !label.toLowerCase().startsWith("locate ");
}

function nearestVisibleContainerAncestorId(
  element: UiElement,
  elementMap: Map<string, UiElement>,
  nodes: Map<string, SemanticHierarchyNode>
): string | undefined {
  let current = element.parentId ? elementMap.get(element.parentId) : undefined;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const node = nodes.get(current.id);
    if (node?.nodeRole === "container") return current.id;
    current = current.parentId ? elementMap.get(current.parentId) : undefined;
  }
  return undefined;
}

export function buildSemanticHierarchy(
  elements: UiElement[] = [],
  imageWidth: number,
  imageHeight: number,
  geometryRejections?: GeometryDiagnosticReference[]
): SemanticHierarchyNode[] {
  const sortedElements = [...elements].sort((a, b) => a.id.localeCompare(b.id));
  const elementMap = new Map(sortedElements.map(element => [element.id, element]));
  const imageArea = Math.max(1, imageWidth * imageHeight);
  const validElements = new Map<string, { element: UiElement; box: Box; label: string }>();
  for (const element of sortedElements) {
    const resolution = resolveComparisonBox({
      box: element.box,
      sourceSpace: "comparison_expected_normalized",
      canvas: { width: imageWidth, height: imageHeight }
    });
    if (resolution.status === "rejected") {
      geometryRejections?.push({
        producer: "semantic_hierarchy",
        reason: resolution.reason,
        reference: `element:${element.id}`
      });
      continue;
    }
    validElements.set(element.id, {
      element,
      box: resolution.box,
      label: normalizeHierarchyLabel(element.label)
    });
  }

  const validChildCounts = new Map<string, number>();
  for (const { element } of validElements.values()) {
    if (!element.parentId || !validElements.has(element.parentId)) continue;
    validChildCounts.set(element.parentId, (validChildCounts.get(element.parentId) ?? 0) + 1);
  }

  const nodes = new Map<string, SemanticHierarchyNode>();
  nodes.set("screen", {
    id: "screen",
    label: "Screen",
    type: "screen",
    box: { x: 0, y: 0, width: imageWidth, height: imageHeight },
    nodeRole: "screen",
    coordinateSpace: "comparison_expected_normalized",
    childNodeIds: []
  });

  for (const { element, box, label } of validElements.values()) {
    const nodeRole = SEMANTIC_ELEMENT_TYPES.has(element.type) || (validChildCounts.get(element.id) ?? 0) >= 2
      ? "container"
      : "leaf";
    if (boxArea(box) / imageArea >= FULL_SCREEN_AREA_RATIO) continue;
    if (nodeRole === "leaf" && !isMeaningfulHierarchyLabel(label)) continue;
    nodes.set(element.id, {
      id: element.id,
      elementId: element.id,
      label: isMeaningfulHierarchyLabel(label) ? label : `${element.type} ${element.id}`,
      type: element.type,
      box,
      nodeRole,
      coordinateSpace: "comparison_expected_normalized",
      childNodeIds: []
    });
  }

  for (const { element } of validElements.values()) {
    const node = nodes.get(element.id);
    if (!node || node.id === "screen") continue;
    const parentId = nearestVisibleContainerAncestorId(element, elementMap, nodes) ?? "screen";
    const parent = nodes.get(parentId);
    if (!parent || parent.id === node.id) continue;
    node.parentNodeId = parent.id;
    if (!parent.childNodeIds.includes(node.id)) parent.childNodeIds.push(node.id);
  }

  for (const node of nodes.values()) node.childNodeIds.sort((a, b) => a.localeCompare(b));
  return [nodes.get("screen")!, ...[...nodes.values()].filter(node => node.id !== "screen").sort((a, b) => a.id.localeCompare(b.id))];
}

function elementAnnotations(
  elements: UiElement[] | undefined,
  actualElements: UiElement[] | undefined,
  transform: ImagePairTransform | undefined,
  canvas: { width: number; height: number },
  geometryRejections?: GeometryDiagnosticReference[]
): Annotation[] {
  const expected = (elements ?? [])
    .filter(element => SEMANTIC_ELEMENT_TYPES.has(element.type))
    .flatMap(element => canonicalAnnotation({
      box: element.box,
      sourceSpace: "comparison_expected_normalized",
      canvas,
      label: labelForElement(element),
      kind: "element",
      rejectionReference: `element:${element.id}`,
      geometryRejections
    }));
  const actual = (actualElements ?? [])
    .filter(element => SEMANTIC_ELEMENT_TYPES.has(element.type))
    .flatMap(element => canonicalAnnotation({
      box: element.box,
      sourceSpace: transform ? "actual_normalized" : "comparison_expected_normalized",
      canvas,
      transform,
      label: `actual ${labelForElement(element)}`,
      kind: "element",
      rejectionReference: `actual-element:${element.id}`,
      geometryRejections
    }));
  return [...expected, ...actual];
}

function canonicalAnnotation(input: {
  box: Box;
  sourceSpace: "comparison_expected_normalized" | "actual_normalized";
  canvas: { width: number; height: number };
  transform?: ImagePairTransform | undefined;
  label: string;
  kind: AnnotationKind;
  rejectionReference: string;
  geometryRejections?: GeometryDiagnosticReference[] | undefined;
}): Annotation[] {
  const resolution = resolveComparisonBox({
    box: input.box,
    sourceSpace: input.sourceSpace,
    canvas: input.canvas,
    ...(input.transform ? { transform: input.transform } : {})
  });
  if (resolution.status === "rejected") {
    input.geometryRejections?.push({
      producer: "context_overlay_annotation",
      reason: resolution.reason,
      reference: input.rejectionReference
    });
    return [];
  }
  return [{ box: resolution.box, label: input.label, kind: input.kind }];
}

function unresolvedAnnotations(
  regions: UnresolvedRegion[],
  canvas: { width: number; height: number },
  geometryRejections?: GeometryDiagnosticReference[]
): Annotation[] {
  return regions.flatMap(region => canonicalAnnotation({
    box: region.location,
    sourceSpace: "comparison_expected_normalized",
    canvas,
    label: labelForRegion(region),
    kind: "unresolved",
    rejectionReference: `unresolved-region:${region.id}`,
    geometryRejections
  }));
}

function hierarchyAnnotations(nodes: SemanticHierarchyNode[]): Annotation[] {
  return nodes.map(node => ({
    box: node.box,
    label: `H ${node.id} ${node.nodeRole} ${node.label}`.slice(0, 52),
    kind: "hierarchy" as const
  }));
}

function svgForAnnotations(width: number, height: number, annotations: Annotation[]): Buffer {
  const overlayStyle = overlayStyleForImage(width, height);
  const rects = annotations.map(annotation => {
    const box = clampBox(annotation.box, width, height);
    if (!box) return "";
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
): Promise<{ status: "valid"; path: string } | { status: "rejected"; reason: ComparisonBoxRejectionReason }> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const metadata = await sharp(baseImagePath).metadata();
  if (!metadata.width || !metadata.height) return { status: "rejected", reason: "non_positive" };
  const width = metadata.width;
  const height = metadata.height;
  const groupResolution = resolveComparisonExtraction({
    box: group.box,
    sourceSpace: "comparison_expected_normalized",
    canvas: { width, height }
  });
  if (groupResolution.status === "rejected") return { status: "rejected", reason: groupResolution.reason };
  const pad = Math.max(32, Math.max(groupResolution.box.width, groupResolution.box.height) * 0.35);
  const cropResolution = resolveComparisonExtraction({
    box: {
    x: group.box.x - pad,
    y: group.box.y - pad,
    width: group.box.width + pad * 2,
    height: group.box.height + pad * 2
    },
    sourceSpace: "comparison_expected_normalized",
    canvas: { width, height }
  });
  if (cropResolution.status === "rejected") return { status: "rejected", reason: cropResolution.reason };
  const crop = cropResolution.bounds;
  const localBox = {
    x: groupResolution.box.x - crop.left,
    y: groupResolution.box.y - crop.top,
    width: groupResolution.box.width,
    height: groupResolution.box.height
  };
  const svg = svgForAnnotations(crop.width, crop.height, [{
    box: localBox,
    label: group.label,
    kind: "diff"
  }]);
  await sharp(baseImagePath)
    .extract(crop)
    .composite([{ input: svg, blend: "over" }])
    .png()
    .toFile(outPath);
  return { status: "valid", path: outPath };
}

async function writeJson(outPath: string, value: unknown): Promise<void> {
  await fs.writeFile(outPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function removeOrphanedZoomArtifacts(artifactDir: string, validZoomArtifacts: UiArtifact[]): Promise<void> {
  const validNames = new Set(validZoomArtifacts
    .map(artifact => path.basename(artifact.path))
    .filter(fileName => FINAL_DIFF_ZOOM_FILE_NAME.test(fileName)));
  const entries = await fs.readdir(artifactDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !FINAL_DIFF_ZOOM_FILE_NAME.test(entry.name) || validNames.has(entry.name)) continue;
    await fs.unlink(path.join(artifactDir, entry.name));
  }
}

export async function writeRegionContextOverlays(input: RegionContextOverlayInput): Promise<UiArtifact[]> {
  const metadata = await sharp(input.actualComparisonPath).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  const canvas = { width, height };
  const elementBoxes = elementAnnotations(input.elements, input.actualElements, input.imagePairTransform, canvas, input.geometryRejections);
  const hierarchyNodes = buildSemanticHierarchy(input.elements, width, height, input.geometryRejections);
  const findingGroups = input.findingGroups ?? buildFindingGroups(input.diffs, canvas);
  const diffBoxes: Annotation[] = findingGroups.map(group => ({
    box: group.box,
    label: group.label,
    kind: "diff"
  }));
  const unresolvedBoxes = unresolvedAnnotations(input.unresolvedRegions, canvas, input.geometryRejections);

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
  const zoomGroups = selectZoomGroups(findingGroups, maxZooms);
  const zoomArtifacts: UiArtifact[] = [];
  const legendGroups: FindingGroupLegendEntry[] = [];
  for (const [index, group] of findingGroups.entries()) {
    const legendGroup = {
      id: group.id,
      label: group.label,
      box: group.box,
      diffIds: group.diffIds,
      retainedFindingIds: group.retainedFindingIds,
      suppressions: group.suppressions,
      criteria: group.criteria as FindingGroupLegendEntry["criteria"],
      severity: group.severity,
      coordinateSpace: "comparison_expected_normalized" as const
    };
    const zoomIndex = zoomGroups.findIndex(candidate => candidate.id === group.id);
    if (zoomIndex < 0) {
      legendGroups.push({ ...legendGroup, zoomStatus: "skipped", zoomSkippedReason: "max_zooms_exceeded" });
      continue;
    }
    const zoomPath = path.join(input.artifactDir, `final-diff-zoom-${String(zoomIndex + 1).padStart(3, "0")}.png`);
    const zoom = await writeZoomPanel(input.actualComparisonPath, zoomPath, group, zoomIndex + 1);
    if (zoom.status === "valid") {
      zoomArtifacts.push({ role: "final_diff_zoom", path: zoom.path });
      legendGroups.push({ ...legendGroup, zoomStatus: "valid", zoomArtifact: zoom.path });
    } else {
      input.geometryRejections?.push({
        producer: "final_diff_zoom",
        reason: zoom.reason,
        reference: `finding-group:${group.id}`
      });
      legendGroups.push({ ...legendGroup, zoomStatus: "rejected", zoomRejectionReason: zoom.reason });
    }
  }
  await removeOrphanedZoomArtifacts(input.artifactDir, zoomArtifacts);
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
