import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { Box, DiffRecord, UiArtifact, UnassignedVisualEvidence, RecoveryComponentTrace } from "../schemas/core.js";
import { UiCriterionSchema } from "../schemas/core.js";
import type { PixelComponent } from "../signals/pixel-diff.js";
import type { VisionJsonCaller } from "../models/vision-json.js";
import { buildRecoveryPrompt, buildReviewerPrompt } from "../audit/prompts.js";
import { type ImagePairTransform, projectExpectedBoxToActualSource } from "../images/coordinates.js";

const CLASSIFIABLE_CRITERIA = UiCriterionSchema.exclude(["unclassified_visual_change"]);

const RecoveryVlmResponseSchema = z.object({
  classified: z.boolean(),
  criterion: CLASSIFIABLE_CRITERIA.optional(),
  severity: z.enum(["low", "medium", "high"]).optional(),
  label: z.string().min(1).optional(),
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
    maxModelCalls: parseInt(process.env["UI_DIFF_MAX_RECOVERY_MODEL_CALLS"] ?? "200", 10),
    deadlineMs: Date.now() + parseInt(process.env["UI_DIFF_RECOVERY_BUDGET_MS"] ?? "900000", 10),
    minComponentPixels: parseInt(process.env["UI_DIFF_MIN_RECOVERY_PIXELS"] ?? "80", 10)
  };
}

