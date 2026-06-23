import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Box, DiffRecord, ElementPair, ProjectedPreAuditSummary, UiArtifact, UiElement } from "../schemas/core.js";
import { detectProjectedCropMismatch, type ProjectedMismatchResult } from "../audit/projected-mismatch.js";
import { extractImageCrop, resizeRgbaForComparison } from "../images/crop.js";
import { createDirectionalDiffOverlay } from "../images/directional-diff.js";
import { buildDisplacementSearchIndex, searchDisplacementCandidates, type DisplacementCandidate } from "./displacement-search.js";
import {
  resolveDisplacementConsensus,
  resolveStructuralMismatchGroups,
  type DisplacementGroup,
  type StructuralMismatchGroup
} from "./displacement-consensus.js";

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface ProjectedPreAuditResult {
  diffs: DiffRecord[];
  skipVlmPairIds: Set<string>;
  summary: ProjectedPreAuditSummary;
}

interface MismatchEntry {
  pair: ElementPair;
  expected: UiElement;
  actual: UiElement;
  expectedCrop: Uint8Array;
  actualCrop: Uint8Array;
  result: ProjectedMismatchResult;
  candidates: DisplacementCandidate[];
}

type ActiveMismatchGroup = (DisplacementGroup & { kind: "coherent_displacement" }) | StructuralMismatchGroup;

