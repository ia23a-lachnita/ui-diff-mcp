import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { UiCriterionSchema } from "../schemas/core.js";
import type { ElementPair, UiElement, DiffRecord, DeterministicMeasurement, UiArtifact, Box, AuditCriterionTrace, UiCriterion } from "../schemas/core.js";
import { rubrics, selectTriggeredCriteria, AuditResultSchema, type TriggerContext } from "./criteria.js";
import { buildAuditorPrompt, buildReviewerPrompt } from "./prompts.js";
import type { VisionJsonCaller } from "../models/vision-json.js";
import { computePixelDiff } from "../signals/pixel-diff.js";
import { createDirectionalDiffOverlay, type Rgba } from "../images/directional-diff.js";
import { extractImageCropFromBounds } from "../images/crop.js";
import { prepareAspectPreservingComparison } from "../images/aspect-preserving-comparison.js";
import { resolveComparisonExtraction, type ComparisonExtractionBounds } from "../images/comparison-geometry.js";
import type { ImagePairTransform } from "../images/coordinates.js";
import { hasUnsupportedQuantitativeClaim } from "./review-findings.js";
import { RouteExhaustedError } from "../models/fallback-caller.js";

const ReviewDecisionSchema = z.object({
  decision: z.enum(["accepted", "rejected", "needs_escalation"]),
  reason: z.string()
});

export interface AuditContext {
  expectedImagePath: string;
  actualImagePath: string;
  expectedElements: UiElement[];
  actualElements: UiElement[];
  artifactDir: string;
  auditorCaller: VisionJsonCaller;
  reviewerCaller: VisionJsonCaller;
  expectedRgba: { data: Uint8Array; width: number; height: number };
  actualRgba: { data: Uint8Array; width: number; height: number };
  imagePairTransform?: ImagePairTransform;
  measurements: DeterministicMeasurement[];
  triggerCtx: TriggerContext;
  auditIndex: number;
  auditTotal: number;
  elementSlug: string;
}

export function makeElementSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20);
}

async function writeCropArtifact(
  imageData: Uint8Array,
  width: number,
  height: number,
  outPath: string,
  channels: 1 | 4 = 4
): Promise<string> {
  if (width < 2 || height < 2) throw new Error("below_minimum_artifact_size");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await sharp(Buffer.from(imageData.buffer, imageData.byteOffset, imageData.byteLength), { raw: { width, height, channels } })
    .png()
    .toFile(outPath);
  return outPath;
}

function expandBox(box: Box, paddingFactor: number): Box {
  const padW = box.width * paddingFactor;
  const padH = box.height * paddingFactor;
  return { x: box.x - padW, y: box.y - padH, width: box.width + padW * 2, height: box.height + padH * 2 };
}

async function extractCropAndEncode(
  imageData: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  bounds: ComparisonExtractionBounds,
  artifactRole: UiArtifact["role"],
  outPath: string,
  pairId?: string
): Promise<{ base64: string; artifact: UiArtifact }> {
  const croppedData = extractImageCropFromBounds(imageData, imageWidth, bounds);

  const buf = await sharp(Buffer.from(croppedData.buffer, croppedData.byteOffset, croppedData.byteLength), { raw: { width: bounds.width, height: bounds.height, channels: 4 } })
    .png()
    .toBuffer();

  const savedPath = await writeCropArtifact(croppedData, bounds.width, bounds.height, outPath);

  return {
    base64: buf.toString("base64"),
    artifact: { role: artifactRole, path: savedPath, pairId }
  };
}

function diffId(): string {
  return crypto.randomBytes(6).toString("hex");
}

