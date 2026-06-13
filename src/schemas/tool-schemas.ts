import { z } from "zod";
import { RunStatusSchema, UiDiffReportSchema } from "./core.js";

export const CompareUiImagesInputSchema = {
  expectedImagePath: z.string().min(1),
  actualImagePath: z.string().min(1),
  projectRoot: z.string().min(1).optional(),
  runLabel: z.string().min(1).max(80).optional(),
  mode: z.enum(["full", "deterministic_only", "free_only"]).default("full")
};

export const CompareUiImagesOutputSchema = {
  runId: z.string().min(1),
  status: RunStatusSchema,
  diffCount: z.number().int().min(0),
  reportPath: z.string().min(1),
  artifactRoot: z.string().min(1),
  runArtifacts: z.array(z.string()).default([]),
  summary: z.string().min(1),
  warnings: z.array(z.string()).default([])
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
  imagePath: z.string().min(1)
};
