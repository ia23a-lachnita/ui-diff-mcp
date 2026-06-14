import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import type { ElementPair, UiElement, DiffRecord, DeterministicMeasurement } from "../schemas/core.js";
import { rubrics, selectTriggeredCriteria, AuditResultSchema, type TriggerContext } from "./criteria.js";
import { buildAuditorPrompt, buildReviewerPrompt } from "./prompts.js";
import type { VisionJsonCaller } from "../models/vision-json.js";

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
  imageWidth: number;
  imageHeight: number;
  measurements: DeterministicMeasurement[];
  triggerCtx: TriggerContext;
}

async function extractCrop(
  imagePath: string,
  box: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
  savePath?: string
): Promise<{ base64: string; savedPath: string | undefined }> {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(Math.round(box.width), imageWidth - x);
  const h = Math.min(Math.round(box.height), imageHeight - y);

  let buf: Buffer;
  if (w <= 0 || h <= 0) {
    buf = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 128, g: 128, b: 128 } }
    }).png().toBuffer();
  } else {
    buf = await sharp(imagePath)
      .extract({ left: x, top: y, width: w, height: h })
      .png()
      .toBuffer();
  }

  let savedPath: string | undefined;
  if (savePath) {
    await fs.mkdir(path.dirname(savePath), { recursive: true });
    await fs.writeFile(savePath, buf);
    savedPath = savePath;
  }

  return { base64: buf.toString("base64"), savedPath };
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

  const pairSlug = pair.id.slice(0, 12);
  let expectedCropB64: string | null = null;
  let actualCropB64: string | null = null;
  const cropArtifacts: string[] = [];

  if (expectedEl) {
    const result = await extractCrop(
      ctx.expectedImagePath, expectedEl.box, ctx.imageWidth, ctx.imageHeight,
      path.join(ctx.artifactDir, `${pairSlug}-expected-crop.png`)
    );
    expectedCropB64 = result.base64;
    if (result.savedPath) cropArtifacts.push(result.savedPath);
  }
  if (actualEl) {
    const result = await extractCrop(
      ctx.actualImagePath, actualEl.box, ctx.imageWidth, ctx.imageHeight,
      path.join(ctx.artifactDir, `${pairSlug}-actual-crop.png`)
    );
    actualCropB64 = result.base64;
    if (result.savedPath) cropArtifacts.push(result.savedPath);
  }

  const images: string[] = [];
  if (expectedCropB64) images.push(`data:image/png;base64,${expectedCropB64}`);
  if (actualCropB64) images.push(`data:image/png;base64,${actualCropB64}`);

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
    } catch {
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
    } catch {
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
      artifactPaths: cropArtifacts,
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
