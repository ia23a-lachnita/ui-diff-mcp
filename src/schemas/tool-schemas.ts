import { z } from "zod";
import { RunStatusSchema, UiDiffReportSchema, UiArtifactSchema, AuditScopeSchema, LocatorCoverageStatusSchema, VisualClassificationStatusSchema, RecoverySummarySchema, RunDebugSummarySchema, DiffScopeSchema, UsageSummarySchema } from "./core.js";

export const CompareUiImagesInputSchema = {
  expectedImagePath: z.string().min(1),
  actualImagePath: z.string().min(1),
  projectRoot: z.string().min(1).optional(),
  runLabel: z.string().min(1).max(80).optional(),
  mode: z.enum(["free", "free_gemini", "free_mistral", "free_opencode", "free_openrouter", "free_nvidia", "paid", "deterministic_only"]).default("free"),
  diffScope: DiffScopeSchema.optional()
};

export const CompareUiImagesOutputSchema = {
  runId: z.string().min(1),
  status: RunStatusSchema,
  diffCount: z.number().int().min(0),
  unresolvedRegionCount: z.number().int().min(0),
  reportPath: z.string().min(1),
  artifactRoot: z.string().min(1),
  runArtifacts: z.array(UiArtifactSchema).default([]),
  summary: z.string().min(1),
  warnings: z.array(z.string()).default([]),
  visualClassificationStatus: VisualClassificationStatusSchema,
  locatorCoverageStatus: LocatorCoverageStatusSchema.default("not_run"),
  auditLimited: z.boolean().default(false),
  auditScope: AuditScopeSchema.optional(),
  recoverySummary: RecoverySummarySchema.optional(),
  debugSummary: RunDebugSummarySchema.optional(),
  usageSummary: UsageSummarySchema.optional()
};

export const ModelHealthOutputSchema = {
  checkedAt: z.string().datetime(),
  results: z.array(z.object({
    role: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    status: z.enum(["pass", "fail", "not_checked"]),
    detail: z.string().optional()
  }))
};

export const ReadUiDiffReportOutputSchema = {
  report: UiDiffReportSchema
};

export const CaptureScreenOutputSchema = {
  imagePath: z.string().min(1),
  capture: z.object({
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    blankPixelRatio: z.number().min(0).max(1),
    validationStatus: z.enum(["ok", "blank", "invalid_dimensions", "parse_error"]),
    warnings: z.array(z.string())
  })
};

export const StartUiDiffRunInputSchema = {
  expectedImagePath: z.string().min(1),
  actualImagePath: z.string().min(1),
  projectRoot: z.string().min(1).optional(),
  mode: z.enum(["free", "free_gemini", "free_mistral", "free_opencode", "free_openrouter", "free_nvidia", "paid", "deterministic_only"]).default("free"),
  diffScope: DiffScopeSchema.optional(),
  label: z.string().min(1).max(80).optional(),
  resumeRunId: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional()
};

export const StartUiDiffRunOutputSchema = {
  runId: z.string().min(1),
  status: z.enum(["queued"]),
  message: z.string().min(1)
};

export const GetUiDiffRunStatusInputSchema = {
  projectRoot: z.string().min(1),
  runId: z.string().min(1)
};

export const GetUiDiffRunStatusOutputSchema = {
  runId: z.string().min(1),
  status: z.enum(["queued", "running", "interrupted", "complete", "incomplete", "failed", "not_found"]),
  reportPath: z.string().optional(),
  artifactRoot: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
  label: z.string().optional()
  ,heartbeatAt: z.string().optional(),
  checkpointPath: z.string().optional(),
  progress: z.object({ stage: z.string(), pairIndex: z.number().int().nonnegative().optional(), criterionIndex: z.number().int().nonnegative().optional() }).optional()
};
