import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { DiffRecord, ElementPair, UiElement, ProjectedPreAuditSummary } from "../schemas/core.js";
import { detectProjectedCropMismatch, findProjectedDisplacement } from "../audit/projected-mismatch.js";
import { extractImageCrop, resizeRgbaForComparison } from "../images/crop.js";
import { createDirectionalDiffOverlay } from "../images/directional-diff.js";

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

export async function runProjectedPreAudit(input: {
  pairs: ElementPair[];
  expectedElements: UiElement[];
  actualElements: UiElement[];
  expectedRgba: RgbaImage;
  actualRgba: RgbaImage;
  artifactDir: string;
}): Promise<ProjectedPreAuditResult> {
  const expectedById = new Map(input.expectedElements.map(e => [e.id, e]));
  const actualById = new Map(input.actualElements.map(e => [e.id, e]));
  const diffs: DiffRecord[] = [];
  const skipVlmPairIds = new Set<string>();
  let projectedPairsChecked = 0;
  let sentToVlmPairs = 0;

  for (const pair of input.pairs) {
    if (!pair.expectedId || !pair.actualId) continue;
    const expected = expectedById.get(pair.expectedId);
    const actual = actualById.get(pair.actualId);
    if (!expected || !actual || actual.source !== "projected") continue;

    projectedPairsChecked += 1;
    const expectedCrop = extractImageCrop(input.expectedRgba.data, input.expectedRgba.width, input.expectedRgba.height, expected.box);
    const actualCrop = extractImageCrop(input.actualRgba.data, input.actualRgba.width, input.actualRgba.height, actual.box);
    const result = await detectProjectedCropMismatch(
      { data: expectedCrop, width: Math.max(1, Math.round(expected.box.width)), height: Math.max(1, Math.round(expected.box.height)) },
      { data: actualCrop, width: Math.max(1, Math.round(actual.box.width)), height: Math.max(1, Math.round(actual.box.height)) },
      expected.text
    );

    if (result?.mismatched) {
      const siblingBoxes = input.actualElements
        .filter(element => element.id !== actual.id && element.source === "projected")
        .map(element => element.box);
      const displacement = await findProjectedDisplacement({
        expected: { data: expectedCrop, width: Math.max(1, Math.round(expected.box.width)), height: Math.max(1, Math.round(expected.box.height)) },
        actualImage: input.actualRgba,
        projectedBox: actual.box,
        siblingBoxes
      });
      const comparisonWidth = Math.max(1, Math.round(expected.box.width));
      const comparisonHeight = Math.max(1, Math.round(expected.box.height));
      const comparisonActual = actual.box.width === expected.box.width && actual.box.height === expected.box.height
        ? actualCrop
        : await resizeRgbaForComparison(
            { data: actualCrop, width: Math.max(1, Math.round(actual.box.width)), height: Math.max(1, Math.round(actual.box.height)) },
            comparisonWidth,
            comparisonHeight
          );
      const mask = new Uint8Array(comparisonWidth * comparisonHeight);
      for (let pixel = 0; pixel < mask.length; pixel++) {
        const offset = pixel * 4;
        const delta = Math.abs((expectedCrop[offset] ?? 0) - (comparisonActual[offset] ?? 0)) +
          Math.abs((expectedCrop[offset + 1] ?? 0) - (comparisonActual[offset + 1] ?? 0)) +
          Math.abs((expectedCrop[offset + 2] ?? 0) - (comparisonActual[offset + 2] ?? 0));
        mask[pixel] = delta > 30 ? 255 : 0;
      }
      const artifactBase = `projected-${pair.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      await fs.mkdir(input.artifactDir, { recursive: true });
      const expectedPath = path.join(input.artifactDir, `${artifactBase}-expected.png`);
      const actualPath = path.join(input.artifactDir, `${artifactBase}-actual.png`);
      const overlayPath = path.join(input.artifactDir, `${artifactBase}-overlay.png`);
      const maskPath = path.join(input.artifactDir, `${artifactBase}-mask.png`);
      await sharp(Buffer.from(expectedCrop), { raw: { width: comparisonWidth, height: comparisonHeight, channels: 4 } }).png().toFile(expectedPath);
      await sharp(Buffer.from(comparisonActual), { raw: { width: comparisonWidth, height: comparisonHeight, channels: 4 } }).png().toFile(actualPath);
      await sharp(Buffer.from(mask), { raw: { width: comparisonWidth, height: comparisonHeight, channels: 1 } }).png().toFile(maskPath);
      await createDirectionalDiffOverlay(
        { data: expectedCrop, width: comparisonWidth, height: comparisonHeight },
        { data: comparisonActual, width: comparisonWidth, height: comparisonHeight },
        mask,
        comparisonWidth,
        comparisonHeight,
        overlayPath
      );
      skipVlmPairIds.add(pair.id);
      const kind = displacement ? "displaced" as const : "absent_at_location" as const;
      diffs.push({
        id: crypto.randomBytes(6).toString("hex"),
        pairId: pair.id,
        criterion: displacement ? "geometry" : "presence",
        severity: displacement ? "medium" : "high",
        title: displacement
          ? `Expected target is displaced from projected location: ${expected.label}`
          : `Expected target absent at projected location: ${expected.label}`,
        location: actual.box,
        evidence: [
          "Projected expected crop did not match the actual source crop after normalized comparison.",
          `reason=${result.reason}, changedPercent=${result.changedPercent.toFixed(1)}`,
          ...(displacement ? [`deterministic translation dx=${displacement.dx}px, dy=${displacement.dy}px`] : [])
        ],
        measurements: displacement ? [
          { name: "horizontal_shift", value: displacement.dx, unit: "px" },
          { name: "vertical_shift", value: displacement.dy, unit: "px" },
          { name: "translated_edge_overlap", value: Number(displacement.edgeOverlap.toFixed(4)) }
        ] : [],
        artifactPaths: [
          { role: "projected_expected_crop", path: expectedPath, pairId: pair.id, targetLabel: expected.label },
          { role: "projected_actual_crop", path: actualPath, pairId: pair.id, targetLabel: expected.label },
          { role: "projected_directional_overlay", path: overlayPath, pairId: pair.id, targetLabel: expected.label },
          { role: "projected_pixel_diff_mask", path: maskPath, pairId: pair.id, targetLabel: expected.label }
        ],
        reviewerStatus: "accepted",
        model: "deterministic",
        classificationSource: "deterministic_projected_mismatch",
        projectionMismatchReason: result.reason,
        projectionMismatchKind: kind
      });
    } else {
      sentToVlmPairs += 1;
    }
  }

  return {
    diffs,
    skipVlmPairIds,
    summary: {
      projectedPairsChecked,
      deterministicProjectedDiffs: diffs.length,
      sentToVlmPairs,
      skippedFromVlmPairIds: [...skipVlmPairIds]
    }
  };
}
