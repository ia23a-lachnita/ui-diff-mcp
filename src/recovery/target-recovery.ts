import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { Box, DiffRecord, UiArtifact, UnassignedVisualEvidence, RecoveryComponentTrace, DeterministicMeasurement, RecoveryRegionOutcome } from "../schemas/core.js";
import { UiCriterionSchema } from "../schemas/core.js";
import type { PixelComponent } from "../signals/pixel-diff.js";
import type { VisionJsonCaller } from "../models/vision-json.js";
import { BudgetExhaustedError } from "../models/fallback-caller.js";
import type { BudgetedAttemptHook } from "../models/fallback-caller.js";
import { buildRecoveryPrompt, buildRecoveryReviewerPrompt, buildRecoveryRepairPrompt, type RepairPromptContext, type RecoveryReviewerContext } from "../audit/prompts.js";
import { validateClaim } from "../audit/review-findings.js";
import { type ImagePairTransform, projectExpectedBoxToActualSource } from "../images/coordinates.js";
import { extractImageCropFromBounds, resizeRgbaForComparison } from "../images/crop.js";
import { resolveComparisonExtraction, type ComparisonExtractionBounds } from "../images/comparison-geometry.js";
import { modelFamilyKey } from "../models/model-registry.js";

const CLASSIFIABLE_CRITERIA = UiCriterionSchema.exclude(["unclassified_visual_change"]);
const MIN_RECOVERY_EVIDENCE_SIZE = 2;

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

function createReserveCallHook(
  budget: RecoveryBudget,
  modelCallsUsedRef: { value: number },
  deadlineMs: number,
  nowFn: () => number = Date.now
): BudgetedAttemptHook {
  return {
    async reserveAttempt(_attemptIndex: number, currentTimeoutMs: number) {
      if (modelCallsUsedRef.value >= budget.maxModelCalls) {
        throw new BudgetExhaustedError('model_call_cap');
      }
      const remainingMs = deadlineMs - nowFn();
      if (remainingMs <= 0) {
        throw new BudgetExhaustedError('deadline_exceeded');
      }
      modelCallsUsedRef.value++;
      return {
        proceed: true,
        timeoutMs: Math.min(currentTimeoutMs, remainingMs)
      };
    }
  };
}

function resolveReservedTimeout(result: Awaited<ReturnType<BudgetedAttemptHook["reserveAttempt"]>>, fallbackMs: number): number {
  if (!result.proceed) {
    throw new BudgetExhaustedError(result.reason);
  }
  return result.timeoutMs ?? fallbackMs;
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
  reviewerResolver?: (recoveryProvider: string, recoveryModel: string) => VisionJsonCaller | undefined;
}

function extractRgbaCrop(
  imageData: Uint8Array,
  imageWidth: number,
  bounds: ComparisonExtractionBounds
): { data: Uint8Array; width: number; height: number } {
  return { data: extractImageCropFromBounds(imageData, imageWidth, bounds), width: bounds.width, height: bounds.height };
}

function extractMaskCrop(
  mask: Uint8Array,
  maskWidth: number,
  bounds: ComparisonExtractionBounds
): { data: Uint8Array; width: number; height: number } {
  const out = new Uint8Array(bounds.width * bounds.height);
  for (let row = 0; row < bounds.height; row++) {
    for (let col = 0; col < bounds.width; col++) {
      const src = (bounds.top + row) * maskWidth + (bounds.left + col);
      const dst = row * bounds.width + col;
      out[dst] = (mask[src] ?? 0) > 0 ? 255 : 0;
    }
  }
  return { data: out, width: bounds.width, height: bounds.height };
}

