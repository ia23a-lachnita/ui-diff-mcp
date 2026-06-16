import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { Box, DiffRecord, UiArtifact, UnassignedVisualEvidence } from "../schemas/core.js";
import { UiCriterionSchema } from "../schemas/core.js";
import type { PixelComponent } from "../signals/pixel-diff.js";
import type { VisionJsonCaller } from "../models/vision-json.js";
import { buildRecoveryPrompt, buildReviewerPrompt } from "../audit/prompts.js";
import { intersect } from "../signals/geometry.js";

const CLASSIFIABLE_CRITERIA = UiCriterionSchema.exclude(["unclassified_visual_change"]);

const RecoveryVlmResponseSchema = z.object({
  classified: z.boolean(),
  criterion: CLASSIFIABLE_CRITERIA.optional(),
  severity: z.enum(["low", "medium", "high"]).optional(),
  label: z.string().min(1).optional(),
  coordinateFrame: z.enum(["expected", "actual", "normalized"]).optional(),
  box: z.object({
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
    width: z.number().finite().positive(),
    height: z.number().finite().positive()
  }).optional(),
  evidence: z.array(z.string()).min(1).optional(),
  measurements: z.array(z.object({
    name: z.string(),
    value: z.union([z.number(), z.string(), z.boolean()]),
    unit: z.string().optional()
  })).optional()
});

const ReviewDecisionSchema = z.object({
  decision: z.enum(["accepted", "rejected", "needs_escalation"]),
  reason: z.string()
});

const RECOVERY_JSON_SCHEMA = {
  type: "object",
  properties: {
    classified: { type: "boolean" },
    criterion: { type: "string", enum: CLASSIFIABLE_CRITERIA.options },
    severity: { type: "string", enum: ["low", "medium", "high"] },
    label: { type: "string" },
    coordinateFrame: { type: "string", enum: ["expected", "actual", "normalized"] },
    box: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" }
      },
      required: ["x", "y", "width", "height"],
      additionalProperties: false
    },
    evidence: { type: "array", items: { type: "string" }, minItems: 1 },
    measurements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          value: {},
          unit: { type: "string" }
        },
        required: ["name", "value"],
        additionalProperties: false
      }
    }
  },
  required: ["classified"],
  additionalProperties: false
} as const;

export interface RecoveryBudget {
  maxComponents: number;
  maxModelCalls: number;
  deadlineMs: number;
  minComponentPixels: number;
}

function makeDefaultBudget(): RecoveryBudget {
  return {
    maxComponents: parseInt(process.env["UI_DIFF_MAX_RECOVERY_COMPONENTS"] ?? "12", 10),
    maxModelCalls: parseInt(process.env["UI_DIFF_MAX_RECOVERY_MODEL_CALLS"] ?? "24", 10),
    deadlineMs: Date.now() + parseInt(process.env["UI_DIFF_RECOVERY_BUDGET_MS"] ?? "120000", 10),
    minComponentPixels: parseInt(process.env["UI_DIFF_MIN_RECOVERY_PIXELS"] ?? "80", 10)
  };
}

export interface RecoveryContext {
  expectedRgba: { data: Uint8Array; width: number; height: number };
  actualRgba: { data: Uint8Array; width: number; height: number };
  pixelDiffMask: Uint8Array;
  directionalOverlayPath: string;
  artifactDir: string;
  recoveryCaller: VisionJsonCaller;
  reviewerCaller: VisionJsonCaller;
}

function extractRgbaCrop(
  imageData: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  box: Box
): { data: Uint8Array; width: number; height: number } {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(Math.round(box.width), imageWidth - x);
  const h = Math.min(Math.round(box.height), imageHeight - y);
  if (w <= 0 || h <= 0) return { data: new Uint8Array(4), width: 1, height: 1 };
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const src = ((y + row) * imageWidth + (x + col)) * 4;
      const dst = (row * w + col) * 4;
      out[dst] = imageData[src] ?? 0;
      out[dst + 1] = imageData[src + 1] ?? 0;
      out[dst + 2] = imageData[src + 2] ?? 0;
      out[dst + 3] = imageData[src + 3] ?? 0;
    }
  }
  return { data: out, width: w, height: h };
}