function unionBoxes(boxes: Box[]): Box {
  const left = Math.min(...boxes.map(box => box.x));
  const top = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width));
  const bottom = Math.max(...boxes.map(box => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function translateBox(box: Box, dx: number, dy: number): Box {
  return { ...box, x: box.x + dx, y: box.y + dy };
}

function makeMask(expected: Uint8Array, actual: Uint8Array, width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let pixel = 0; pixel < mask.length; pixel++) {
    const offset = pixel * 4;
    const delta = Math.abs((expected[offset] ?? 0) - (actual[offset] ?? 0))
      + Math.abs((expected[offset + 1] ?? 0) - (actual[offset + 1] ?? 0))
      + Math.abs((expected[offset + 2] ?? 0) - (actual[offset + 2] ?? 0));
    mask[pixel] = delta > 30 ? 255 : 0;
  }
  return mask;
}

async function writeArtifactSet(input: {
  artifactDir: string;
  base: string;
  expected: Uint8Array;
  actual: Uint8Array;
  width: number;
  height: number;
  roles: [UiArtifact["role"], UiArtifact["role"], UiArtifact["role"], UiArtifact["role"]];
  pairId?: string;
  targetLabel?: string;
}): Promise<UiArtifact[]> {
  await fs.mkdir(input.artifactDir, { recursive: true });
  const expectedPath = path.join(input.artifactDir, `${input.base}-expected.png`);
  const actualPath = path.join(input.artifactDir, `${input.base}-actual.png`);
  const overlayPath = path.join(input.artifactDir, `${input.base}-overlay.png`);
  const maskPath = path.join(input.artifactDir, `${input.base}-mask.png`);
  const mask = makeMask(input.expected, input.actual, input.width, input.height);
  await sharp(Buffer.from(input.expected), { raw: { width: input.width, height: input.height, channels: 4 } }).png().toFile(expectedPath);
  await sharp(Buffer.from(input.actual), { raw: { width: input.width, height: input.height, channels: 4 } }).png().toFile(actualPath);
  await sharp(Buffer.from(mask), { raw: { width: input.width, height: input.height, channels: 1 } }).png().toFile(maskPath);
  await createDirectionalDiffOverlay(
    { data: input.expected, width: input.width, height: input.height },
    { data: input.actual, width: input.width, height: input.height },
    mask,
    input.width,
    input.height,
    overlayPath
  );
  const metadata = {
    ...(input.pairId ? { pairId: input.pairId } : {}),
    ...(input.targetLabel ? { targetLabel: input.targetLabel } : {})
  };
  return [
    { role: input.roles[0], path: expectedPath, ...metadata },
    { role: input.roles[1], path: actualPath, ...metadata },
    { role: input.roles[2], path: overlayPath, ...metadata },
    { role: input.roles[3], path: maskPath, ...metadata }
  ];
}

async function writeChildArtifacts(entry: MismatchEntry, artifactDir: string): Promise<UiArtifact[]> {
  const width = Math.max(1, Math.round(entry.expected.box.width));
  const height = Math.max(1, Math.round(entry.expected.box.height));
  const actual = entry.actual.box.width === entry.expected.box.width && entry.actual.box.height === entry.expected.box.height
    ? entry.actualCrop
    : await resizeRgbaForComparison(
        { data: entry.actualCrop, width: Math.max(1, Math.round(entry.actual.box.width)), height: Math.max(1, Math.round(entry.actual.box.height)) },
        width,
        height
      );
  return writeArtifactSet({
    artifactDir,
    base: `projected-${entry.pair.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    expected: entry.expectedCrop,
    actual,
    width,
    height,
    roles: ["projected_expected_crop", "projected_actual_crop", "projected_directional_overlay", "projected_pixel_diff_mask"],
    pairId: entry.pair.id,
    targetLabel: entry.expected.label
  });
}

async function writeGroupArtifacts(group: ActiveMismatchGroup, members: MismatchEntry[], input: {
  expectedRgba: RgbaImage;
  actualRgba: RgbaImage;
  artifactDir: string;
}): Promise<UiArtifact[]> {
  const expectedBox = unionBoxes(members.map(member => member.expected.box));
  const projectedActualBox = unionBoxes(members.map(member => member.actual.box));
  const actualBox = group.kind === "coherent_displacement"
    ? translateBox(projectedActualBox, group.dx, group.dy)
    : projectedActualBox;
  const width = Math.max(1, Math.round(expectedBox.width));
  const height = Math.max(1, Math.round(expectedBox.height));
  const expected = extractImageCrop(input.expectedRgba.data, input.expectedRgba.width, input.expectedRgba.height, expectedBox);
  const actualRaw = extractImageCrop(input.actualRgba.data, input.actualRgba.width, input.actualRgba.height, actualBox);
  const actual = await resizeRgbaForComparison(
    { data: actualRaw, width: Math.max(1, Math.round(actualBox.width)), height: Math.max(1, Math.round(actualBox.height)) },
    width,
    height
  );
  return writeArtifactSet({
    artifactDir: input.artifactDir,
    base: group.id,
    expected,
    actual,
    width,
    height,
    roles: [
      "projected_group_expected_crop",
      "projected_group_actual_crop",
      "projected_group_directional_overlay",
      "projected_group_pixel_diff_mask"
    ],
    targetLabel: group.label
  });
}

export async function runProjectedPreAudit(input: {
  pairs: ElementPair[];
  expectedElements: UiElement[];
  actualElements: UiElement[];
  expectedRgba: RgbaImage;
  actualRgba: RgbaImage;
  artifactDir: string;
}): Promise<ProjectedPreAuditResult> {
  const expectedById = new Map(input.expectedElements.map(element => [element.id, element]));
  const actualById = new Map(input.actualElements.map(element => [element.id, element]));
  const mismatches: MismatchEntry[] = [];
  const skipVlmPairIds = new Set<string>();
  let projectedPairsChecked = 0;
  let sentToVlmPairs = 0;

  for (const pair of input.pairs) {
    if (!pair.expectedId || !pair.actualId) continue;
    const expected = expectedById.get(pair.expectedId);
    const actual = actualById.get(pair.actualId);
    if (!expected || !actual || actual.source !== "projected") continue;
    projectedPairsChecked++;
    const expectedCrop = extractImageCrop(input.expectedRgba.data, input.expectedRgba.width, input.expectedRgba.height, expected.box);
    const actualCrop = extractImageCrop(input.actualRgba.data, input.actualRgba.width, input.actualRgba.height, actual.box);
    const result = await detectProjectedCropMismatch(
      { data: expectedCrop, width: Math.max(1, Math.round(expected.box.width)), height: Math.max(1, Math.round(expected.box.height)) },
      { data: actualCrop, width: Math.max(1, Math.round(actual.box.width)), height: Math.max(1, Math.round(actual.box.height)) },
      expected.text
    );
    if (result?.mismatched) {
      mismatches.push({ pair, expected, actual, expectedCrop, actualCrop, result, candidates: [] });
      skipVlmPairIds.add(pair.id);
    } else {
      sentToVlmPairs++;
    }
  }

  if (mismatches.length > 0) {
    const searchIndex = buildDisplacementSearchIndex(input.actualRgba);
    for (const mismatch of mismatches) {
      mismatch.candidates = await searchDisplacementCandidates({
        expected: {
          data: mismatch.expectedCrop,
          width: Math.max(1, Math.round(mismatch.expected.box.width)),
          height: Math.max(1, Math.round(mismatch.expected.box.height))
        },
        index: searchIndex,
        projectedBox: mismatch.actual.box
      });
    }
  }

  const consensus = resolveDisplacementConsensus({
    evidence: mismatches.map(mismatch => ({
      pairId: mismatch.pair.id,
      expectedId: mismatch.expected.id,
      projectedActualId: mismatch.actual.id,
      projectedBox: mismatch.actual.box,
      candidates: mismatch.candidates
    })),
    expectedElements: input.expectedElements,
    viewportWidth: input.actualRgba.width
  });
  const structuralGroups = resolveStructuralMismatchGroups({
    evidence: mismatches.map(mismatch => ({
      pairId: mismatch.pair.id,
      expectedId: mismatch.expected.id,
      projectedActualId: mismatch.actual.id,
      projectedBox: mismatch.actual.box,
      candidates: mismatch.candidates
    })),
    expectedElements: input.expectedElements,
    viewportWidth: input.actualRgba.width,
    viewportHeight: input.actualRgba.height
  });
  let coherentGroups = consensus.groups.map(group => ({ ...group, kind: "coherent_displacement" as const }));
  const activeStructuralGroups: StructuralMismatchGroup[] = [];
  for (const structural of structuralGroups) {
    const structuralPairs = new Set(structural.pairIds);
    const overlapping = coherentGroups.filter(group => group.pairIds.some(pairId => structuralPairs.has(pairId)));
    const exactCoherent = overlapping.length === 1
      && overlapping[0]!.pairIds.length === structural.pairIds.length
      && overlapping[0]!.pairIds.every(pairId => structuralPairs.has(pairId));
    if (exactCoherent) continue;
    coherentGroups = coherentGroups.filter(group => !group.pairIds.some(pairId => structuralPairs.has(pairId)));
    activeStructuralGroups.push(structural);
  }
  const activeGroups: ActiveMismatchGroup[] = [...coherentGroups, ...activeStructuralGroups];
  const groupByPair = new Map<string, ActiveMismatchGroup>();
  for (const group of activeGroups) group.pairIds.forEach(pairId => groupByPair.set(pairId, group));
  const groupArtifacts = new Map<string, UiArtifact[]>();
  for (const group of activeGroups) {
    const members = mismatches.filter(mismatch => group.pairIds.includes(mismatch.pair.id));
    groupArtifacts.set(group.id, await writeGroupArtifacts(group, members, input));
  }

  const diffs: DiffRecord[] = [];
  for (const mismatch of mismatches) {
    const group = groupByPair.get(mismatch.pair.id);
    const individual = consensus.individuals.get(mismatch.pair.id);
    const coherentGroup = group?.kind === "coherent_displacement" ? group : undefined;
    const structuralGroup = group?.kind === "structural_region_mismatch" ? group : undefined;
    const displacement = coherentGroup ?? (!structuralGroup ? individual : undefined);
    const dx = displacement?.dx;
    const dy = displacement?.dy;
    const displaced = dx !== undefined && dy !== undefined;
    const childArtifacts = await writeChildArtifacts(mismatch, input.artifactDir);
    const translated = displaced ? translateBox(mismatch.actual.box, dx, dy) : undefined;
    diffs.push({
      id: crypto.randomBytes(6).toString("hex"),
      pairId: mismatch.pair.id,
      criterion: displaced || structuralGroup ? "geometry" : "presence",
      severity: displaced || structuralGroup ? "medium" : "high",
      title: structuralGroup
        ? `Expected UI region layout differs at projected location: ${structuralGroup.label}`
        : displaced
        ? `Expected target is displaced from projected location: ${mismatch.expected.label}`
        : `Expected target absent at projected location: ${mismatch.expected.label}`,
      location: translated ? unionBoxes([mismatch.actual.box, translated]) : mismatch.actual.box,
      coverageLocations: translated ? [mismatch.actual.box, translated] : [mismatch.actual.box],
      evidence: [
        "Projected expected crop did not match the actual source crop after normalized comparison.",
        `reason=${mismatch.result.reason}, changedPercent=${mismatch.result.changedPercent.toFixed(1)}`,
        ...(displaced ? [`deterministic translation dx=${dx}px, dy=${dy}px`] : []),
        ...(coherentGroup ? [`coherent displacement group ${coherentGroup.id} contains ${coherentGroup.pairIds.length} targets`] : []),
        ...(structuralGroup ? [`structural mismatch group ${structuralGroup.id} contains ${structuralGroup.pairIds.length} independently mismatched targets`] : [])
      ],
      measurements: displaced ? [
        { name: "horizontal_shift", value: dx, unit: "px" },
        { name: "vertical_shift", value: dy, unit: "px" },
        { name: "translated_edge_overlap", value: Number((individual?.edgeOverlap ?? coherentGroup?.confidence ?? 0).toFixed(4)) }
      ] : [],
      artifactPaths: [...childArtifacts, ...(group ? groupArtifacts.get(group.id) ?? [] : [])],
      reviewerStatus: "not_reviewed",
      model: "deterministic",
      classificationSource: "deterministic_projected_mismatch",
      projectionMismatchReason: mismatch.result.reason,
      projectionMismatchKind: structuralGroup ? "region_mismatch" : displaced ? "displaced" : "absent_at_location",
      ...(group ? {
        findingGroupId: group.id,
        findingGroupKind: group.kind,
        groupLabel: group.label
      } : {})
    });
  }

  return {
    diffs,
    skipVlmPairIds,
    summary: {
      projectedPairsChecked,
      deterministicProjectedDiffs: diffs.length,
      sentToVlmPairs,
      skippedFromVlmPairIds: [...skipVlmPairIds],
      uniqueDisplacements: consensus.individuals.size,
      displacementGroups: coherentGroups.length,
      structuralMismatchGroups: activeStructuralGroups.length,
      groupedPairs: activeGroups.reduce((sum, group) => sum + group.pairIds.length, 0)
    }
  };
}