export async function auditElementPair(
  pair: ElementPair,
  ctx: AuditContext
): Promise<{ accepted: DiffRecord[]; rejected: DiffRecord[]; trace: AuditCriterionTrace[] }> {
  const accepted: DiffRecord[] = [];
  const rejected: DiffRecord[] = [];
  const trace: AuditCriterionTrace[] = [];

  const expectedEl = ctx.expectedElements.find(e => e.id === pair.expectedId);
  const actualEl = ctx.actualElements.find(e => e.id === pair.actualId);

  const refEl = expectedEl ?? actualEl;
  if (!refEl) return { accepted, rejected, trace };

  if (pair.status === "matched" && !ctx.triggerCtx.comparisonComparable) {
    trace.push({
      pairId: pair.id,
      ...(pair.expectedId !== undefined ? { expectedId: pair.expectedId } : {}),
      ...(pair.actualId !== undefined ? { actualId: pair.actualId } : {}),
      targetLabel: refEl.label,
      targetType: refEl.type,
      criterion: "geometry",
      status: "comparison_non_comparable",
      evidenceCount: 0,
      skipReason: "no_comparable_intersection",
      rejectionReason: "no_comparable_intersection",
      imageRoles: [],
      artifactPaths: []
    });
    return { accepted, rejected, trace };
  }

  const pairId = pair.id;
  const idxStr = String(ctx.auditIndex).padStart(3, "0");
  const totalStr = String(ctx.auditTotal).padStart(3, "0");
  const shortId = pairId.slice(0, 12);
  const baseFileName = (role: string) =>
    path.join(ctx.artifactDir, `audit-${idxStr}-of-${totalStr}-pair-${shortId}-${ctx.elementSlug}-${role}.png`);

  const criteria = selectTriggeredCriteria(ctx.triggerCtx);
  const expectedCrop = expectedEl ? resolveComparisonExtraction({
    box: expectedEl.box,
    sourceSpace: "expected_normalized",
    canvas: { width: ctx.expectedRgba.width, height: ctx.expectedRgba.height }
  }) : undefined;
  const actualComparisonCrop = actualEl ? resolveComparisonExtraction({
    box: actualEl.box,
    sourceSpace: ctx.imagePairTransform ? "actual_normalized" : "comparison_expected_normalized",
    canvas: { width: ctx.expectedRgba.width, height: ctx.expectedRgba.height },
    ...(ctx.imagePairTransform ? { transform: ctx.imagePairTransform } : {})
  }) : undefined;
  const actualSourceCrop = actualEl ? resolveComparisonExtraction({
    box: actualEl.box,
    sourceSpace: "comparison_expected_normalized",
    canvas: { width: ctx.actualRgba.width, height: ctx.actualRgba.height }
  }) : undefined;
  const refComparisonBox = expectedCrop?.status === "valid" ? expectedCrop.box
    : actualComparisonCrop?.status === "valid" ? actualComparisonCrop.box : undefined;
  const contextCrop = refComparisonBox ? resolveComparisonExtraction({
    box: expandBox(refComparisonBox, 0.5),
    sourceSpace: "comparison_expected_normalized",
    canvas: { width: ctx.expectedRgba.width, height: ctx.expectedRgba.height }
  }) : undefined;
  const rejection = [expectedCrop, actualComparisonCrop, actualSourceCrop, contextCrop]
    .find((resolution): resolution is Extract<typeof resolution, { status: "rejected" }> => resolution?.status === "rejected");
  if (rejection || !refComparisonBox) {
    const reason = rejection?.reason ?? "below_minimum_artifact_size";
    for (const criterion of (criteria.length > 0 ? criteria : ["geometry"]) as Exclude<UiCriterion, "unclassified_visual_change">[]) {
      trace.push({
        pairId: pair.id,
        ...(pair.expectedId !== undefined ? { expectedId: pair.expectedId } : {}),
        ...(pair.actualId !== undefined ? { actualId: pair.actualId } : {}),
        targetLabel: refEl.label,
        targetType: refEl.type,
        criterion,
        status: "reviewer_rejected",
        evidenceCount: 0,
        rejectionReason: `evidence_crop_rejected: ${reason}`,
        imageRoles: [],
        artifactPaths: []
      });
    }
    return { accepted, rejected, trace };
  }
  const expectedBounds = expectedCrop?.status === "valid" ? expectedCrop.bounds : undefined;
  const actualSourceBounds = actualSourceCrop?.status === "valid" ? actualSourceCrop.bounds : undefined;
  const contextBounds = contextCrop?.status === "valid" ? contextCrop.bounds : undefined;

  const auditArtifacts: UiArtifact[] = [];
  const images: string[] = []; // Base64 encoded images for VLM call

  let expectedCropB64: string | null = null;
  let actualCropB64: string | null = null;

  // Extract Expected Crop
  if (expectedEl) {
    const { base64, artifact } = await extractCropAndEncode(
       ctx.expectedRgba.data, ctx.expectedRgba.width, ctx.expectedRgba.height, expectedBounds!,
      "expected_crop", baseFileName("expected-crop"), pairId
    );
    expectedCropB64 = base64;
    auditArtifacts.push(artifact);
  }
  // Extract Actual Crop
  if (actualEl) {
    const { base64, artifact } = await extractCropAndEncode(
       ctx.actualRgba.data, ctx.actualRgba.width, ctx.actualRgba.height, actualSourceBounds!,
      "actual_crop", baseFileName("actual-crop"), pairId
    );
    actualCropB64 = base64;
    auditArtifacts.push(artifact);
  }

  const localPixelDiffMaskPath = baseFileName("local-pixel-diff-mask");
  const localDirectionalOverlayPath = baseFileName("local-directional-overlay");
  let localDirectionalOverlayB64 = "";
  let localPixelDiffMaskB64 = "";

  if (expectedEl && actualEl && expectedCropB64 && actualCropB64) {
    // Write a single resized comparison crop so the pixel mask and the directional overlay
    // both describe the same comparison. computePixelDiff's internal zero-padding and
    // Sharp's Lanczos resize differ; using one file for both operations eliminates the mismatch.
    const expCropMeta = await sharp(Buffer.from(expectedCropB64, "base64")).metadata();
    if (!expCropMeta.width || !expCropMeta.height) throw new Error("Expected crop metadata is missing dimensions");
    const cmpW = expCropMeta.width;
    const cmpH = expCropMeta.height;
    const actualComparisonCropPath = baseFileName("actual-crop-comparison");
    const comparison = await prepareAspectPreservingComparison({
      sourcePath: baseFileName("actual-crop"),
      outputPath: actualComparisonCropPath,
      targetSize: { width: cmpW, height: cmpH }
    });

    const localPixelDiff = computePixelDiff(
      baseFileName("expected-crop"),
      actualComparisonCropPath,
      comparison.transform.rasterValidRect
    );
    await writeCropArtifact(localPixelDiff.diffMask, localPixelDiff.width, localPixelDiff.height, localPixelDiffMaskPath, 1);
    localPixelDiffMaskB64 = (await sharp(Buffer.from(localPixelDiff.diffMask.buffer, localPixelDiff.diffMask.byteOffset, localPixelDiff.diffMask.byteLength), { raw: { width: localPixelDiff.width, height: localPixelDiff.height, channels: 1 } }).png().toBuffer()).toString("base64");
    auditArtifacts.push({ role: "local_pixel_diff_mask", path: localPixelDiffMaskPath, pairId });

    const expRaw = await sharp(Buffer.from(expectedCropB64, "base64")).ensureAlpha().raw().toBuffer();
    const actRaw = await sharp(actualComparisonCropPath).ensureAlpha().raw().toBuffer();
    await createDirectionalDiffOverlay(
      { data: expRaw, width: localPixelDiff.width, height: localPixelDiff.height },
      { data: actRaw, width: localPixelDiff.width, height: localPixelDiff.height },
      localPixelDiff.diffMask,
      localPixelDiff.width,
      localPixelDiff.height,
      localDirectionalOverlayPath,
      comparison.transform.rasterValidRect
    );
    localDirectionalOverlayB64 = (await fs.readFile(localDirectionalOverlayPath)).toString("base64");
    auditArtifacts.push({ role: "local_directional_overlay", path: localDirectionalOverlayPath, pairId });
  }


  // Extract context crop: 50% padding around the reference element box
  let contextCropB64: string | null = null;
  if (refEl) {
    const { base64, artifact } = await extractCropAndEncode(
      ctx.expectedRgba.data, ctx.expectedRgba.width, ctx.expectedRgba.height, contextBounds!,
      "context_crop", baseFileName("context-crop"), pairId
    );
    contextCropB64 = base64;
    auditArtifacts.push(artifact);
  }

  // Evidence image order: expected crop, actual crop, local directional overlay, local pixel-diff mask, context crop
  if (expectedCropB64) images.push(`data:image/png;base64,${expectedCropB64}`);
  if (actualCropB64) images.push(`data:image/png;base64,${actualCropB64}`);
  if (localDirectionalOverlayB64) images.push(`data:image/png;base64,${localDirectionalOverlayB64}`);
  if (localPixelDiffMaskB64) images.push(`data:image/png;base64,${localPixelDiffMaskB64}`);
  if (contextCropB64) images.push(`data:image/png;base64,${contextCropB64}`);

  const imageRoles = [
    expectedCropB64 ? "expected_crop" : null,
    actualCropB64 ? "actual_crop" : null,
    localDirectionalOverlayB64 ? "local_directional_overlay" : null,
    localPixelDiffMaskB64 ? "local_pixel_diff_mask" : null,
    contextCropB64 ? "context_crop" : null
  ].filter((v): v is string => v !== null);

  function pushTrace(
    criterion: Exclude<UiCriterion, "unclassified_visual_change">,
    status: AuditCriterionTrace["status"],
    extra: Partial<AuditCriterionTrace> = {}
  ): void {
    trace.push({
      pairId: pair.id,
      ...(pair.expectedId !== undefined ? { expectedId: pair.expectedId } : {}),
      ...(pair.actualId !== undefined ? { actualId: pair.actualId } : {}),
      targetLabel: refEl!.label,
      targetType: refEl!.type,
      criterion,
      status,
      evidenceCount: 0,
      imageRoles,
      artifactPaths: auditArtifacts,
      ...extra
    });
  }

  const triggeredCriteria = new Set(criteria);
  const allClassifiableCriteria = UiCriterionSchema.options.filter(
    (c): c is Exclude<UiCriterion, "unclassified_visual_change"> => c !== "unclassified_visual_change"
  );
  for (const criterion of allClassifiableCriteria) {
    if (!triggeredCriteria.has(criterion)) {
      pushTrace(criterion, "criterion_not_triggered", {
        skipReason: "criterion not selected by deterministic trigger signals"
      });
    }
  }

  for (const criterion of criteria as Exclude<UiCriterion, "unclassified_visual_change">[]) {
    const rubric = rubrics[criterion];

    const auditorPrompt = buildAuditorPrompt({
      criterion,
      rubric,
      elementLabel: refEl.label,
      elementType: refEl.type,
      pairingStatus: pair.status,
      measurements: ctx.measurements
    });

    let auditResult: z.infer<typeof AuditResultSchema>;
    let auditModel = "unknown";
    const started = Date.now();
    try {
      const response = await ctx.auditorCaller({
        prompt: auditorPrompt,
        images,
        jsonSchema: { name: `audit_${criterion}`, schema: rubric.jsonSchema },
        timeoutMs: 60000,
        maxOutputTokens: 8192
      });
      auditModel = response.model;
      auditResult = AuditResultSchema.parse(response.parsed);
    } catch (err) {
      if (err instanceof RouteExhaustedError && err.permanent) throw err;
      pushTrace(criterion, err instanceof z.ZodError ? "auditor_schema_error" : "auditor_error", {
        auditorDurationMs: Date.now() - started,
        model: auditModel,
        errorKind: err instanceof z.ZodError ? "schema" : "provider",
        errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)
      });
      console.error(`Auditor call failed for criterion ${criterion}:`, err);
      continue;
    }

    if (!auditResult.hasDiff) {
      pushTrace(criterion, "auditor_no_diff", {
        auditorDurationMs: Date.now() - started,
        model: auditModel,
        evidenceCount: auditResult.evidence?.length ?? 0
      });
      continue;
    }

    const evidence = auditResult.evidence ?? [];
    if (evidence.length === 0) {
      pushTrace(criterion, "empty_evidence", {
        auditorDurationMs: Date.now() - started,
        model: auditModel
      });
      continue;
    }

    const auditorDurationMs = Date.now() - started;

    const visibleTexts = [expectedEl?.text, actualEl?.text].filter((text): text is string => text !== undefined);
    if (hasUnsupportedQuantitativeClaim(
      { title: auditResult.title ?? criterion, evidence },
      ctx.measurements,
      visibleTexts
    )) {
      pushTrace(criterion, "reviewer_rejected", {
        auditorDurationMs,
        model: auditModel,
        evidenceCount: evidence.length,
        rejectionReason: "Unsupported quantitative layout claim"
      });
      continue;
    }

    const reviewerPrompt = buildReviewerPrompt(
      criterion,
      refEl.label,
      auditResult.title ?? criterion,
      evidence,
      ctx.measurements
    );

    let reviewDecision: "accepted" | "rejected" | "needs_escalation" = "accepted";
    const reviewerStarted = Date.now();
    let reviewModel = "unknown";
    let reviewReason: string | undefined;
    let reviewerTraceStatus: AuditCriterionTrace["status"] = "reviewer_needs_escalation";
    let reviewerErrorMsg: string | undefined;
    try {
      const reviewResponse = await ctx.reviewerCaller({
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
      const parsed = ReviewDecisionSchema.parse(reviewResponse.parsed);
      reviewDecision = parsed.decision;
      reviewModel = reviewResponse.model;
      reviewReason = parsed.reason;
      reviewerTraceStatus = reviewDecision === "accepted" ? "reviewer_accepted"
        : reviewDecision === "rejected" ? "reviewer_rejected"
        : "reviewer_needs_escalation";
    } catch (err) {
      console.error(`Reviewer call failed for criterion ${criterion}:`, err);
      reviewDecision = "needs_escalation";
      reviewerTraceStatus = "reviewer_error";
      reviewerErrorMsg = err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500);
    }
    const reviewerDurationMs = Date.now() - reviewerStarted;

    const record: DiffRecord = {
      id: diffId(),
      pairId: pair.id,
      criterion,
      severity: auditResult.severity ?? "medium",
      title: auditResult.title ?? `${criterion} difference in ${refEl.label}`,
      location: refComparisonBox,
      evidence,
      measurements: ctx.measurements,
      artifactPaths: auditArtifacts,
      reviewerStatus: reviewDecision === "needs_escalation" ? "needs_escalation" : reviewDecision,
      model: auditModel,
      classificationSource: "vlm_reviewed",
      ...(reviewReason !== undefined ? { reviewerReason: reviewReason } : {})
    };

    if (reviewDecision === "rejected") {
      rejected.push(record);
    } else {
      accepted.push(record);
    }

    pushTrace(criterion, reviewerTraceStatus, {
      model: auditModel,
      reviewerModel: reviewModel,
      auditorDurationMs,
      reviewerDurationMs,
      evidenceCount: evidence.length,
      diffId: record.id,
      ...(reviewReason !== undefined ? { rejectionReason: reviewReason } : {}),
      ...(reviewerErrorMsg !== undefined ? { errorKind: "provider" as const, errorMessage: reviewerErrorMsg } : {})
    });
  }

  return { accepted, rejected, trace };
}