function extractMaskCrop(
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  box: Box
): { data: Uint8Array; width: number; height: number } {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(Math.round(box.width), maskWidth - x);
  const h = Math.min(Math.round(box.height), maskHeight - y);
  if (w <= 0 || h <= 0) return { data: new Uint8Array(1), width: 1, height: 1 };
  const out = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const src = (y + row) * maskWidth + (x + col);
      const dst = row * w + col;
      out[dst] = (mask[src] ?? 0) > 0 ? 255 : 0;
    }
  }
  return { data: out, width: w, height: h };
}

async function writePngArtifact(
  data: Uint8Array,
  width: number,
  height: number,
  outPath: string,
  channels: 1 | 4 = 4
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  if (width <= 0 || height <= 0) {
    await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .png().toFile(outPath);
    return;
  }
  await sharp(
    Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    { raw: { width, height, channels } }
  ).png().toFile(outPath);
}

async function toBase64Png(
  data: Uint8Array,
  width: number,
  height: number,
  channels: 1 | 4 = 4
): Promise<string> {
  const buf = await sharp(
    Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    { raw: { width: width > 0 ? width : 1, height: height > 0 ? height : 1, channels } }
  ).png().toBuffer();
  return buf.toString("base64");
}

function isBoxInBounds(box: Box, imageWidth: number, imageHeight: number): boolean {
  return (
    box.x >= 0 && box.y >= 0 &&
    box.x + box.width <= imageWidth &&
    box.y + box.height <= imageHeight
  );
}

function boxOverlapsComponent(box: Box, component: PixelComponent, threshold = 0.1): boolean {
  const overlap = intersect(box, component.box);
  if (!overlap) return false;
  const overlapArea = overlap.width * overlap.height;
  const componentArea = component.box.width * component.box.height;
  return overlapArea / componentArea >= threshold;
}

export interface RecoveryResult {
  recovered: DiffRecord[];
  unclassifiedCount: number;
  attemptedComponents: number;
  skippedComponents: number;
  stoppedReason: "none" | "component_cap" | "model_call_cap" | "deadline_exceeded";
  model?: string;
}

