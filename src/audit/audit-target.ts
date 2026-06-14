import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { ElementPair, UiElement, DiffRecord, DeterministicMeasurement, UiArtifact, Box } from "../schemas/core.js";
import { rubrics, selectTriggeredCriteria, AuditResultSchema, type TriggerContext } from "./criteria.js";
import { buildAuditorPrompt, buildReviewerPrompt } from "./prompts.js";
import type { VisionJsonCaller } from "../models/vision-json.js";
import { computePixelDiff } from "../signals/pixel-diff.js";
import { createDirectionalDiffOverlay, type Rgba } from "../images/directional-diff.js";

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
  measurements: DeterministicMeasurement[];
  triggerCtx: TriggerContext;
}

function extractImageCrop(
  imageData: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  box: Box
): Uint8Array {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(Math.round(box.width), imageWidth - x);
  const h = Math.min(Math.round(box.height), imageHeight - y);

  if (w <= 0 || h <= 0) {
    return new Uint8Array(4);
  }

  const croppedData = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const srcIdx = ((y + row) * imageWidth + (x + col)) * 4;
      const destIdx = (row * w + col) * 4;
      croppedData[destIdx] = imageData[srcIdx] ?? 0;
      croppedData[destIdx + 1] = imageData[srcIdx + 1] ?? 0;
      croppedData[destIdx + 2] = imageData[srcIdx + 2] ?? 0;
      croppedData[destIdx + 3] = imageData[srcIdx + 3] ?? 0;
    }
  }
  return croppedData;
}

async function writeCropArtifact(
  imageData: Uint8Array,
  width: number,
  height: number,
  outPath: string,
  channels: 1 | 4 = 4
): Promise<string> {
  if (width <= 0 || height <= 0) {
    await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    }).png().toFile(outPath);
  } else {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await sharp(Buffer.from(imageData.buffer, imageData.byteOffset, imageData.byteLength), { raw: { width, height, channels } })
      .png()
      .toFile(outPath);
  }
  return outPath;
}

function expandBox(box: Box, paddingFactor: number, imageWidth: number, imageHeight: number): Box {
  const padW = box.width * paddingFactor;
  const padH = box.height * paddingFactor;
  const x = Math.max(0, box.x - padW);
  const y = Math.max(0, box.y - padH);
  const x2 = Math.min(imageWidth, box.x + box.width + padW);
  const y2 = Math.min(imageHeight, box.y + box.height + padH);
  return { x, y, width: x2 - x, height: y2 - y };
}

