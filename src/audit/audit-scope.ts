import crypto from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";
import type {
  DiffRecord,
  DiffScope,
  ScopeAuditTrace,
  ScopeDiffSummary,
  UiArtifact,
  UiCriterion
} from "../schemas/core.js";
import type { VisionJsonCaller } from "../models/vision-json.js";
import { AuditResultSchema, rubrics } from "./criteria.js";
import {
  validateReviewerHandle,
  type ReviewerHandle
} from "./audit-target.js";
import { RouteExhaustedError } from "../models/fallback-caller.js";
import { modelFamilyKey } from "../models/model-registry.js";

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
  reviewerResolver: (auditorProvider: string, auditorModel: string) => ReviewerHandle | null;
}

export interface ScopeAuditSummary {
  scopeAuditCalls: number;
  scopeFailedAudits: number;
  scopeUnresolvedAudits: number;
  scopeAuditAccepted: number;
  scopeAuditRejected: number;
  scopeAuditNoDiff: number;
  scopeAuditErrors: number;
  scopeAuditEscalated: number;
  stoppedReason: "none" | "route_exhausted";
}

export interface AuditScopeSummariesResult {
  accepted: DiffRecord[];
  rejected: DiffRecord[];
  trace: ScopeAuditTrace[];
  summary: ScopeAuditSummary;
}

function selectedSummaries(scope: DiffScope, summaries: ScopeDiffSummary[]): ScopeDiffSummary[] {
  if (scope.kind === "screen") return summaries.filter(summary => summary.id === "screen");
  if (scope.kind === "regions") {
    const selected = new Set<string>(scope.regions ?? ["top", "middle", "bottom", "nav"]);
    return summaries.filter(summary => summary.kind === "region" && selected.has(summary.id));
  }
  if (scope.kind === "target") return [];
  return summaries;
}

async function readDataUrl(filePath: string): Promise<string> {
  return `data:image/png;base64,${(await fs.readFile(filePath)).toString("base64")}`;
}

function buildScopeAuditorPrompt(
  summary: ScopeDiffSummary,
  criterion: Exclude<UiCriterion, "unclassified_visual_change">
): string {
  const rubric = rubrics[criterion];
  const measurements = summary.measurements.length > 0
    ? summary.measurements.map(m => `  - ${m.name}: ${m.value}${m.unit ? " " + m.unit : ""}`).join("\n")
    : "  (none)";
  return [
    `You are checking a ${summary.kind} level UI difference, not an individual target.`,
    `SCOPE: ${summary.label} (${summary.id})`,
    `CRITERION: ${criterion}`,
    `CRITERION DESCRIPTION: ${rubric.description}`,
    "",
    "DETERMINISTIC MEASUREMENTS:",
    measurements,
    "",
    "EVIDENCE IMAGES (in order):",
    "  1. Full expected/mockup screen",
    "  2. Full actual screenshot in comparison space",
    "  3. Directional diff overlay",
    "  4. Pixel-diff mask",
    "",
    "STRICT RULES:",
    "- Report only visible differences in this scope and criterion.",
    "- Do not suggest causes, code changes, or design fixes.",
    "- Do not make exact pixel, spacing, font-size, percentage, or angle claims unless citing a listed deterministic measurement.",
    "- Prefer broad layout/color/shape observations over tiny child-target details.",
    "- Transparent contain padding, letterbox/pillarbox bars, and pixels outside the comparable content viewport are not app UI; do not report them as a scope difference.",
    "",
    'OUTPUT: { "hasDiff": false } or { "hasDiff": true, "severity": "medium", "title": "short title", "evidence": ["visible qualitative observation"] }',
    "Respond with JSON only."
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
    "EVIDENCE:",
    ...evidence.map(item => `  - ${item}`),
    "",
    "Accept only visually supported claims. Reject vague, unsupported, or over-precise claims.",
    "- Treat transparent contain padding, letterbox/pillarbox bars, and pixels outside the comparable content viewport as non-UI evidence.",
    'Return JSON only: { "decision": "accepted" | "rejected" | "needs_escalation", "reason": "<one sentence>" }'
  ].join("\n");
}

function makeId(): string {
  return crypto.randomBytes(6).toString("hex");
}