export async function runTargetRecovery(
  uncoveredComponents: PixelComponent[],
  ctx: RecoveryContext,
  budget: RecoveryBudget = makeDefaultBudget()
): Promise<RecoveryResult> {
  const recovered: DiffRecord[] = [];
  let unclassifiedCount = 0;
  let modelCallsUsed = 0;
  let stoppedReason: RecoveryResult["stoppedReason"] = "none";
  const imageWidth = ctx.expectedRgba.width;
  const imageHeight = ctx.expectedRgba.height;
  let recoveryModel: string | undefined;

  // Filter noise below min pixel threshold, then rank: pixelCount desc, area desc, y asc, x asc
  const eligible = uncoveredComponents
    .filter(c => c.pixelCount >= budget.minComponentPixels)
    .sort((a, b) => {
      if (b.pixelCount !== a.pixelCount) return b.pixelCount - a.pixelCount;
      const aArea = a.box.width * a.box.height;
      const bArea = b.box.width * b.box.height;
      if (bArea !== aArea) return bArea - aArea;
      if (a.box.y !== b.box.y) return a.box.y - b.box.y;
      return a.box.x - b.box.x;
    });

  const skippedComponents = Math.max(0, eligible.length - budget.maxComponents);
  const toProcess = eligible.slice(0, budget.maxComponents);

  // Read directional overlay once for cropping
  const overlayRawResult = await sharp(ctx.directionalOverlayPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const overlayData = new Uint8Array(overlayRawResult.data.buffer, overlayRawResult.data.byteOffset, overlayRawResult.data.byteLength);

  let attemptedComponents = 0;

  for (const component of toProcess) {
    if (Date.now() >= budget.deadlineMs) {
      stoppedReason = "deadline_exceeded";
      break;
    }
    if (modelCallsUsed >= budget.maxModelCalls) {
      stoppedReason = "model_call_cap";
      break;
    }
    attemptedComponents++;
    const evidenceId = crypto.randomBytes(6).toString("hex");
    const box = component.box;

    // Crop expected, actual, overlay, mask
    const expCrop = extractRgbaCrop(ctx.expectedRgba.data, imageWidth, imageHeight, box);
    const actCrop = extractRgbaCrop(ctx.actualRgba.data, imageWidth, imageHeight, box);
    const overlayCrop = extractRgbaCrop(overlayData, overlayRawResult.info.width, overlayRawResult.info.height, box);
    const maskCrop = extractMaskCrop(ctx.pixelDiffMask, imageWidth, imageHeight, box);

    // Write artifact files
    const expCropPath = path.join(ctx.artifactDir, `recovery-${evidenceId}-expected.png`);
    const actCropPath = path.join(ctx.artifactDir, `recovery-${evidenceId}-actual.png`);
    const overlayPath = path.join(ctx.artifactDir, `recovery-${evidenceId}-overlay.png`);
    const maskPath = path.join(ctx.artifactDir, `recovery-${evidenceId}-mask.png`);

    await writePngArtifact(expCrop.data, expCrop.width, expCrop.height, expCropPath, 4);
    await writePngArtifact(actCrop.data, actCrop.width, actCrop.height, actCropPath, 4);
    await writePngArtifact(overlayCrop.data, overlayCrop.width, overlayCrop.height, overlayPath, 4);
    await writePngArtifact(maskCrop.data, maskCrop.width, maskCrop.height, maskPath, 1);

    const artifacts: UiArtifact[] = [
      { role: "recovery_expected_crop", path: expCropPath },
      { role: "recovery_actual_crop", path: actCropPath },
      { role: "recovery_directional_overlay", path: overlayPath },
      { role: "recovery_pixel_diff_mask", path: maskPath }
    ];

    const evidence: UnassignedVisualEvidence = {
      id: evidenceId,
      componentBox: box,
      pixelCount: component.pixelCount,
      componentArea: box.width * box.height,
      expectedCropArtifact: artifacts[0]!,
      actualCropArtifact: artifacts[1]!,
      directionalOverlayArtifact: artifacts[2]!,
      pixelDiffMaskArtifact: artifacts[3]!
    };

    // Encode crops for VLM
    const expB64 = await toBase64Png(expCrop.data, expCrop.width, expCrop.height, 4);
    const actB64 = await toBase64Png(actCrop.data, actCrop.width, actCrop.height, 4);
    const overlayB64 = await toBase64Png(overlayCrop.data, overlayCrop.width, overlayCrop.height, 4);
    const maskB64 = await toBase64Png(maskCrop.data, maskCrop.width, maskCrop.height, 1);

    const images = [
      `data:image/png;base64,${expB64}`,
      `data:image/png;base64,${actB64}`,
      `data:image/png;base64,${overlayB64}`,
      `data:image/png;base64,${maskB64}`
    ];

    const recoveryPrompt = buildRecoveryPrompt(component.pixelCount, Math.round(box.width * box.height));

    let vlmResponse: z.infer<typeof RecoveryVlmResponseSchema>;
    let componentRecoveryModel = "unknown";
    try {
      const res = await ctx.recoveryCaller({
        prompt: recoveryPrompt,
        images,
        jsonSchema: { name: "recovery_classification", schema: RECOVERY_JSON_SCHEMA },
        timeoutMs: 60000
      });
      modelCallsUsed++;
      componentRecoveryModel = res.model;
      if (!recoveryModel) {
        recoveryModel = res.model;
      }
      vlmResponse = RecoveryVlmResponseSchema.parse(res.parsed);
    } catch (err) {
      console.error(`Recovery VLM call failed for component ${evidenceId}:`, err);
      modelCallsUsed++;
      unclassifiedCount++;
      continue;
    }

    // VLM explicitly determined no regression in this region — valid verdict, not a failure.
    if (!vlmResponse.classified) {
      continue;
    }

    if (
      !vlmResponse.criterion ||
      !vlmResponse.label ||
      !vlmResponse.box ||
      !vlmResponse.evidence ||
      !vlmResponse.coordinateFrame
    ) {
      unclassifiedCount++;
      continue;
    }

    // Validate box
    const rawBox = vlmResponse.box;
    if (!isBoxInBounds(rawBox, imageWidth, imageHeight)) {
      console.warn(`Recovery: box out of bounds for component ${evidenceId}, skipping`);
      unclassifiedCount++;
      continue;
    }
    if (!boxOverlapsComponent(rawBox, component)) {
      console.warn(`Recovery: box does not overlap component ${evidenceId}, skipping`);
      unclassifiedCount++;
      continue;
    }

    // Snap recovered box to the deterministic pixel-component bounds.
    // The VLM provides label/criterion; the pixel analysis provides the ground-truth region.
    const recoveredBox = component.box;

    // Review with standard reviewer
    const reviewerPrompt = buildReviewerPrompt(
      vlmResponse.criterion,
      vlmResponse.label,
      `${vlmResponse.criterion} detected in unassigned region`,
      vlmResponse.evidence
    );

    let reviewDecision: "accepted" | "rejected" | "needs_escalation" = "accepted";
    try {
      const reviewRes = await ctx.reviewerCaller({
        prompt: reviewerPrompt,
        images,
        jsonSchema: {
          name: "review_decision",
          schema: {
            type: "object",
            properties: {
              decision: { type: "string", enum: ["accepted", "rejected", "needs_escalation"] },
              reason: { type: "string" }
            },
            required: ["decision", "reason"],
            additionalProperties: false
          }
        },
        timeoutMs: 30000
      });
      modelCallsUsed++;
      const parsed = ReviewDecisionSchema.parse(reviewRes.parsed);
      reviewDecision = parsed.decision;
    } catch (err) {
      console.error(`Recovery reviewer call failed for component ${evidenceId}:`, err);
      modelCallsUsed++;
      reviewDecision = "needs_escalation";
    }

    if (reviewDecision === "rejected") {
      unclassifiedCount++;
      continue;
    }

    const diffId = crypto.randomBytes(6).toString("hex");
    const baseMeasurements = (vlmResponse.measurements ?? []).map(m => ({
      name: m.name,
      value: m.value as string | number | boolean,
      ...(m.unit !== undefined ? { unit: m.unit } : {})
    }));
    const record: DiffRecord = {
      id: diffId,
      criterion: vlmResponse.criterion,
      severity: vlmResponse.severity ?? "medium",
      title: `${vlmResponse.criterion} in recovered region: ${vlmResponse.label}`,
      location: recoveredBox,
      evidence: vlmResponse.evidence,
      measurements: [
        ...baseMeasurements,
        { name: "coordinateFrame", value: vlmResponse.coordinateFrame }
      ],
      artifactPaths: artifacts,
      reviewerStatus: reviewDecision === "needs_escalation" ? "needs_escalation" : "accepted",
      model: componentRecoveryModel
    };

    recovered.push(record);
    void evidence; // evidence artifact metadata is captured in record.artifactPaths
  }

  return {
    recovered,
    unclassifiedCount,
    attemptedComponents,
    skippedComponents,
    stoppedReason,
    ...(recoveryModel !== undefined ? { model: recoveryModel } : {})
  };
}
