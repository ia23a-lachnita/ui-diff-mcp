import crypto from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";
import type { DiffRecord, DiffScope, ScopeDiffSummary, UiArtifact, UiCriterion } from "../schemas/core.js";
import type { VisionJsonCaller } from "../models/vision-json.js";
import { AuditResultSchema, rubrics } from "./criteria.js";

const ReviewDecisionSchema = z.object({
  decision: z.enum(["accepted", "rejected", "needs_escalation"]),
  reason: z.string()
});

export interface AuditScopeSummariesInput {
  summaries: ScopeDiffSummary[];
  diffScope: DiffScope;
  expectedImagePath: string;
  actualImagePath: string;
  directionalOverlayPath: string;
  pixelDiffMaskPath: string;
  auditorCaller: VisionJsonCaller;
  reviewerCaller: VisionJsonCaller;
}

function selectedSummaries(scope: DiffScope, summaries: ScopeDiffSummary[]): ScopeDiffSummary[] {
  if (scope.kind === "screen") return summaries.filter(summary => summary.id === "screen");
  if (scope.kind === "regions") {
    const selected = new Set(scope.regions ?? ["top", "middle", "bottom", "nav"]);
    return summaries.filter(summary => summary.kind === "region" && selected.has(summary.id));
  }
  if (scope.kind === "target") return [];
  return summaries;
}

async function readDataUrl(path: string): Promise<string> {
  return `data:image/png;base64,${(await fs.readFile(path)).toString("base64")}`;
}

function buildScopeAuditorPrompt(summary: ScopeDiffSummary, criterion: Exclude<UiCriterion, "unclassified_visual_change">): string {
  const rubric = rubrics[criterion];
  const measurements = summary.measurements.length > 0
    ? summary.measurements.map(m => `  - ${m.name}: ${m.value}${m.unit ? " " + m.unit : ""}`).join("\n")
    : "  (none)";
  return [
    `You are checking a ${summary.kind} level UI difference, not an individual target.`,
    `SCOPE: ${summary.label} (${summary.id})`,
    `CRITERION: ${criterion}`,
    `CRITERION DESCRIPTION: ${rubric.description}`,
    ``,
    `DETERMINISTIC MEASUREMENTS:`,
    measurements,
    ``,
    `EVIDENCE IMAGES (in order):`,
    `  1. Full expected/mockup screen`,
    `  2. Full actual screenshot in comparison space`,
    `  3. Directional diff overlay`,
    `  4. Pixel-diff mask`,
    ``,
    `STRICT RULES:`,
    `- Report only visible differences in this scope and criterion.`,
    `- Do not suggest causes, code changes, or design fixes.`,
    `- Do not make exact pixel, spacing, font-size, percentage, or angle claims unless citing a listed deterministic measurement.`,
    `- Prefer broad layout/color/shape observations over tiny child-target details.`,
    ``,
    `OUTPUT: { "hasDiff": false } or { "hasDiff": true, "severity": "medium", "title": "short title", "evidence": ["visible qualitative observation"] }`,
    `Respond with JSON only.`
  ].join("\n");
}

function buildScopeReviewerPrompt(
  summary: ScopeDiffSummary,
  criterion: Exclude<UiCriterion, "unclassified_visual_change">,
  title: string,
  evidence: string[]
): string {
  return [
    `Review this ${summary.kind} UI diff claim using only the supplied images and deterministic measurements.`,
    `SCOPE: ${summary.label} (${summary.id})`,
    `CRITERION: ${criterion}`,
    `TITLE: ${title}`,
    `EVIDENCE:`,
    ...evidence.map(item => `  - ${item}`),
    ``,
    `Accept only visually supported claims. Reject vague, unsupported, or over-precise claims.`,
    `Return JSON only: { "decision": "accepted" | "rejected" | "needs_escalation", "reason": "<one sentence>" }`
  ].join("\n");
}

export async function auditScopeSummaries(input: AuditScopeSummariesInput): Promise<{ accepted: DiffRecord[]; rejected: DiffRecord[] }> {
  const accepted: DiffRecord[] = [];
  const rejected: DiffRecord[] = [];
  const images = await Promise.all([
    readDataUrl(input.expectedImagePath),
    readDataUrl(input.actualImagePath),
    readDataUrl(input.directionalOverlayPath),
    readDataUrl(input.pixelDiffMaskPath)
  ]);
  const scopeArtifacts: UiArtifact[] = [
    { role: "expected_normalized", path: input.expectedImagePath },
    { role: "actual_comparison_space", path: input.actualImagePath },
    { role: "directional_overlay", path: input.directionalOverlayPath },
    { role: "pixel_diff_mask", path: input.pixelDiffMaskPath }
  ];

  for (const summary of selectedSummaries(input.diffScope, input.summaries)) {
    for (const criterion of summary.triggeredCriteria) {
      const rubric = rubrics[criterion];
      const auditResponse = await input.auditorCaller({
        prompt: buildScopeAuditorPrompt(summary, criterion),
        images,
        jsonSchema: { name: `scope_audit_${summary.id}_${criterion}`, schema: rubric.jsonSchema },
        timeoutMs: 60000,
        maxOutputTokens: 4096
      });
      const auditResult = AuditResultSchema.parse(auditResponse.parsed);
      if (!auditResult.hasDiff || !auditResult.evidence || auditResult.evidence.length === 0) continue;

      const reviewResponse = await input.reviewerCaller({
        prompt: buildScopeReviewerPrompt(summary, criterion, auditResult.title ?? criterion, auditResult.evidence),
        images,
        jsonSchema: {
          name: "scope_review_decision",
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
      const review = ReviewDecisionSchema.parse(reviewResponse.parsed);
      const record: DiffRecord = {
        id: crypto.randomBytes(6).toString("hex"),
        criterion,
        severity: auditResult.severity ?? "medium",
        title: auditResult.title ?? `${summary.label} ${criterion} difference`,
        location: summary.box,
        evidence: auditResult.evidence,
        measurements: summary.measurements,
        artifactPaths: scopeArtifacts,
        reviewerStatus: review.decision === "needs_escalation" ? "needs_escalation" : review.decision,
        reviewerReason: review.reason,
        model: auditResponse.model,
        classificationSource: "vlm_reviewed",
        scopeId: summary.id,
        scopeKind: summary.kind,
        scopeLabel: summary.label
      };
      if (review.decision === "rejected") rejected.push(record);
      else accepted.push(record);
    }
  }

  return { accepted, rejected };
}
