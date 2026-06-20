import crypto from "node:crypto";
import type { DiffRecord, ElementPair, UiElement, ProjectedPreAuditSummary } from "../schemas/core.js";
import { detectProjectedCropMismatch } from "../audit/projected-mismatch.js";
import { extractImageCrop } from "../images/crop.js";

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
      skipVlmPairIds.add(pair.id);
      diffs.push({
        id: crypto.randomBytes(6).toString("hex"),
        pairId: pair.id,
        criterion: "presence",
        severity: "high",
        title: `Expected target absent or mismatched at projected location: ${expected.label}`,
        location: actual.box,
        evidence: [
          "Projected expected crop did not match the actual source crop after normalized comparison.",
          `reason=${result.reason}, changedPercent=${result.changedPercent.toFixed(1)}`
        ],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "accepted",
        model: "deterministic",
        classificationSource: "deterministic_projected_mismatch",
        projectionMismatchReason: result.reason
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