async function writePngArtifact(
  data: Uint8Array,
  width: number,
  height: number,
  outPath: string,
  channels: 1 | 4 = 4
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  if (width < 2 || height < 2) throw new Error("below_minimum_artifact_size");
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
    { raw: { width, height, channels } }
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

export type RecoveryRegionInput = PixelComponent & { id?: string };

interface PreparedRecoveryEvidence {
  status: "valid";
  regionId: string;
  component: RecoveryRegionInput;
  evidenceBox: Box;
  actualEvidenceBox: Box;
  artifacts: UiArtifact[];
  expCrop: { data: Uint8Array; width: number; height: number };
  actCrop: { data: Uint8Array; width: number; height: number };
  actComparisonCrop: { data: Uint8Array; width: number; height: number };
  overlayCrop: { data: Uint8Array; width: number; height: number };
  maskCrop: { data: Uint8Array; width: number; height: number };
}

interface RejectedRecoveryEvidence {
  status: "rejected";
  regionId: string;
  component: RecoveryRegionInput;
  evidenceBox: Box;
  actualEvidenceBox: Box;
  reason: string;
  artifacts: UiArtifact[];
}

type RecoveryEvidencePreparation = PreparedRecoveryEvidence | RejectedRecoveryEvidence;

function expandRecoveryEvidenceBox(box: Box, canvas: { width: number; height: number }): Box {
  const values = [box.x, box.y, box.width, box.height, canvas.width, canvas.height];
  if (!values.every(Number.isFinite) || box.width <= 0 || box.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
    return box;
  }
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(canvas.width, box.x + box.width);
  const bottom = Math.min(canvas.height, box.y + box.height);
  if (right <= left || bottom <= top) return box;

  const expandAxis = (start: number, size: number, limit: number): { start: number; size: number } => {
    if (size >= MIN_RECOVERY_EVIDENCE_SIZE || limit < MIN_RECOVERY_EVIDENCE_SIZE) return { start, size };
    return {
      start: Math.min(Math.max(0, start), limit - MIN_RECOVERY_EVIDENCE_SIZE),
      size: MIN_RECOVERY_EVIDENCE_SIZE
    };
  };
  const horizontal = expandAxis(left, right - left, canvas.width);
  const vertical = expandAxis(top, bottom - top, canvas.height);
  return { x: horizontal.start, y: vertical.start, width: horizontal.size, height: vertical.size };
}

export async function prepareRecoveryRegionArtifacts(
  regions: RecoveryRegionInput[],
  ctx: Pick<RecoveryContext, "expectedRgba" | "actualRgba" | "imagePairTransform" | "pixelDiffMask" | "directionalOverlayPath" | "artifactDir">
): Promise<RecoveryEvidencePreparation[]> {
  const overlayRawResult = await sharp(ctx.directionalOverlayPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const overlayData = new Uint8Array(overlayRawResult.data.buffer, overlayRawResult.data.byteOffset, overlayRawResult.data.byteLength);
  const prepared: RecoveryEvidencePreparation[] = [];
  for (let index = 0; index < regions.length; index++) {
    const component = regions[index]!;
    const regionId = component.id ?? `component-${String(index + 1).padStart(4, "0")}`;
    const safeId = regionId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const evidenceBox = expandRecoveryEvidenceBox(component.box, {
      width: ctx.expectedRgba.width,
      height: ctx.expectedRgba.height
    });
    const comparison = resolveComparisonExtraction({
      box: evidenceBox,
      sourceSpace: "comparison_expected_normalized",
      canvas: { width: ctx.expectedRgba.width, height: ctx.expectedRgba.height }
    });
    const projectedActualBox = ctx.imagePairTransform ? projectExpectedBoxToActualSource(evidenceBox, ctx.imagePairTransform) : evidenceBox;
    const actualEvidenceBox = expandRecoveryEvidenceBox(projectedActualBox, {
      width: ctx.actualRgba.width,
      height: ctx.actualRgba.height
    });
    const actual = resolveComparisonExtraction({
      box: actualEvidenceBox,
      sourceSpace: "comparison_expected_normalized",
      canvas: { width: ctx.actualRgba.width, height: ctx.actualRgba.height }
    });
    if (comparison.status === "rejected" || actual.status === "rejected") {
      prepared.push({
        status: "rejected",
        regionId,
        component,
        evidenceBox,
        actualEvidenceBox,
        reason: comparison.status === "rejected"
          ? comparison.reason
          : actual.status === "rejected"
            ? actual.reason
            : "below_minimum_artifact_size",
        artifacts: []
      });
      continue;
    }
    const expCrop = extractRgbaCrop(ctx.expectedRgba.data, ctx.expectedRgba.width, comparison.bounds);
    const actCrop = extractRgbaCrop(ctx.actualRgba.data, ctx.actualRgba.width, actual.bounds);
    const actComparisonCrop = {
      data: await resizeRgbaForComparison(actCrop, expCrop.width, expCrop.height),
      width: expCrop.width,
      height: expCrop.height
    };
    const overlayCrop = extractRgbaCrop(overlayData, overlayRawResult.info.width, comparison.bounds);
    const maskCrop = extractMaskCrop(ctx.pixelDiffMask, ctx.expectedRgba.width, comparison.bounds);
    const expCropPath = path.join(ctx.artifactDir, `recovery-${safeId}-expected.png`);
    const actCropPath = path.join(ctx.artifactDir, `recovery-${safeId}-actual.png`);
    const actComparisonCropPath = path.join(ctx.artifactDir, `recovery-${safeId}-actual-comparison.png`);
    const overlayPath = path.join(ctx.artifactDir, `recovery-${safeId}-overlay.png`);
    const maskPath = path.join(ctx.artifactDir, `recovery-${safeId}-mask.png`);
    await writePngArtifact(expCrop.data, expCrop.width, expCrop.height, expCropPath, 4);
    await writePngArtifact(actCrop.data, actCrop.width, actCrop.height, actCropPath, 4);
    await writePngArtifact(actComparisonCrop.data, actComparisonCrop.width, actComparisonCrop.height, actComparisonCropPath, 4);
    await writePngArtifact(overlayCrop.data, overlayCrop.width, overlayCrop.height, overlayPath, 4);
    await writePngArtifact(maskCrop.data, maskCrop.width, maskCrop.height, maskPath, 1);
    prepared.push({
      status: "valid",
      regionId,
      component,
      evidenceBox: comparison.box,
      actualEvidenceBox: actual.box,
      expCrop,
      actCrop,
      actComparisonCrop,
      overlayCrop,
      maskCrop,
      artifacts: [
        { role: "recovery_expected_crop", path: expCropPath },
        { role: "recovery_actual_crop", path: actCropPath },
        { role: "recovery_actual_comparison_crop", path: actComparisonCropPath },
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
  const rejectedEvidence = prepared.filter((entry): entry is RejectedRecoveryEvidence => entry.status === "rejected");
  for (const entry of rejectedEvidence) {
    countStatus("evidence_crop_rejected");
    unclassifiedCount++;
    trace.push({
      componentId: entry.regionId,
      rank: 0,
      componentBox: entry.component.box,
      evidenceBox: entry.evidenceBox,
      actualEvidenceBox: entry.actualEvidenceBox,
      pixelCount: entry.component.pixelCount,
      status: "evidence_crop_rejected",
      rejectionReason: entry.reason,
      artifactPaths: []
    });
    regionOutcomes.push({
      regionId: entry.regionId,
      state: "unresolved",
      reason: `evidence_crop_rejected: ${entry.reason}`,
      rejectionReason: entry.reason,
      artifactPaths: []
    });
  }

  // Push below-threshold traces
  for (const entry of ranked.filter(e => e.component.pixelCount < budget.minComponentPixels && preparedById.get(e.componentId)?.status === "valid")) {
    const preparedEvidence = preparedById.get(entry.componentId)! as PreparedRecoveryEvidence;
    const artifacts = preparedEvidence.artifacts;
    countStatus("below_threshold");
    trace.push({
      componentId: entry.componentId,
      rank: 0,
      componentBox: entry.component.box,
      evidenceBox: preparedEvidence.evidenceBox,
      actualEvidenceBox: preparedEvidence.actualEvidenceBox,
      pixelCount: entry.component.pixelCount,
      status: "below_threshold",
      artifactPaths: artifacts
    });
    regionOutcomes.push({ regionId: entry.componentId, state: "noise", reason: "below_threshold", artifactPaths: artifacts });
  }

  const eligible = ranked.filter(e => e.component.pixelCount >= budget.minComponentPixels && preparedById.get(e.componentId)?.status === "valid");
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
      countStatus("deadline_exceeded");
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
    const preparedEvidence = preparedById.get(componentId)! as PreparedRecoveryEvidence;
    const { expCrop, actComparisonCrop, overlayCrop, maskCrop, artifacts } = preparedEvidence;

    const evidence: UnassignedVisualEvidence = {
      id: evidenceId,
      componentBox: box,
      pixelCount: component.pixelCount,
      componentArea: Math.round(box.width * box.height),
      expectedCropArtifact: artifacts[0]!,
      actualCropArtifact: artifacts[1]!,
      actualComparisonCropArtifact: artifacts[2]!,
      directionalOverlayArtifact: artifacts[3]!,
      pixelDiffMaskArtifact: artifacts[4]!
    };

    const baseTrace = {
      componentId,
      rank: rankIndex,
      componentBox: box,
      evidenceBox: preparedEvidence.evidenceBox,
      actualEvidenceBox: preparedEvidence.actualEvidenceBox,
      pixelCount: component.pixelCount,
      artifactPaths: artifacts
    };

    // Encode crops for VLM
    const expB64 = await toBase64Png(expCrop.data, expCrop.width, expCrop.height, 4);
    const actB64 = await toBase64Png(actComparisonCrop.data, actComparisonCrop.width, actComparisonCrop.height, 4);
    const overlayB64 = await toBase64Png(overlayCrop.data, overlayCrop.width, overlayCrop.height, 4);
    const maskB64 = await toBase64Png(maskCrop.data, maskCrop.width, maskCrop.height, 1);

    const images = [
      `data:image/png;base64,${expB64}`,
      `data:image/png;base64,${actB64}`,
      `data:image/png;base64,${overlayB64}`,
      `data:image/png;base64,${maskB64}`
    ];

    const regionAreaPixels = Math.round(box.width * box.height);
    const deterministicMeasurements: DeterministicMeasurement[] = [
      { name: "changed_pixel_count", value: component.pixelCount, unit: "pixels" },
      { name: "region_area_pixels", value: regionAreaPixels, unit: "px²" },
      { name: "changed_pixel_percent", value: regionAreaPixels > 0 ? Math.round((component.pixelCount / regionAreaPixels) * 10000) / 100 : 0, unit: "%" },
      { name: "coordinateSource", value: "deterministic_pixel_component" }
    ];
    const recoveryPrompt = buildRecoveryPrompt(component.pixelCount, regionAreaPixels, deterministicMeasurements);

    let vlmResponse: z.infer<typeof RecoveryVlmResponseSchema>;
    let componentRecoveryModel = "unknown";
    let componentRecoveryProvider = "unknown";
    const recoveryStarted = Date.now();
    const modelCallsUsedRef = { value: modelCallsUsed };
    const reserveHook = createReserveCallHook(budget, modelCallsUsedRef, budget.deadlineMs);
    try {
      const remainingDeadlineMs = budget.deadlineMs - Date.now();
      if (remainingDeadlineMs <= 0) {
        stoppedReason = "deadline_exceeded";
        countStatus("deadline_exceeded");
        trace.push({ ...baseTrace, status: "deadline_exceeded", model: componentRecoveryModel, recoveryDurationMs: 0 });
        regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: "deadline_exceeded", artifactPaths: artifacts });
        unclassifiedCount++;
        loopStoppedAt = rankIndex + 1;
        break;
      }
      const timeoutMs = Math.min(60000, remainingDeadlineMs);
      const initialReservation = await reserveHook.reserveAttempt(0, timeoutMs);
      const res = await ctx.recoveryCaller({
        prompt: recoveryPrompt,
        images,
        jsonSchema: { name: "recovery_classification", schema: RECOVERY_JSON_SCHEMA },
        timeoutMs: resolveReservedTimeout(initialReservation, timeoutMs),
        reserveCall: reserveHook,
        initialAttemptReserved: true
      });
      modelCallsUsed = modelCallsUsedRef.value;
      componentRecoveryModel = res.model;
      componentRecoveryProvider = res.provider;
      if (!recoveryModel) {
        recoveryModel = res.model;
      }
      vlmResponse = RecoveryVlmResponseSchema.parse(res.parsed);
      if (Date.now() >= budget.deadlineMs) {
        const lateRawMeasurements = (vlmResponse.measurements ?? []).map(m => ({
          name: m.name,
          value: m.value as string | number | boolean,
          ...(m.unit !== undefined ? { unit: m.unit } : {})
        }));
        const lateCandidateTitle = vlmResponse.classified && vlmResponse.criterion && vlmResponse.label
          ? `${vlmResponse.criterion} in recovered region: ${vlmResponse.label}`.slice(0, 200)
          : undefined;
        const lateCandidateEvidence = vlmResponse.classified && vlmResponse.evidence
          ? vlmResponse.evidence.slice(0, 10).map(item => item.slice(0, 200))
          : undefined;
        stoppedReason = "deadline_exceeded";
        countStatus("deadline_exceeded");
        trace.push({
          ...baseTrace,
          status: "deadline_exceeded",
          model: res.model,
          provider: res.provider,
          recoveryDurationMs: Date.now() - recoveryStarted,
          repairAttempted: false,
          rawModelProposedMeasurements: lateRawMeasurements,
          originalCandidateRawMeasurements: lateRawMeasurements,
          ...(vlmResponse.criterion !== undefined ? { criterion: vlmResponse.criterion } : {}),
          ...(lateCandidateTitle !== undefined ? { originalCandidateTitle: lateCandidateTitle } : {}),
          ...(lateCandidateEvidence !== undefined ? { originalCandidateEvidence: lateCandidateEvidence } : {})
        });
        regionOutcomes.push({
          regionId: componentId,
          state: "unresolved",
          reason: "deadline_exceeded",
          artifactPaths: artifacts,
          model: res.model,
          provider: res.provider,
          recoveryDurationMs: Date.now() - recoveryStarted,
          repairAttempted: false,
          rawModelProposedMeasurements: lateRawMeasurements,
          originalCandidateRawMeasurements: lateRawMeasurements,
          ...(lateCandidateTitle !== undefined ? { originalCandidateTitle: lateCandidateTitle } : {}),
          ...(lateCandidateEvidence !== undefined ? { originalCandidateEvidence: lateCandidateEvidence } : {})
        });
        unclassifiedCount++;
        loopStoppedAt = rankIndex + 1;
        break;
      }
    } catch (err) {
      modelCallsUsed = modelCallsUsedRef.value;
      if (err instanceof BudgetExhaustedError) {
        const isDeadline = err.reason.includes('deadline');
        stoppedReason = isDeadline ? 'deadline_exceeded' : 'model_call_cap';
        const traceStatus = isDeadline ? 'deadline_exceeded' : 'skipped_model_call_cap';
        countStatus(traceStatus);
        trace.push({ ...baseTrace, status: traceStatus, model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs: Date.now() - recoveryStarted });
        regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: traceStatus, artifactPaths: artifacts });
        unclassifiedCount++;
        loopStoppedAt = rankIndex + 1;
        break;
      }
      const isDeadlineExceeded = Date.now() >= budget.deadlineMs;
      const traceStatus = isDeadlineExceeded ? "deadline_exceeded" as const
        : err instanceof z.ZodError ? "recovery_schema_error" as const
        : "recovery_error" as const;
      if (isDeadlineExceeded) {
        stoppedReason = "deadline_exceeded";
      }
      countStatus(traceStatus);
      trace.push({
        ...baseTrace,
        status: traceStatus,
        model: componentRecoveryModel,
        provider: componentRecoveryProvider,
        recoveryDurationMs: Date.now() - recoveryStarted,
        ...(isDeadlineExceeded ? {} : {
          errorKind: err instanceof z.ZodError ? "schema" as const : "provider" as const,
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)
        })
      });
      console.error(`Recovery VLM call failed for component ${evidenceId}:`, err);
      unclassifiedCount++;
      regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: traceStatus, artifactPaths: artifacts, provider: componentRecoveryProvider });
      if (isDeadlineExceeded) {
        loopStoppedAt = rankIndex + 1;
        break;
      }
      continue;
    }
    const recoveryDurationMs = Date.now() - recoveryStarted;

    // Resolve independent reviewer based on actual recovery provider/model
    const resolvedReviewer = ctx.reviewerResolver
      ? ctx.reviewerResolver(componentRecoveryProvider, componentRecoveryModel)
      : ctx.reviewerCaller;

    const baseMeasurements = (vlmResponse.measurements ?? []).map(m => ({
      name: m.name,
      value: m.value as string | number | boolean,
      ...(m.unit !== undefined ? { unit: m.unit } : {})
    }));

    // VLM explicitly determined no regression in this region — valid verdict, not a failure.
    if (!vlmResponse.classified) {
      countStatus("classified_false");
      trace.push({ ...baseTrace, status: "classified_false", model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs, rawModelProposedMeasurements: baseMeasurements });
      regionOutcomes.push({ regionId: componentId, state: "noise", reason: "classified_false", artifactPaths: artifacts, provider: componentRecoveryProvider, rawModelProposedMeasurements: baseMeasurements });
      continue;
    }

    if (
      !vlmResponse.criterion ||
      !vlmResponse.label ||
      !vlmResponse.evidence
    ) {
      countStatus("missing_required_fields");
      trace.push({ ...baseTrace, status: "missing_required_fields", model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs, rawModelProposedMeasurements: baseMeasurements });
      unclassifiedCount++;
      regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: "missing_required_fields", artifactPaths: artifacts, provider: componentRecoveryProvider, rawModelProposedMeasurements: baseMeasurements });
      continue;
    }

    // The VLM supplies semantic classification only. The deterministic pixel
    // component is the authoritative full-screen location for this crop.
    const recoveredBox = component.box;
    const candidateTitle = `${vlmResponse.criterion} in recovered region: ${vlmResponse.label}`.slice(0, 200);
    const candidateEvidence = vlmResponse.evidence.slice(0, 10).map(evidence => evidence.slice(0, 200));
    const candidateMeasurements = [...deterministicMeasurements].slice(0, 10);

    // Validate candidate BEFORE reviewer — only deterministic measurements
    const candidateForValidation: Pick<DiffRecord, "title" | "evidence" | "measurements"> = {
      title: candidateTitle,
      evidence: candidateEvidence,
      measurements: deterministicMeasurements
    };
    const initialValidation = validateClaim(candidateForValidation);

    // Repair logic: if initial validation fails, attempt one repair call
    let repairedBaseMeasurements: { name: string; value: string | number | boolean; unit?: string }[] = [];
    let activeCandidate = {
      criterion: vlmResponse.criterion,
      label: vlmResponse.label,
      severity: vlmResponse.severity ?? "medium",
      title: candidateTitle,
      evidence: candidateEvidence,
      measurements: candidateMeasurements,
      validation: initialValidation,
      isRepaired: false,
      repairModel: undefined as string | undefined,
      repairProvider: undefined as string | undefined,
      repairDurationMs: undefined as number | undefined
    };

    if (!initialValidation.valid) {
      // Budget-awareness: skip repair if budget cannot cover repair + reviewer
      const remainingAfterInitial = budget.maxModelCalls - modelCallsUsed;
      const hasTimeForRepairAndReviewer = Date.now() < budget.deadlineMs;
      if (!hasTimeForRepairAndReviewer) {
        stoppedReason = "deadline_exceeded";
        countStatus("deadline_exceeded");
        trace.push({
          ...baseTrace,
          status: "deadline_exceeded",
          model: componentRecoveryModel,
          provider: componentRecoveryProvider,
          recoveryDurationMs,
          criterion: vlmResponse.criterion,
          repairAttempted: false,
          rejectionReason: initialValidation.reason ?? "Validation failed",
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        });
        regionOutcomes.push({
          regionId: componentId,
          state: "unresolved",
          reason: "deadline_exceeded",
          artifactPaths: artifacts,
          repairAttempted: false,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          provider: componentRecoveryProvider,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        });
        unclassifiedCount++;
        loopStoppedAt = rankIndex + 1;
        break;
      }
      if (remainingAfterInitial < 2) {
        countStatus("budget_exhausted_before_repair");
        trace.push({
          ...baseTrace,
          status: "budget_exhausted_before_repair",
          model: componentRecoveryModel,
          provider: componentRecoveryProvider,
          recoveryDurationMs,
          criterion: vlmResponse.criterion,
          repairAttempted: false,
          rejectionReason: initialValidation.reason ?? "Validation failed",
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        });
        regionOutcomes.push({
          regionId: componentId,
          state: "unresolved",
          reason: "budget_exhausted_before_repair",
          artifactPaths: artifacts,
          repairAttempted: false,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          provider: componentRecoveryProvider,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        });
        unclassifiedCount++;
        continue;
      }

      const repairStarted = Date.now();
      const repairContext: RepairPromptContext = {
        originalCriterion: vlmResponse.criterion,
        originalLabel: vlmResponse.label,
        originalTitle: candidateTitle,
        originalEvidence: candidateEvidence,
        diagnosticCode: initialValidation.diagnostics?.code ?? "unknown",
        diagnosticMessage: initialValidation.diagnostics?.message ?? initialValidation.reason ?? "Validation failed",
        ...(initialValidation.diagnostics?.offendingExcerpt !== undefined ? { diagnosticExcerpt: initialValidation.diagnostics.offendingExcerpt } : {}),
        measurements: deterministicMeasurements
      };
      const repairPrompt = buildRecoveryRepairPrompt(repairContext);
      let repairCallStarted = false;

      try {
        const repairRemainingMs = budget.deadlineMs - Date.now();
        if (repairRemainingMs <= 0) {
          stoppedReason = "deadline_exceeded";
          countStatus("deadline_exceeded");
          trace.push({ ...baseTrace, status: "deadline_exceeded", model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs, repairAttempted: false, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) });
          regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: "deadline_exceeded", artifactPaths: artifacts, repairAttempted: false, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, provider: componentRecoveryProvider, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) });
          unclassifiedCount++;
          loopStoppedAt = rankIndex + 1;
          break;
        }
        const repairTimeoutMs = Math.min(60000, repairRemainingMs);
        const initialReservation = await reserveHook.reserveAttempt(0, repairTimeoutMs);
        const reservedRepairTimeoutMs = resolveReservedTimeout(initialReservation, repairTimeoutMs);
        repairCallStarted = true;
        const repairRes = await ctx.recoveryCaller({
          prompt: repairPrompt,
          images,
          jsonSchema: { name: "recovery_classification", schema: RECOVERY_JSON_SCHEMA },
          timeoutMs: reservedRepairTimeoutMs,
          reserveCall: reserveHook,
          initialAttemptReserved: true
        });
        modelCallsUsed = modelCallsUsedRef.value;
        if (Date.now() >= budget.deadlineMs) {
          stoppedReason = "deadline_exceeded";
          countStatus("deadline_exceeded");
          trace.push({ ...baseTrace, status: "deadline_exceeded", model: componentRecoveryModel, provider: componentRecoveryProvider, repairModel: repairRes.model, repairProvider: repairRes.provider, recoveryDurationMs, repairDurationMs: Date.now() - repairStarted, repairAttempted: true, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) });
          regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: "deadline_exceeded", artifactPaths: artifacts, repairAttempted: true, model: componentRecoveryModel, repairModel: repairRes.model, repairProvider: repairRes.provider, recoveryDurationMs, repairDurationMs: Date.now() - repairStarted, provider: componentRecoveryProvider, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) });
          unclassifiedCount++;
          loopStoppedAt = rankIndex + 1;
          break;
        }
        const repairDurationMs = Date.now() - repairStarted;
        const repairResponse = RecoveryVlmResponseSchema.parse(repairRes.parsed);
        repairedBaseMeasurements = (repairResponse.measurements ?? []).map(m => ({
          name: m.name,
          value: m.value as string | number | boolean,
          ...(m.unit !== undefined ? { unit: m.unit } : {})
        }));

        if (!repairResponse.classified) {
          // Repair determined no regression — remain unresolved
          countStatus("repair_classified_false");
          trace.push({
            ...baseTrace,
            status: "repair_classified_false",
            model: componentRecoveryModel,
            provider: componentRecoveryProvider,
            repairModel: repairRes.model,
            repairProvider: repairRes.provider,
            recoveryDurationMs,
            repairDurationMs,
            criterion: vlmResponse.criterion,
            repairAttempted: true,
            originalCandidateTitle: candidateTitle,
            originalCandidateEvidence: candidateEvidence,
            originalCandidateMeasurements: candidateMeasurements,
            rawModelProposedMeasurements: baseMeasurements,
            originalCandidateRawMeasurements: baseMeasurements,
            ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
          });
          regionOutcomes.push({
            regionId: componentId,
            state: "unresolved",
            reason: "repair_classified_false",
            artifactPaths: artifacts,
            repairAttempted: true,
            repairModel: repairRes.model,
            repairProvider: repairRes.provider,
            repairDurationMs,
            provider: componentRecoveryProvider,
            originalCandidateTitle: candidateTitle,
            originalCandidateEvidence: candidateEvidence,
            originalCandidateMeasurements: candidateMeasurements,
            rawModelProposedMeasurements: baseMeasurements,
            originalCandidateRawMeasurements: baseMeasurements,
            ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
          });
          unclassifiedCount++;
          continue;
        }

        if (!repairResponse.criterion || !repairResponse.label || !repairResponse.evidence) {
          countStatus("repair_schema_failure");
          trace.push({
            ...baseTrace,
            status: "repair_schema_failure",
            model: componentRecoveryModel,
            provider: componentRecoveryProvider,
            repairModel: repairRes.model,
            repairProvider: repairRes.provider,
            recoveryDurationMs,
            repairDurationMs,
            errorKind: "schema",
            errorMessage: "Repair response missing required fields",
            repairAttempted: true,
            originalCandidateTitle: candidateTitle,
            originalCandidateEvidence: candidateEvidence,
            originalCandidateMeasurements: candidateMeasurements,
            rawModelProposedMeasurements: baseMeasurements,
            originalCandidateRawMeasurements: baseMeasurements,
            ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
          });
          regionOutcomes.push({
            regionId: componentId,
            state: "unresolved",
            reason: "repair_schema_failure",
            artifactPaths: artifacts,
            repairAttempted: true,
            repairModel: repairRes.model,
            repairProvider: repairRes.provider,
            repairDurationMs,
            provider: componentRecoveryProvider,
            originalCandidateTitle: candidateTitle,
            originalCandidateEvidence: candidateEvidence,
            originalCandidateMeasurements: candidateMeasurements,
            rawModelProposedMeasurements: baseMeasurements,
            originalCandidateRawMeasurements: baseMeasurements,
            ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
          });
          unclassifiedCount++;
          continue;
        }

        // Enforce same criterion when classified true
        if (repairResponse.criterion !== vlmResponse.criterion) {
          countStatus("repair_criterion_change");
          const repairedTitle = `${repairResponse.criterion} in recovered region: ${repairResponse.label}`.slice(0, 200);
          const repairedEvidence = repairResponse.evidence.slice(0, 10).map(e => e.slice(0, 200));
          trace.push({
            ...baseTrace,
            status: "repair_criterion_change",
            model: componentRecoveryModel,
            provider: componentRecoveryProvider,
            repairModel: repairRes.model,
            repairProvider: repairRes.provider,
            recoveryDurationMs,
            repairDurationMs,
            criterion: repairResponse.criterion,
            repairAttempted: true,
            originalCandidateTitle: candidateTitle,
            originalCandidateEvidence: candidateEvidence,
            originalCandidateMeasurements: candidateMeasurements,
            rawModelProposedMeasurements: baseMeasurements,
            originalCandidateRawMeasurements: baseMeasurements,
            repairedCandidateRawMeasurements: repairedBaseMeasurements,
            ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}),
            repairedCandidateTitle: repairedTitle,
            repairedCandidateEvidence: repairedEvidence
          });
          regionOutcomes.push({
            regionId: componentId,
            state: "unresolved",
            reason: "repair_criterion_change",
            artifactPaths: artifacts,
            repairAttempted: true,
            repairModel: repairRes.model,
            repairProvider: repairRes.provider,
            repairDurationMs,
            originalCandidateTitle: candidateTitle,
            originalCandidateEvidence: candidateEvidence,
            originalCandidateMeasurements: candidateMeasurements,
            rawModelProposedMeasurements: baseMeasurements,
            originalCandidateRawMeasurements: baseMeasurements,
            repairedCandidateRawMeasurements: repairedBaseMeasurements,
            provider: componentRecoveryProvider,
            ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}),
            repairedCandidateTitle: repairedTitle,
            repairedCandidateEvidence: repairedEvidence
          });
          unclassifiedCount++;
          continue;
        }

        // Build repaired candidate and validate
        const repairedTitle = `${repairResponse.criterion} in recovered region: ${repairResponse.label}`.slice(0, 200);
        const repairedEvidence = repairResponse.evidence.slice(0, 10).map(e => e.slice(0, 200));
        const repairedMeasurements = [...deterministicMeasurements].slice(0, 10);

        const repairedValidation = validateClaim({
          title: repairedTitle,
          evidence: repairedEvidence,
          measurements: deterministicMeasurements
        });

        if (!repairedValidation.valid) {
          // Still invalid after repair — remain unresolved
          countStatus("still_invalid");
          trace.push({
            ...baseTrace,
            status: "still_invalid",
            model: componentRecoveryModel,
            provider: componentRecoveryProvider,
            repairModel: repairRes.model,
            repairProvider: repairRes.provider,
            recoveryDurationMs,
            repairDurationMs,
            criterion: vlmResponse.criterion,
            repairAttempted: true,
            rejectionReason: repairedValidation.reason ?? "Still invalid after repair",
            originalCandidateTitle: candidateTitle,
            originalCandidateEvidence: candidateEvidence,
            originalCandidateMeasurements: candidateMeasurements,
            rawModelProposedMeasurements: baseMeasurements,
            originalCandidateRawMeasurements: baseMeasurements,
            ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}),
            repairedCandidateTitle: repairedTitle,
            repairedCandidateEvidence: repairedEvidence,
            repairedCandidateMeasurements: repairedMeasurements,
            repairedCandidateRawMeasurements: repairedBaseMeasurements,
            ...(repairedValidation.diagnostics !== undefined ? { repairedCandidateDiagnostics: repairedValidation.diagnostics } : {})
          });
          regionOutcomes.push({
            regionId: componentId,
            state: "unresolved",
            reason: "still_invalid",
            rejectionReason: repairedValidation.reason ?? "Still invalid after repair",
            artifactPaths: artifacts,
            repairAttempted: true,
            repairModel: repairRes.model,
            repairProvider: repairRes.provider,
            repairDurationMs,
            provider: componentRecoveryProvider,
            originalCandidateTitle: candidateTitle,
            originalCandidateEvidence: candidateEvidence,
            originalCandidateMeasurements: candidateMeasurements,
            rawModelProposedMeasurements: baseMeasurements,
            originalCandidateRawMeasurements: baseMeasurements,
            repairedCandidateMeasurements: repairedMeasurements,
            repairedCandidateRawMeasurements: repairedBaseMeasurements,
            ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}),
            repairedCandidateTitle: repairedTitle,
            repairedCandidateEvidence: repairedEvidence,
            ...(repairedValidation.diagnostics !== undefined ? { repairedCandidateDiagnostics: repairedValidation.diagnostics } : {})
          });
          unclassifiedCount++;
          continue;
        }

        // Repair succeeded and passes validation — use repaired candidate for reviewer
        activeCandidate = {
          criterion: repairResponse.criterion,
          label: repairResponse.label,
          severity: repairResponse.severity ?? "medium",
          title: repairedTitle,
          evidence: repairedEvidence,
          measurements: repairedMeasurements,
          validation: repairedValidation,
          isRepaired: true,
          repairModel: repairRes.model,
          repairProvider: repairRes.provider,
          repairDurationMs
        };
      } catch (err) {
        modelCallsUsed = modelCallsUsedRef.value;
        if (err instanceof BudgetExhaustedError) {
          const isDeadline = err.reason.includes('deadline');
          stoppedReason = isDeadline ? 'deadline_exceeded' : 'model_call_cap';
          const traceStatus = isDeadline ? 'deadline_exceeded' : 'skipped_model_call_cap';
          countStatus(traceStatus);
          trace.push({ ...baseTrace, status: traceStatus, model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs: Date.now() - recoveryStarted, ...(repairCallStarted ? { repairDurationMs: Date.now() - repairStarted } : {}), repairAttempted: repairCallStarted, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) });
          regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: traceStatus, artifactPaths: artifacts, repairAttempted: repairCallStarted, model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs: Date.now() - recoveryStarted, ...(repairCallStarted ? { repairDurationMs: Date.now() - repairStarted } : {}), originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) });
          unclassifiedCount++;
          loopStoppedAt = rankIndex + 1;
          break;
        }
        const repairDurationMs = Date.now() - repairStarted;
        const isDeadlineExceeded = Date.now() >= budget.deadlineMs;
        if (isDeadlineExceeded) {
          stoppedReason = "deadline_exceeded";
          countStatus("deadline_exceeded");
          trace.push({ ...baseTrace, status: "deadline_exceeded", model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs, repairDurationMs, repairAttempted: true, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) });
          regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: "deadline_exceeded", artifactPaths: artifacts, repairAttempted: true, provider: componentRecoveryProvider, recoveryDurationMs, repairDurationMs, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) });
          unclassifiedCount++;
          loopStoppedAt = rankIndex + 1;
          break;
        }
        const traceStatus = err instanceof z.ZodError ? "repair_schema_failure" as const : "repair_provider_failure" as const;
        countStatus(traceStatus);
        trace.push({
          ...baseTrace,
          status: traceStatus,
          model: componentRecoveryModel,
          provider: componentRecoveryProvider,
          repairDurationMs,
          errorKind: err instanceof z.ZodError ? "schema" as const : "provider",
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          recoveryDurationMs,
          repairAttempted: true,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        });
        regionOutcomes.push({
          regionId: componentId,
          state: "unresolved",
          reason: traceStatus,
          artifactPaths: artifacts,
          repairAttempted: true,
          repairDurationMs,
          provider: componentRecoveryProvider,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        });
        unclassifiedCount++;
        continue;
      }
    }

    // Budget-awareness: check if we have budget for reviewer
    const remainingBeforeReviewer = budget.maxModelCalls - modelCallsUsed;
    const hasTimeForReviewer = Date.now() < budget.deadlineMs;
    if (remainingBeforeReviewer < 1 || !hasTimeForReviewer) {
      countStatus("budget_exhausted_before_reviewer");
      trace.push({
        ...baseTrace,
        status: "budget_exhausted_before_reviewer",
        model: componentRecoveryModel,
        provider: componentRecoveryProvider,
        recoveryDurationMs,
        criterion: activeCandidate.criterion,
        ...(activeCandidate.isRepaired ? {
          repairAttempted: true,
          repairModel: activeCandidate.repairModel,
          repairProvider: activeCandidate.repairProvider,
          repairDurationMs: activeCandidate.repairDurationMs,
          originalCandidateSeverity: vlmResponse.severity ?? "medium",
          repairedCandidateSeverity: activeCandidate.severity,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        } : { rawModelProposedMeasurements: baseMeasurements })
      });
      unclassifiedCount++;
      regionOutcomes.push({
        regionId: componentId,
        state: "unresolved",
        reason: remainingBeforeReviewer < 1 ? "budget_exhausted_before_reviewer" : "deadline_exceeded",
        artifactPaths: artifacts,
        ...(activeCandidate.isRepaired ? {
          repairAttempted: true,
          repairModel: activeCandidate.repairModel,
          repairProvider: activeCandidate.repairProvider,
          repairDurationMs: activeCandidate.repairDurationMs,
          originalCandidateSeverity: vlmResponse.severity ?? "medium",
          repairedCandidateSeverity: activeCandidate.severity,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        } : { rawModelProposedMeasurements: baseMeasurements }),
        provider: componentRecoveryProvider
      });
      continue;
    }

    // Check if resolver returned undefined (no independent route available)
    if (ctx.reviewerResolver && resolvedReviewer === undefined) {
      countStatus("independent_reviewer_unavailable");
      trace.push({
        ...baseTrace,
        status: "independent_reviewer_unavailable",
        model: componentRecoveryModel,
        provider: componentRecoveryProvider,
        recoveryDurationMs,
        criterion: activeCandidate.criterion,
        ...(activeCandidate.isRepaired ? {
          repairAttempted: true,
          repairModel: activeCandidate.repairModel,
          repairProvider: activeCandidate.repairProvider,
          repairDurationMs: activeCandidate.repairDurationMs,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        } : { rawModelProposedMeasurements: baseMeasurements })
      });
      regionOutcomes.push({
        regionId: componentId,
        state: "unresolved",
        reason: "independent_reviewer_unavailable",
        artifactPaths: artifacts,
        provider: componentRecoveryProvider,
        ...(activeCandidate.isRepaired ? {
          repairAttempted: true,
          repairModel: activeCandidate.repairModel,
          repairProvider: activeCandidate.repairProvider,
          repairDurationMs: activeCandidate.repairDurationMs,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        } : { rawModelProposedMeasurements: baseMeasurements })
      });
      unclassifiedCount++;
      continue;
    }

    // Build reviewer prompt with repair context when available
    const reviewerRepairContext: RecoveryReviewerContext | undefined = activeCandidate.isRepaired ? {
      originalCandidateTitle: candidateTitle,
      originalCandidateEvidence: candidateEvidence,
      diagnosticCode: initialValidation.diagnostics?.code ?? "unknown",
      diagnosticMessage: initialValidation.diagnostics?.message ?? initialValidation.reason ?? "Validation failed",
      repairedCandidateTitle: activeCandidate.title,
      repairedCandidateEvidence: activeCandidate.evidence
    } : undefined;

    const reviewerPrompt = buildRecoveryReviewerPrompt(
      activeCandidate.criterion,
      activeCandidate.label,
      activeCandidate.title,
      activeCandidate.evidence,
      deterministicMeasurements,
      reviewerRepairContext
    );

    let reviewDecision: "accepted" | "rejected" | "needs_escalation" = "accepted";
    const reviewerStarted = Date.now();
    let reviewerModel = "unknown";
    let reviewerProvider: string | undefined;
    let reviewReason: string | undefined;
    try {
      const reviewerRemainingMs = budget.deadlineMs - Date.now();
      if (reviewerRemainingMs <= 0) {
        stoppedReason = "deadline_exceeded";
        countStatus("deadline_exceeded");
        trace.push({ ...baseTrace, status: "deadline_exceeded", model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs, reviewerDurationMs: 0, criterion: activeCandidate.criterion, ...(activeCandidate.isRepaired ? { repairAttempted: true, repairModel: activeCandidate.repairModel, repairProvider: activeCandidate.repairProvider, repairDurationMs: activeCandidate.repairDurationMs, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) } : { rawModelProposedMeasurements: baseMeasurements }) });
        regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: "deadline_exceeded", artifactPaths: artifacts, model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs, reviewerDurationMs: 0, criterion: activeCandidate.criterion, ...(activeCandidate.isRepaired ? { repairAttempted: true, repairModel: activeCandidate.repairModel, repairProvider: activeCandidate.repairProvider, repairDurationMs: activeCandidate.repairDurationMs, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) } : { rawModelProposedMeasurements: baseMeasurements }) });
        unclassifiedCount++;
        loopStoppedAt = rankIndex + 1;
        break;
      }
      const reviewerTimeoutMs = Math.min(30000, reviewerRemainingMs);
      const initialReservation = await reserveHook.reserveAttempt(0, reviewerTimeoutMs);
      const reviewRes = await resolvedReviewer!({
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
        timeoutMs: resolveReservedTimeout(initialReservation, reviewerTimeoutMs),
        reserveCall: reserveHook,
        initialAttemptReserved: true
      });
      modelCallsUsed = modelCallsUsedRef.value;
      if (Date.now() >= budget.deadlineMs) {
        stoppedReason = "deadline_exceeded";
        countStatus("deadline_exceeded");
        trace.push({ ...baseTrace, status: "deadline_exceeded", model: componentRecoveryModel, provider: componentRecoveryProvider, reviewerModel: reviewRes.model, reviewerProvider: reviewRes.provider, recoveryDurationMs, reviewerDurationMs: Date.now() - reviewerStarted, criterion: activeCandidate.criterion, ...(activeCandidate.isRepaired ? { repairAttempted: true, repairModel: activeCandidate.repairModel, repairProvider: activeCandidate.repairProvider, repairDurationMs: activeCandidate.repairDurationMs, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) } : { rawModelProposedMeasurements: baseMeasurements }) });
        regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: "deadline_exceeded", artifactPaths: artifacts, model: componentRecoveryModel, provider: componentRecoveryProvider, reviewerProvider: reviewRes.provider, reviewerModel: reviewRes.model, recoveryDurationMs, reviewerDurationMs: Date.now() - reviewerStarted, criterion: activeCandidate.criterion, ...(activeCandidate.isRepaired ? { repairAttempted: true, repairModel: activeCandidate.repairModel, repairProvider: activeCandidate.repairProvider, repairDurationMs: activeCandidate.repairDurationMs, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) } : { rawModelProposedMeasurements: baseMeasurements }) });
        unclassifiedCount++;
        loopStoppedAt = rankIndex + 1;
        break;
      }
      const parsed = ReviewDecisionSchema.parse(reviewRes.parsed);
      reviewDecision = parsed.decision;
      reviewReason = parsed.reason;
      reviewerModel = reviewRes.model;
      reviewerProvider = reviewRes.provider;
    } catch (err) {
      modelCallsUsed = modelCallsUsedRef.value;
      if (err instanceof BudgetExhaustedError) {
        const isDeadline = err.reason.includes('deadline');
        stoppedReason = isDeadline ? 'deadline_exceeded' : 'model_call_cap';
        const traceStatus = isDeadline ? 'deadline_exceeded' : 'skipped_model_call_cap';
        countStatus(traceStatus);
        trace.push({ ...baseTrace, status: traceStatus, model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs: Date.now() - recoveryStarted, reviewerDurationMs: Date.now() - reviewerStarted, criterion: activeCandidate.criterion, ...(activeCandidate.isRepaired ? { repairAttempted: true, repairModel: activeCandidate.repairModel, repairProvider: activeCandidate.repairProvider, repairDurationMs: activeCandidate.repairDurationMs, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) } : { rawModelProposedMeasurements: baseMeasurements }) });
        regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: traceStatus, artifactPaths: artifacts, model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs: Date.now() - recoveryStarted, reviewerDurationMs: Date.now() - reviewerStarted, criterion: activeCandidate.criterion, ...(activeCandidate.isRepaired ? { repairAttempted: true, repairModel: activeCandidate.repairModel, repairProvider: activeCandidate.repairProvider, repairDurationMs: activeCandidate.repairDurationMs, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) } : { rawModelProposedMeasurements: baseMeasurements }) });
        unclassifiedCount++;
        loopStoppedAt = rankIndex + 1;
        break;
      }
      console.error(`Recovery reviewer call failed for component ${evidenceId}:`, err);
      const isDeadlineExceeded = Date.now() >= budget.deadlineMs;
      if (isDeadlineExceeded) {
        stoppedReason = "deadline_exceeded";
        countStatus("deadline_exceeded");
        trace.push({ ...baseTrace, status: "deadline_exceeded", model: componentRecoveryModel, provider: componentRecoveryProvider, reviewerModel, reviewerProvider, recoveryDurationMs, reviewerDurationMs: Date.now() - reviewerStarted, criterion: activeCandidate.criterion, ...(activeCandidate.isRepaired ? { repairAttempted: true, repairModel: activeCandidate.repairModel, repairProvider: activeCandidate.repairProvider, repairDurationMs: activeCandidate.repairDurationMs, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) } : { rawModelProposedMeasurements: baseMeasurements }) });
        regionOutcomes.push({ regionId: componentId, state: "unresolved", reason: "deadline_exceeded", artifactPaths: artifacts, model: componentRecoveryModel, provider: componentRecoveryProvider, recoveryDurationMs, reviewerDurationMs: Date.now() - reviewerStarted, criterion: activeCandidate.criterion, ...(activeCandidate.isRepaired ? { repairAttempted: true, repairModel: activeCandidate.repairModel, repairProvider: activeCandidate.repairProvider, repairDurationMs: activeCandidate.repairDurationMs, originalCandidateTitle: candidateTitle, originalCandidateEvidence: candidateEvidence, originalCandidateMeasurements: candidateMeasurements, rawModelProposedMeasurements: baseMeasurements, originalCandidateRawMeasurements: baseMeasurements, ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}) } : { rawModelProposedMeasurements: baseMeasurements }) });
        unclassifiedCount++;
        loopStoppedAt = rankIndex + 1;
        break;
      }
      reviewDecision = "needs_escalation";
    }
    const reviewerDurationMs = Date.now() - reviewerStarted;

    // Independence check: reviewer must not use same provider+model or same model family as recovery
    const reviewerFamily = modelFamilyKey(reviewerModel);
    const recoveryFamilyActual = modelFamilyKey(componentRecoveryModel);
    if ((reviewerProvider === componentRecoveryProvider && reviewerModel === componentRecoveryModel)
        || reviewerFamily === recoveryFamilyActual) {
      countStatus("independent_reviewer_unavailable");
      trace.push({
        ...baseTrace,
        status: "independent_reviewer_unavailable",
        model: componentRecoveryModel,
        provider: componentRecoveryProvider,
        reviewerModel,
        reviewerProvider,
        recoveryDurationMs,
        reviewerDurationMs,
        criterion: activeCandidate.criterion,
        ...(activeCandidate.isRepaired ? {
          repairAttempted: true,
          repairModel: activeCandidate.repairModel,
          repairProvider: activeCandidate.repairProvider,
          repairDurationMs: activeCandidate.repairDurationMs,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        } : { rawModelProposedMeasurements: baseMeasurements })
      });
      regionOutcomes.push({
        regionId: componentId,
        state: "unresolved",
        reason: "independent_reviewer_unavailable",
        artifactPaths: artifacts,
        provider: componentRecoveryProvider,
        reviewerProvider,
        reviewerModel,
        ...(activeCandidate.isRepaired ? {
          repairAttempted: true,
          repairModel: activeCandidate.repairModel,
          repairProvider: activeCandidate.repairProvider,
          repairDurationMs: activeCandidate.repairDurationMs,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        } : { rawModelProposedMeasurements: baseMeasurements })
      });
      unclassifiedCount++;
      continue;
    }

    // Continuity review result for repaired candidates
    const continuityReviewResult = activeCandidate.isRepaired && reviewDecision === "rejected" ? "rejected" as const : undefined;

    if (reviewDecision === "rejected") {
      countStatus("recovery_rejected");
      trace.push({
        ...baseTrace,
        status: "recovery_rejected",
        model: componentRecoveryModel,
        provider: componentRecoveryProvider,
        reviewerModel,
        reviewerProvider,
        recoveryDurationMs,
        reviewerDurationMs,
        criterion: activeCandidate.criterion,
        ...(reviewReason !== undefined ? { rejectionReason: reviewReason } : {}),
        ...(continuityReviewResult !== undefined ? { continuityReviewResult } : {}),
        candidateTitle: activeCandidate.title,
        candidateEvidence: activeCandidate.evidence,
        candidateMeasurements: activeCandidate.measurements,
        ...(activeCandidate.isRepaired ? {
          repairAttempted: true,
          repairModel: activeCandidate.repairModel,
          repairProvider: activeCandidate.repairProvider,
          repairDurationMs: activeCandidate.repairDurationMs,
          originalCandidateSeverity: vlmResponse.severity ?? "medium",
          repairedCandidateSeverity: activeCandidate.severity,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          repairedCandidateRawMeasurements: repairedBaseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        } : { rawModelProposedMeasurements: baseMeasurements })
      });
      unclassifiedCount++;
      regionOutcomes.push({
        regionId: componentId,
        state: "unresolved",
        reason: `reviewer_rejected${reviewReason ? `: ${reviewReason.slice(0, 150)}` : ""}`,
        artifactPaths: artifacts,
        ...(reviewReason !== undefined ? { rejectionReason: reviewReason } : {}),
        ...(continuityReviewResult !== undefined ? { continuityReviewResult } : {}),
        criterion: activeCandidate.criterion,
        model: componentRecoveryModel,
        provider: componentRecoveryProvider,
        reviewerModel,
        reviewerProvider,
        recoveryDurationMs,
        reviewerDurationMs,
        candidateTitle: activeCandidate.title,
        candidateEvidence: activeCandidate.evidence,
        candidateMeasurements: activeCandidate.measurements,
        ...(activeCandidate.isRepaired ? {
          repairAttempted: true,
          repairModel: activeCandidate.repairModel,
          repairProvider: activeCandidate.repairProvider,
          repairDurationMs: activeCandidate.repairDurationMs,
          originalCandidateSeverity: vlmResponse.severity ?? "medium",
          repairedCandidateSeverity: activeCandidate.severity,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          repairedCandidateRawMeasurements: repairedBaseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        } : { rawModelProposedMeasurements: baseMeasurements })
      });
      continue;
    }

    const diffId = crypto.randomBytes(6).toString("hex");
    const record: DiffRecord = {
      id: diffId,
      criterion: activeCandidate.criterion,
      severity: activeCandidate.severity,
      title: activeCandidate.title,
      location: recoveredBox,
      evidence: activeCandidate.evidence,
      measurements: deterministicMeasurements,
      artifactPaths: artifacts,
      reviewerStatus: reviewDecision === "needs_escalation" ? "needs_escalation" : "accepted",
      model: componentRecoveryModel,
      classificationSource: "target_recovery",
      ...(reviewReason !== undefined ? { reviewerReason: reviewReason } : {})
    };

    if (reviewDecision === "accepted") {
      const validation = validateClaim(record);
      if (!validation.valid) {
        const reason = validation.reason ?? "Unsupported claim";
        countStatus("unsupported_recovery_claim");
        unclassifiedCount++;
        trace.push({
          ...baseTrace,
          status: "unsupported_recovery_claim",
          model: componentRecoveryModel,
          reviewerModel,
          recoveryDurationMs,
          reviewerDurationMs,
          criterion: activeCandidate.criterion,
          rejectionReason: reason,
          candidateTitle: activeCandidate.title,
          candidateEvidence: activeCandidate.evidence,
          candidateMeasurements: activeCandidate.measurements,
          ...(validation.diagnostics !== undefined ? { claimValidationDiagnostics: validation.diagnostics } : {}),
          ...(activeCandidate.isRepaired ? {
            repairAttempted: true,
            repairModel: activeCandidate.repairModel,
            repairDurationMs: activeCandidate.repairDurationMs,
            originalCandidateTitle: candidateTitle,
            originalCandidateEvidence: candidateEvidence,
            originalCandidateMeasurements: candidateMeasurements,
            ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
          } : {})
        });
        regionOutcomes.push({
          regionId: componentId,
          state: "unresolved",
          reason: `unsupported_recovery_claim: ${reason}`,
          rejectionReason: reason,
          artifactPaths: artifacts,
          criterion: activeCandidate.criterion,
          ...(validation.diagnostics !== undefined ? { diagnostics: validation.diagnostics } : {}),
          candidateTitle: activeCandidate.title,
          candidateEvidence: activeCandidate.evidence,
          candidateMeasurements: activeCandidate.measurements,
          model: componentRecoveryModel,
          reviewerModel,
          recoveryDurationMs,
          reviewerDurationMs,
          ...(activeCandidate.isRepaired ? {
            repairAttempted: true,
            repairModel: activeCandidate.repairModel,
            repairDurationMs: activeCandidate.repairDurationMs,
            originalCandidateTitle: candidateTitle,
            originalCandidateEvidence: candidateEvidence,
            ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
          } : {})
        });
        continue;
      }
    }

    if (reviewDecision === "needs_escalation") {
      // Escalation remains unresolved — only accepted+valid becomes final
      unclassifiedCount++;
      countStatus("recovery_needs_escalation");
      trace.push({
        ...baseTrace,
        status: "recovery_needs_escalation",
        model: componentRecoveryModel,
        provider: componentRecoveryProvider,
        reviewerModel,
        reviewerProvider,
        recoveryDurationMs,
        reviewerDurationMs,
        criterion: activeCandidate.criterion,
        candidateTitle: activeCandidate.title,
        candidateEvidence: activeCandidate.evidence,
        candidateMeasurements: activeCandidate.measurements,
        rawModelProposedMeasurements: baseMeasurements,
        ...(reviewReason !== undefined ? { rejectionReason: reviewReason } : {}),
        ...(activeCandidate.isRepaired ? {
          repairAttempted: true,
          repairModel: activeCandidate.repairModel,
          repairProvider: activeCandidate.repairProvider,
          repairDurationMs: activeCandidate.repairDurationMs,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          originalCandidateMeasurements: candidateMeasurements,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          repairedCandidateRawMeasurements: repairedBaseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        } : {})
      });
      regionOutcomes.push({
        regionId: componentId,
        state: "unresolved",
        reason: "needs_escalation",
        artifactPaths: artifacts,
        criterion: activeCandidate.criterion,
        model: componentRecoveryModel,
        provider: componentRecoveryProvider,
        reviewerModel,
        reviewerProvider,
        recoveryDurationMs,
        reviewerDurationMs,
        candidateTitle: activeCandidate.title,
        candidateEvidence: activeCandidate.evidence,
        candidateMeasurements: activeCandidate.measurements,
        rawModelProposedMeasurements: baseMeasurements,
        ...(reviewReason !== undefined ? { rejectionReason: reviewReason } : {}),
        ...(activeCandidate.isRepaired ? {
          repairAttempted: true,
          repairModel: activeCandidate.repairModel,
          repairProvider: activeCandidate.repairProvider,
          repairDurationMs: activeCandidate.repairDurationMs,
          originalCandidateTitle: candidateTitle,
          originalCandidateEvidence: candidateEvidence,
          rawModelProposedMeasurements: baseMeasurements,
          originalCandidateRawMeasurements: baseMeasurements,
          repairedCandidateRawMeasurements: repairedBaseMeasurements,
          ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {})
        } : {})
      });
      continue;
    }

    // Only reviewer-accepted + validateClaim-valid candidates become final
    recovered.push(record);
    const finalStatus = "recovery_accepted" as const;
    countStatus(finalStatus);
    trace.push({
      ...baseTrace,
      status: finalStatus,
      model: componentRecoveryModel,
      provider: componentRecoveryProvider,
      reviewerModel,
      reviewerProvider,
      recoveryDurationMs,
      reviewerDurationMs,
      criterion: activeCandidate.criterion,
      diffId: record.id,
      rawModelProposedMeasurements: activeCandidate.isRepaired ? repairedBaseMeasurements : baseMeasurements,
      ...(activeCandidate.isRepaired ? {
        repairAttempted: true,
        repairModel: activeCandidate.repairModel,
        repairProvider: activeCandidate.repairProvider,
        repairDurationMs: activeCandidate.repairDurationMs,
        originalCandidateSeverity: vlmResponse.severity ?? "medium",
        repairedCandidateSeverity: activeCandidate.severity,
        originalCandidateTitle: candidateTitle,
        originalCandidateEvidence: candidateEvidence,
        originalCandidateMeasurements: candidateMeasurements,
        originalCandidateRawMeasurements: baseMeasurements,
        repairedCandidateRawMeasurements: repairedBaseMeasurements,
        ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}),
        repairedCandidateTitle: activeCandidate.title,
        repairedCandidateEvidence: activeCandidate.evidence,
        repairedCandidateMeasurements: activeCandidate.measurements
      } : {})
    });
    regionOutcomes.push({
      regionId: componentId,
      state: "recovered",
      reason: "recovery_accepted",
      artifactPaths: artifacts,
      findingId: record.id,
      criterion: activeCandidate.criterion,
      model: componentRecoveryModel,
      provider: componentRecoveryProvider,
      reviewerModel,
      reviewerProvider,
      recoveryDurationMs,
      reviewerDurationMs,
      candidateTitle: activeCandidate.title,
      candidateEvidence: activeCandidate.evidence,
      candidateMeasurements: activeCandidate.measurements,
      rawModelProposedMeasurements: activeCandidate.isRepaired ? repairedBaseMeasurements : baseMeasurements,
      ...(activeCandidate.isRepaired ? {
        repairAttempted: true,
        repairModel: activeCandidate.repairModel,
        repairProvider: activeCandidate.repairProvider,
        repairDurationMs: activeCandidate.repairDurationMs,
        originalCandidateSeverity: vlmResponse.severity ?? "medium",
        repairedCandidateSeverity: activeCandidate.severity,
        originalCandidateTitle: candidateTitle,
        originalCandidateEvidence: candidateEvidence,
        originalCandidateMeasurements: candidateMeasurements,
        originalCandidateRawMeasurements: baseMeasurements,
        repairedCandidateRawMeasurements: repairedBaseMeasurements,
        ...(initialValidation.diagnostics !== undefined ? { originalCandidateDiagnostics: initialValidation.diagnostics } : {}),
        repairedCandidateTitle: activeCandidate.title,
        repairedCandidateEvidence: activeCandidate.evidence,
        repairedCandidateMeasurements: activeCandidate.measurements
      } : {})
    });
    void evidence; // evidence artifact metadata is captured in record.artifactPaths
  }

  // Push skipped traces for entries that weren't reached due to deadline/model_call_cap
  if (stoppedReason === "deadline_exceeded" || stoppedReason === "model_call_cap") {
    const skippedStatus = stoppedReason === "deadline_exceeded" ? "skipped_deadline" as const : "skipped_model_call_cap" as const;
    for (let i = loopStoppedAt; i < toProcess.length; i++) {
      const entry = toProcess[i]!;
      const preparedEvidence = preparedById.get(entry.componentId);
      const artifacts = preparedEvidence?.artifacts ?? [];
      countStatus(skippedStatus);
      trace.push({
        componentId: entry.componentId,
        rank: i,
        componentBox: entry.component.box,
        ...(preparedEvidence?.status === "valid" ? {
          evidenceBox: preparedEvidence.evidenceBox,
          actualEvidenceBox: preparedEvidence.actualEvidenceBox
        } : {}),
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