function makeScopeRecord(
  summary: ScopeDiffSummary,
  criterion: Exclude<UiCriterion, "unclassified_visual_change">,
  evidence: string[],
  title: string,
  severity: "low" | "medium" | "high",
  artifacts: UiArtifact[],
  auditorModel: string | undefined,
  reviewerStatus: "accepted" | "rejected" | "needs_escalation",
  reviewerReason: string
): DiffRecord {
  return {
    id: makeId(),
    criterion,
    severity,
    title,
    location: summary.box,
    evidence,
    measurements: summary.measurements,
    artifactPaths: artifacts,
    reviewerStatus,
    ...(auditorModel !== undefined ? { model: auditorModel } : {}),
    classificationSource: "vlm_reviewed",
    reviewerReason,
    scopeId: summary.id,
    scopeKind: summary.kind,
    scopeLabel: summary.label
  };
}

export async function auditScopeSummaries(input: AuditScopeSummariesInput): Promise<AuditScopeSummariesResult> {
  const accepted: DiffRecord[] = [];
  const rejected: DiffRecord[] = [];
  const trace: ScopeAuditTrace[] = [];
  const summary: ScopeAuditSummary = {
    scopeAuditCalls: 0,
    scopeFailedAudits: 0,
    scopeUnresolvedAudits: 0,
    scopeAuditAccepted: 0,
    scopeAuditRejected: 0,
    scopeAuditNoDiff: 0,
    scopeAuditErrors: 0,
    scopeAuditEscalated: 0,
    stoppedReason: "none"
  };
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
  let routeExhausted = false;

  const addTrace = (entry: Omit<ScopeAuditTrace, "evidenceCount" | "imageRoles" | "artifactPaths"> & Partial<Pick<ScopeAuditTrace, "evidenceCount" | "imageRoles" | "artifactPaths">>): void => {
    trace.push({
      ...entry,
      evidenceCount: entry.evidenceCount ?? 0,
      imageRoles: entry.imageRoles ?? ["expected_normalized", "actual_comparison_space", "directional_overlay", "pixel_diff_mask"],
      artifactPaths: entry.artifactPaths ?? scopeArtifacts
    });
  };

  const addFailureTrace = (
    current: ScopeDiffSummary,
    criterion: Exclude<UiCriterion, "unclassified_visual_change">,
    status: ScopeAuditTrace["status"],
    started: number,
    errorKind: "provider" | "schema" | "identity" | "unexpected",
    errorMessage: string,
    evidenceCount = 0,
    auditorModel?: string,
    reviewerModel?: string,
    reviewerProvider?: string,
    auditorProvider?: string
  ): void => {
    const message = errorMessage.slice(0, 500);
    addTrace({
      scopeId: current.id,
      scopeKind: current.kind,
      scopeLabel: current.label,
      criterion,
      status,
      ...(auditorProvider !== undefined ? { auditorProvider } : {}),
      ...(auditorModel !== undefined ? { auditorModel } : {}),
      ...(reviewerModel !== undefined ? { reviewerModel } : {}),
      ...(reviewerProvider !== undefined ? { reviewerProvider } : {}),
      durationMs: Date.now() - started,
      evidenceCount,
      errorKind,
      errorMessage: message,
      rejectionReason: message
    });
  };

  const addAuditorFailure = (
    current: ScopeDiffSummary,
    criterion: Exclude<UiCriterion, "unclassified_visual_change">,
    status: Extract<ScopeAuditTrace["status"], "auditor_error" | "auditor_schema_error" | "auditor_empty_evidence">,
    started: number,
    errorKind: "provider" | "schema" | "unexpected",
    errorMessage: string,
    auditorModel?: string,
    auditorProvider?: string
  ): void => {
    summary.scopeFailedAudits++;
    summary.scopeAuditErrors++;
    addFailureTrace(current, criterion, status, started, errorKind, errorMessage, 0, auditorModel, undefined, undefined, auditorProvider);
  };

  const addReviewerEscalation = (
    current: ScopeDiffSummary,
    criterion: Exclude<UiCriterion, "unclassified_visual_change">,
    status: Extract<ScopeAuditTrace["status"], "reviewer_error" | "reviewer_identity_error">,
    started: number,
    errorKind: "provider" | "schema" | "identity" | "unexpected",
    errorMessage: string,
    auditResponse: Awaited<ReturnType<VisionJsonCaller>>,
    evidence: string[],
    title: string,
    severity: "low" | "medium" | "high",
    reviewerModel?: string,
    reviewerProvider?: string,
    stoppedReason?: "route_exhausted"
  ): void => {
    const message = errorMessage.slice(0, 500);
    const record = makeScopeRecord(
      current,
      criterion,
      evidence,
      title,
      severity,
      scopeArtifacts,
      auditResponse.model,
      "needs_escalation",
      message
    );
    accepted.push(record);
    summary.scopeFailedAudits++;
    summary.scopeAuditErrors++;
    summary.scopeAuditEscalated++;
    if (stoppedReason !== undefined) summary.stoppedReason = stoppedReason;
    addFailureTrace(current, criterion, status, started, errorKind, message, evidence.length, auditResponse.model, reviewerModel, reviewerProvider, auditResponse.provider);
    trace[trace.length - 1] = { ...trace[trace.length - 1]!, diffId: record.id };
  };

  const addReviewerUnresolved = (
    current: ScopeDiffSummary,
    criterion: Exclude<UiCriterion, "unclassified_visual_change">,
    status: Extract<ScopeAuditTrace["status"], "reviewer_needs_escalation" | "independent_reviewer_unavailable">,
    started: number,
    errorKind: "identity" | "unexpected",
    errorMessage: string,
    auditResponse: Awaited<ReturnType<VisionJsonCaller>>,
    evidence: string[],
    title: string,
    severity: "low" | "medium" | "high",
    reviewerModel?: string,
    reviewerProvider?: string
  ): void => {
    const message = errorMessage.slice(0, 500);
    const record = makeScopeRecord(
      current,
      criterion,
      evidence,
      title,
      severity,
      scopeArtifacts,
      auditResponse.model,
      "needs_escalation",
      message
    );
    accepted.push(record);
    summary.scopeUnresolvedAudits++;
    summary.scopeAuditEscalated++;
    addFailureTrace(current, criterion, status, started, errorKind, message, evidence.length, auditResponse.model, reviewerModel, reviewerProvider, auditResponse.provider);
    trace[trace.length - 1] = { ...trace[trace.length - 1]!, diffId: record.id };
  };

  scopeLoop:
  for (const current of selectedSummaries(input.diffScope, input.summaries)) {
    for (const criterion of current.triggeredCriteria) {
      if (routeExhausted) break scopeLoop;
      const started = Date.now();
      summary.scopeAuditCalls++;
      let auditResponse: Awaited<ReturnType<VisionJsonCaller>>;
      try {
        auditResponse = await input.auditorCaller({
          prompt: buildScopeAuditorPrompt(current, criterion),
          images,
          jsonSchema: { name: `scope_audit_${current.id}_${criterion}`, schema: rubrics[criterion].jsonSchema },
          timeoutMs: 60000,
          maxOutputTokens: 4096
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addAuditorFailure(current, criterion, "auditor_error", started, "provider", message);
        if (error instanceof RouteExhaustedError) {
          routeExhausted = true;
          summary.stoppedReason = "route_exhausted";
        }
        continue;
      }

      let auditResult: z.infer<typeof AuditResultSchema>;
      try {
        auditResult = AuditResultSchema.parse(auditResponse.parsed);
      } catch (error) {
        addAuditorFailure(current, criterion, "auditor_schema_error", started, "schema", error instanceof Error ? error.message : String(error), auditResponse.model, auditResponse.provider);
        continue;
      }
      const auditorDurationMs = Date.now() - started;
      if (!auditResult.hasDiff) {
        summary.scopeAuditNoDiff++;
        addTrace({
          scopeId: current.id,
          scopeKind: current.kind,
          scopeLabel: current.label,
          criterion,
          status: "auditor_no_diff",
          auditorProvider: auditResponse.provider,
          auditorModel: auditResponse.model,
          durationMs: auditorDurationMs,
          auditorDurationMs,
          evidenceCount: auditResult.evidence?.length ?? 0
        });
        continue;
      }
      const evidence = auditResult.evidence ?? [];
      if (evidence.length === 0) {
        addAuditorFailure(current, criterion, "auditor_empty_evidence", started, "schema", "Auditor reported a difference without evidence", auditResponse.model, auditResponse.provider);
        continue;
      }

      let handle: ReviewerHandle | null;
      try {
        handle = input.reviewerResolver(auditResponse.provider, auditResponse.model);
      } catch (error) {
        addReviewerEscalation(current, criterion, "reviewer_error", started, "unexpected", error instanceof Error ? error.message : String(error), auditResponse, evidence, auditResult.title ?? `${current.label} ${criterion} difference`, auditResult.severity ?? "medium");
        continue;
      }
      if (handle === null) {
        addReviewerUnresolved(current, criterion, "independent_reviewer_unavailable", started, "identity", "No independent reviewer route was declared", auditResponse, evidence, auditResult.title ?? `${current.label} ${criterion} difference`, auditResult.severity ?? "medium");
        continue;
      }
      const handleError = validateReviewerHandle(handle, auditResponse.provider, auditResponse.model);
      if (handleError !== undefined) {
        addReviewerUnresolved(current, criterion, "independent_reviewer_unavailable", started, "identity", handleError, auditResponse, evidence, auditResult.title ?? `${current.label} ${criterion} difference`, auditResult.severity ?? "medium");
        continue;
      }

      const reviewerStarted = Date.now();
      let reviewerResponse: Awaited<ReturnType<VisionJsonCaller>>;
      try {
        reviewerResponse = await handle.caller({
          prompt: buildScopeReviewerPrompt(current, criterion, auditResult.title ?? criterion, evidence),
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addReviewerEscalation(current, criterion, "reviewer_error", started, "provider", message, auditResponse, evidence, auditResult.title ?? `${current.label} ${criterion} difference`, auditResult.severity ?? "medium", undefined, undefined, error instanceof RouteExhaustedError ? "route_exhausted" : undefined);
        if (error instanceof RouteExhaustedError) routeExhausted = true;
        continue;
      }
      const declaredRoute = handle.routes.find(route => route.provider === reviewerResponse.provider && route.model === reviewerResponse.model);
      const independentlyValid = declaredRoute !== undefined
        && !(reviewerResponse.provider === auditResponse.provider && reviewerResponse.model === auditResponse.model)
        && modelFamilyKey(reviewerResponse.model) !== modelFamilyKey(auditResponse.model)
        && modelFamilyKey(reviewerResponse.model) === declaredRoute.familyKey;
      if (!independentlyValid) {
        addReviewerEscalation(
          current,
          criterion,
          "reviewer_identity_error",
          started,
          "identity",
          `Reviewer response ${reviewerResponse.provider}/${reviewerResponse.model} did not match a declared independent route`,
          auditResponse,
          evidence,
          auditResult.title ?? `${current.label} ${criterion} difference`,
          auditResult.severity ?? "medium",
          reviewerResponse.model,
          reviewerResponse.provider,
        );
        continue;
      }

      let review: z.infer<typeof ReviewDecisionSchema>;
      try {
        review = ReviewDecisionSchema.parse(reviewerResponse.parsed);
      } catch (error) {
        addReviewerEscalation(current, criterion, "reviewer_error", started, "schema", error instanceof Error ? error.message : String(error), auditResponse, evidence, auditResult.title ?? `${current.label} ${criterion} difference`, auditResult.severity ?? "medium", reviewerResponse.model, reviewerResponse.provider);
        continue;
      }
      const reviewerDurationMs = Date.now() - reviewerStarted;
      const diff = makeScopeRecord(
        current,
        criterion,
        evidence,
        auditResult.title ?? `${current.label} ${criterion} difference`,
        auditResult.severity ?? "medium",
        scopeArtifacts,
        auditResponse.model,
        review.decision === "needs_escalation" ? "needs_escalation" : review.decision,
        review.reason
      );
      if (review.decision === "accepted") {
        accepted.push(diff);
        summary.scopeAuditAccepted++;
      } else if (review.decision === "rejected") {
        rejected.push(diff);
        summary.scopeAuditRejected++;
      } else {
        accepted.push(diff);
        summary.scopeUnresolvedAudits++;
        summary.scopeAuditEscalated++;
      }
      addTrace({
        scopeId: current.id,
        scopeKind: current.kind,
        scopeLabel: current.label,
        criterion,
        status: review.decision === "accepted" ? "reviewer_accepted" : review.decision === "rejected" ? "reviewer_rejected" : "reviewer_needs_escalation",
        auditorProvider: auditResponse.provider,
        auditorModel: auditResponse.model,
        reviewerProvider: reviewerResponse.provider,
        reviewerModel: reviewerResponse.model,
        durationMs: Date.now() - started,
        auditorDurationMs,
        reviewerDurationMs,
        evidenceCount: evidence.length,
        diffId: diff.id,
        ...(review.decision !== "accepted" ? { rejectionReason: review.reason } : {})
      });
    }
  }

  return { accepted, rejected, trace, summary };
}