export interface RecoveryContext {
  expectedRgba: { data: Uint8Array; width: number; height: number };
  actualRgba: { data: Uint8Array; width: number; height: number };
  imagePairTransform?: ImagePairTransform;
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

export interface RecoveryResult {
  recovered: DiffRecord[];
  unclassifiedCount: number;
  eligibleComponents: number;
  completedComponents: number;
  remainingComponents: number;
  batchCount: number;
  attemptedComponents: number;
  skippedComponents: number;
  stoppedReason: "none" | "component_cap" | "model_call_cap" | "deadline_exceeded";
  trace: RecoveryComponentTrace[];
  model?: string;
  statusCounts: Record<string, number>;
  regionOutcomes: RecoveryRegionOutcome[];
  cursor: RecoveryCursor;
}

export interface RecoveryCursor {
  nextRegionIndex: number;
  remainingModelCalls: number;
  remainingRegionIds: string[];
}

export interface RecoveryRegionOutcome {
  regionId: string;
  state: "recovered" | "noise" | "unresolved";
  reason: string;
  artifactPaths: UiArtifact[];
  findingId?: string;
  rejectionReason?: string;
}

export type RecoveryRegionInput = PixelComponent & { id?: string };

interface PreparedRecoveryEvidence {
  regionId: string;
  component: RecoveryRegionInput;
  artifacts: UiArtifact[];
  expCrop: { data: Uint8Array; width: number; height: number };
  actCrop: { data: Uint8Array; width: number; height: number };
  overlayCrop: { data: Uint8Array; width: number; height: number };
  maskCrop: { data: Uint8Array; width: number; height: number };
}

export async function prepareRecoveryRegionArtifacts(
  regions: RecoveryRegionInput[],
  ctx: Pick<RecoveryContext, "expectedRgba" | "actualRgba" | "imagePairTransform" | "pixelDiffMask" | "directionalOverlayPath" | "artifactDir">
): Promise<PreparedRecoveryEvidence[]> {
  const overlayRawResult = await sharp(ctx.directionalOverlayPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const overlayData = new Uint8Array(overlayRawResult.data.buffer, overlayRawResult.data.byteOffset, overlayRawResult.data.byteLength);
  const prepared: PreparedRecoveryEvidence[] = [];
  for (let index = 0; index < regions.length; index++) {
    const component = regions[index]!;
    const regionId = component.id ?? `component-${String(index + 1).padStart(4, "0")}`;
    const safeId = regionId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const box = component.box;
    const actBox = ctx.imagePairTransform ? projectExpectedBoxToActualSource(box, ctx.imagePairTransform) : box;
    const expCrop = extractRgbaCrop(ctx.expectedRgba.data, ctx.expectedRgba.width, ctx.expectedRgba.height, box);
    const actCrop = extractRgbaCrop(ctx.actualRgba.data, ctx.actualRgba.width, ctx.actualRgba.height, actBox);
    const overlayCrop = extractRgbaCrop(overlayData, overlayRawResult.info.width, overlayRawResult.info.height, box);
    const maskCrop = extractMaskCrop(ctx.pixelDiffMask, ctx.expectedRgba.width, ctx.expectedRgba.height, box);
    const expCropPath = path.join(ctx.artifactDir, `recovery-${safeId}-expected.png`);
    const actCropPath = path.join(ctx.artifactDir, `recovery-${safeId}-actual.png`);
    const overlayPath = path.join(ctx.artifactDir, `recovery-${safeId}-overlay.png`);
    const maskPath = path.join(ctx.artifactDir, `recovery-${safeId}-mask.png`);
    await writePngArtifact(expCrop.data, expCrop.width, expCrop.height, expCropPath, 4);
    await writePngArtifact(actCrop.data, actCrop.width, actCrop.height, actCropPath, 4);
    await writePngArtifact(overlayCrop.data, overlayCrop.width, overlayCrop.height, overlayPath, 4);
    await writePngArtifact(maskCrop.data, maskCrop.width, maskCrop.height, maskPath, 1);
    prepared.push({
      regionId,
      component,
      expCrop,
      actCrop,
      overlayCrop,
      maskCrop,
      artifacts: [
        { role: "recovery_expected_crop", path: expCropPath },
        { role: "recovery_actual_crop", path: actCropPath },
        { role: "recovery_directional_overlay", path: overlayPath },
        { role: "recovery_pixel_diff_mask", path: maskPath }
      ]
    });
  }
  return prepared;
}

export async function runTargetRecovery(
  uncoveredComponents: RecoveryRegionInput[],
  ctx: RecoveryContext,
  budget: RecoveryBudget = makeDefaultBudget()
): Promise<RecoveryResult> {
  const recovered: DiffRecord[] = [];
  const trace: RecoveryComponentTrace[] = [];
  const statusCounts: Record<string, number> = {};
  const regionOutcomes: RecoveryRegionOutcome[] = [];
  let unclassifiedCount = 0;
  let modelCallsUsed = 0;
  let stoppedReason: RecoveryResult["stoppedReason"] = "none";

  function countStatus(status: string): void {
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  let recoveryModel: string | undefined;

  // Assign stable componentIds before sorting, then rank: pixelCount desc, area desc, y asc, x asc
  const ranked = uncoveredComponents
    .map((component, originalIndex) => ({
      component,
      componentId: component.id ?? `component-${String(originalIndex + 1).padStart(4, "0")}`
    }))
    .sort((a, b) => {
      if (b.component.pixelCount !== a.component.pixelCount) return b.component.pixelCount - a.component.pixelCount;
      const aArea = a.component.box.width * a.component.box.height;
      const bArea = b.component.box.width * b.component.box.height;
      if (bArea !== aArea) return bArea - aArea;
      if (a.component.box.y !== b.component.box.y) return a.component.box.y - b.component.box.y;
      return a.component.box.x - b.component.box.x;
    });
  const prepared = await prepareRecoveryRegionArtifacts(
    ranked.map(entry => ({ ...entry.component, id: entry.componentId })),
    ctx
  );
  const preparedById = new Map(prepared.map(entry => [entry.regionId, entry]));

  // Push below-threshold traces
  for (const entry of ranked.filter(e => e.component.pixelCount < budget.minComponentPixels)) {
    const artifacts = preparedById.get(entry.componentId)?.artifacts ?? [];
    countStatus("below_threshold");
    trace.push({
      componentId: entry.componentId,
      rank: 0,
      componentBox: entry.component.box,
      pixelCount: entry.component.pixelCount,
      status: "below_threshold",
      artifactPaths: artifacts
    });
    regionOutcomes.push({ regionId: entry.componentId, state: "noise", reason: "below_threshold", artifactPaths: artifacts });
  }

  const eligible = ranked.filter(e => e.component.pixelCount >= budget.minComponentPixels);
  const toProcess = eligible;
  const batchSize = Math.max(1, budget.maxComponents);

  let attemptedComponents = 0;
  let loopStoppedAt = toProcess.length;
  let batchCount = 0;

  for (let rankIndex = 0; rankIndex < toProcess.length; rankIndex++) {
    const entry = toProcess[rankIndex]!;
    const component = entry.component;
    const componentId = entry.componentId;

    if (Date.now() >= budget.deadlineMs) {
      stoppedReason = "deadline_exceeded";
      loopStoppedAt = rankIndex;
      break;
    }
    if (modelCallsUsed >= budget.maxModelCalls) {
      stoppedReason = "model_call_cap";
      loopStoppedAt = rankIndex;
      break;
    }
    if (rankIndex % batchSize === 0) batchCount++;
    attemptedComponents++;
    const evidenceId = componentId;
    const box = component.box;
    const preparedEvidence = preparedById.get(componentId)!;
    const { expCrop, actCrop, overlayCrop, maskCrop, artifacts } = preparedEvidence;

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

    const baseTrace = { componentId, rank: rankIndex, componentBox: box, pixelCount: component.pixelCount, artifactPaths: artifacts };

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
    const recoveryStarted = Date.now();
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
      const traceStatus = err instanceof z.ZodError ? "recovery_schema_error" as const : "recovery_error" as const;
      countStatus(traceStatus);
      trace.push({
        ...baseTrace,
        status: traceStatus,
        model: componentRecoveryModel,
        recoveryDurationMs: Date.now() - recoveryStarted,
        errorKind: err instanceof z.ZodError ? "schema" as const : "provider" as const,
        errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)
      });
      console.error(`Recovery VLM call failed for component ${evidenceId}:`, err);
      modelCallsUsed++;
      unclassifiedCount++;
      regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: traceStatus, artifactPaths: artifacts });
      continue;
    }
    const recoveryDurationMs = Date.now() - recoveryStarted;