async function extractCropAndEncode(
  imageData: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  box: Box,
  artifactRole: UiArtifact["role"],
  outPath: string,
  pairId?: string
): Promise<{ base64: string; artifact: UiArtifact }> {
  const croppedData = extractImageCrop(imageData, imageWidth, imageHeight, box);
  const cropWidth = Math.min(Math.round(box.width), imageWidth - Math.max(0, Math.round(box.x)));
  const cropHeight = Math.min(Math.round(box.height), imageHeight - Math.max(0, Math.round(box.y)));

  const buf = await sharp(Buffer.from(croppedData.buffer, croppedData.byteOffset, croppedData.byteLength), { raw: { width: cropWidth > 0 ? cropWidth : 1, height: cropHeight > 0 ? cropHeight : 1, channels: 4 } })
    .png()
    .toBuffer();

  const savedPath = await writeCropArtifact(croppedData, cropWidth, cropHeight, outPath);

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
): Promise<{ accepted: DiffRecord[]; rejected: DiffRecord[] }> {
  const accepted: DiffRecord[] = [];
  const rejected: DiffRecord[] = [];

  const expectedEl = ctx.expectedElements.find(e => e.id === pair.expectedId);
  const actualEl = ctx.actualElements.find(e => e.id === pair.actualId);

  const refEl = expectedEl ?? actualEl;
  if (!refEl) return { accepted, rejected };

  const criteria = selectTriggeredCriteria(ctx.triggerCtx);

  const auditArtifacts: UiArtifact[] = [];
  const images: string[] = []; // Base64 encoded images for VLM call

  let expectedCropB64: string | null = null;
  let actualCropB64: string | null = null;

  const pairId = pair.id; // Use pair.id for artifact naming and linking

  const baseFileName = (role: string) =>
    path.join(ctx.artifactDir, `audit-${pairId}-${role}.png`);

  // Extract Expected Crop
  if (expectedEl) {
    const { base64, artifact } = await extractCropAndEncode(
      ctx.expectedRgba.data, ctx.expectedRgba.width, ctx.expectedRgba.height, expectedEl.box,
      "expected_crop", baseFileName("expected-crop"), pairId
    );
    expectedCropB64 = base64;
    auditArtifacts.push(artifact);
  }
  // Extract Actual Crop
  if (actualEl) {
    const { base64, artifact } = await extractCropAndEncode(
      ctx.actualRgba.data, ctx.actualRgba.width, ctx.actualRgba.height, actualEl.box,
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
    const localPixelDiff = computePixelDiff(
      baseFileName("expected-crop"),
      baseFileName("actual-crop")
    );
    await writeCropArtifact(localPixelDiff.diffMask, localPixelDiff.width, localPixelDiff.height, localPixelDiffMaskPath, 1);
    localPixelDiffMaskB64 = (await sharp(Buffer.from(localPixelDiff.diffMask.buffer, localPixelDiff.diffMask.byteOffset, localPixelDiff.diffMask.byteLength), { raw: { width: localPixelDiff.width, height: localPixelDiff.height, channels: 1 } }).png().toBuffer()).toString("base64");
    auditArtifacts.push({ role: "local_pixel_diff_mask", path: localPixelDiffMaskPath, pairId });

    const expRaw = await sharp(Buffer.from(expectedCropB64, "base64")).ensureAlpha().raw().toBuffer();
    const actRaw = await sharp(Buffer.from(actualCropB64, "base64")).ensureAlpha().raw().toBuffer();
    await createDirectionalDiffOverlay(
      { data: expRaw, width: localPixelDiff.width, height: localPixelDiff.height },
      { data: actRaw, width: localPixelDiff.width, height: localPixelDiff.height },
      localPixelDiff.diffMask,
      localPixelDiff.width,
      localPixelDiff.height,
      localDirectionalOverlayPath
    );
    localDirectionalOverlayB64 = (await fs.readFile(localDirectionalOverlayPath)).toString("base64");
    auditArtifacts.push({ role: "local_directional_overlay", path: localDirectionalOverlayPath, pairId });
  }


  // Extract context crop: 50% padding around the reference element box
  let contextCropB64: string | null = null;
  if (refEl) {
    const contextBox = expandBox(refEl.box, 0.5, ctx.expectedRgba.width, ctx.expectedRgba.height);
    const { base64, artifact } = await extractCropAndEncode(
      ctx.expectedRgba.data, ctx.expectedRgba.width, ctx.expectedRgba.height, contextBox,
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

  for (const criterion of criteria) {
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
    try {
      const response = await ctx.auditorCaller({
        prompt: auditorPrompt,
        images,
        jsonSchema: { name: `audit_${criterion}`, schema: rubric.jsonSchema },
        timeoutMs: 60000
      });
      auditModel = response.model;
      auditResult = AuditResultSchema.parse(response.parsed);
    } catch (err) {
      console.error(`Auditor call failed for criterion ${criterion}:`, err);
      continue;
    }

    if (!auditResult.hasDiff) continue;

    const evidence = auditResult.evidence ?? [];
    if (evidence.length === 0) continue;

    const reviewerPrompt = buildReviewerPrompt(
      criterion,
      refEl.label,
      auditResult.title ?? criterion,
      evidence
    );

    let reviewDecision: "accepted" | "rejected" | "needs_escalation" = "accepted";
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
    } catch (err) {
      console.error(`Reviewer call failed for criterion ${criterion}:`, err);
      reviewDecision = "accepted";
    }

    const record: DiffRecord = {
      id: diffId(),
      pairId: pair.id,
      criterion,
      severity: auditResult.severity ?? "medium",
      title: auditResult.title ?? `${criterion} difference in ${refEl.label}`,
      location: refEl.box,
      evidence,
      measurements: auditResult.measurements ?? [],
      artifactPaths: auditArtifacts, // Use the collected UiArtifacts
      reviewerStatus: reviewDecision === "needs_escalation" ? "needs_escalation" : reviewDecision,
      model: auditModel
    };

    if (reviewDecision === "rejected") {
      rejected.push(record);
    } else {
      accepted.push(record);
    }
  }

  return { accepted, rejected };
}