    // VLM explicitly determined no regression in this region — valid verdict, not a failure.
    if (!vlmResponse.classified) {
      countStatus("classified_false");
      trace.push({ ...baseTrace, status: "classified_false", model: componentRecoveryModel, recoveryDurationMs });
      regionOutcomes.push({ regionId: componentId, state: "noise", reason: "classified_false", artifactPaths: artifacts });
      continue;
    }

    if (
      !vlmResponse.criterion ||
      !vlmResponse.label ||
      !vlmResponse.evidence
    ) {
      countStatus("missing_required_fields");
      trace.push({ ...baseTrace, status: "missing_required_fields", model: componentRecoveryModel, recoveryDurationMs });
      unclassifiedCount++;
      regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: "missing_required_fields", artifactPaths: artifacts });
      continue;
    }

    // The VLM supplies semantic classification only. The deterministic pixel
    // component is the authoritative full-screen location for this crop.
    const recoveredBox = component.box;

    // Review with standard reviewer
    const reviewerPrompt = buildReviewerPrompt(
      vlmResponse.criterion,
      vlmResponse.label,
      `${vlmResponse.criterion} detected in unassigned region`,
      vlmResponse.evidence
    );

    let reviewDecision: "accepted" | "rejected" | "needs_escalation" = "accepted";
    const reviewerStarted = Date.now();
    let reviewerModel = "unknown";
    let reviewReason: string | undefined;
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
      reviewReason = parsed.reason;
      reviewerModel = reviewRes.model;
    } catch (err) {
      console.error(`Recovery reviewer call failed for component ${evidenceId}:`, err);
      modelCallsUsed++;
      reviewDecision = "needs_escalation";
    }
    const reviewerDurationMs = Date.now() - reviewerStarted;

    if (reviewDecision === "rejected") {
      countStatus("recovery_rejected");
      trace.push({
        ...baseTrace,
        status: "recovery_rejected",
        model: componentRecoveryModel,
        reviewerModel,
        recoveryDurationMs,
        reviewerDurationMs,
        criterion: vlmResponse.criterion,
        ...(reviewReason !== undefined ? { rejectionReason: reviewReason } : {})
      });
      unclassifiedCount++;
      regionOutcomes.push({
        regionId: componentId,
        state: "unresolved",
        reason: `reviewer_rejected${reviewReason ? `: ${reviewReason.slice(0, 150)}` : ""}`,
        artifactPaths: artifacts,
        ...(reviewReason !== undefined ? { rejectionReason: reviewReason } : {})
      });
      continue;
    }

    const diffId = crypto.randomBytes(6).toString("hex");
    if (reviewDecision === "needs_escalation") {
      unclassifiedCount++;
    }
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
        { name: "coordinateSource", value: "deterministic_pixel_component" }
      ],
      artifactPaths: artifacts,
      reviewerStatus: reviewDecision === "needs_escalation" ? "needs_escalation" : "accepted",
      model: componentRecoveryModel,
      classificationSource: "target_recovery",
      ...(reviewReason !== undefined ? { reviewerReason: reviewReason } : {})
    };

    recovered.push(record);
    const finalStatus = reviewDecision === "needs_escalation" ? "recovery_needs_escalation" as const : "recovery_accepted" as const;
    countStatus(finalStatus);
    trace.push({
      ...baseTrace,
      status: finalStatus,
      model: componentRecoveryModel,
      reviewerModel,
      recoveryDurationMs,
      reviewerDurationMs,
      criterion: vlmResponse.criterion,
      diffId: record.id
    });
    regionOutcomes.push({
      regionId: componentId,
      state: reviewDecision === "needs_escalation" ? "unresolved" : "recovered",
      reason: reviewDecision === "needs_escalation" ? "needs_escalation" : "recovery_accepted",
      artifactPaths: artifacts,
      findingId: record.id
    });
    void evidence; // evidence artifact metadata is captured in record.artifactPaths
  }

  // Push skipped traces for entries that weren't reached due to deadline/model_call_cap
  if (stoppedReason === "deadline_exceeded" || stoppedReason === "model_call_cap") {
    const skippedStatus = stoppedReason === "deadline_exceeded" ? "skipped_deadline" as const : "skipped_model_call_cap" as const;
    for (let i = loopStoppedAt; i < toProcess.length; i++) {
      const entry = toProcess[i]!;
      const artifacts = preparedById.get(entry.componentId)?.artifacts ?? [];
      countStatus(skippedStatus);
      trace.push({
        componentId: entry.componentId,
        rank: i,
        componentBox: entry.component.box,
        pixelCount: entry.component.pixelCount,
        status: skippedStatus,
        artifactPaths: artifacts
      });
      regionOutcomes.push({ regionId: entry.componentId, state: "unresolved", reason: stoppedReason, artifactPaths: artifacts });
      unclassifiedCount++;
    }
  }

  const eligibleIds = new Set(eligible.map(entry => entry.componentId));
  const completedComponents = regionOutcomes.filter(outcome => eligibleIds.has(outcome.regionId) && outcome.state !== "unresolved").length;
  const remainingRegionIds = regionOutcomes
    .filter(outcome => eligibleIds.has(outcome.regionId) && outcome.state === "unresolved")
    .map(outcome => outcome.regionId);
  const skippedComponents = Math.max(0, eligible.length - loopStoppedAt);

  return {
    recovered,
    unclassifiedCount,
    eligibleComponents: eligible.length,
    completedComponents,
    remainingComponents: remainingRegionIds.length,
    batchCount,
    attemptedComponents,
    skippedComponents,
    stoppedReason,
    trace,
    statusCounts,
    regionOutcomes,
    cursor: {
      nextRegionIndex: loopStoppedAt,
      remainingModelCalls: Math.max(0, budget.maxModelCalls - modelCallsUsed),
      remainingRegionIds
    },
    ...(recoveryModel !== undefined ? { model: recoveryModel } : {})
  };
}
