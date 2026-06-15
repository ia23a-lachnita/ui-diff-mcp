import { z } from "zod";

export const BoxSchema = z.object({
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  width: z.number().finite().positive(),
  height: z.number().finite().positive()
});
export type Box = z.infer<typeof BoxSchema>;

export const NormalizedBoxSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1),
  height: z.number().finite().positive().max(1)
});
export type NormalizedBox = z.infer<typeof NormalizedBoxSchema>;

export const UiElementTypeSchema = z.enum([
  "text",
  "button",
  "card",
  "image",
  "icon",
  "chart",
  "nav",
  "list_item",
  "unknown"
]);
export type UiElementType = z.infer<typeof UiElementTypeSchema>;

export const UiCriterionSchema = z.enum([
  "presence",
  "geometry",
  "spacing_alignment",
  "typography_content",
  "color_appearance",
  "icon_image",
  "layering_clipping",
  "component_state",
  "chart_special_geometry",
  "unclassified_visual_change"
]);
export type UiCriterion = z.infer<typeof UiCriterionSchema>;

export const UiElementSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: UiElementTypeSchema,
  queryId: z.string().optional(),
  box: BoxSchema,
  normalizedBox: NormalizedBoxSchema,
  text: z.string().optional(),
  confidence: z.number().finite().min(0).max(1),
  source: z.enum(["locator", "ocr", "deterministic", "merged"]),
  parentId: z.string().optional(),
  childIds: z.array(z.string()).default([])
});
export type UiElement = z.infer<typeof UiElementSchema>;

export const PairingStatusSchema = z.enum(["matched", "missing", "extra", "uncertain"]);
export type PairingStatus = z.infer<typeof PairingStatusSchema>;

export const ElementPairSchema = z.object({
  id: z.string().min(1),
  expectedId: z.string().optional(),
  actualId: z.string().optional(),
  status: PairingStatusSchema,
  score: z.number().finite().min(0).max(1),
  reasons: z.array(z.string()).default([])
});
export type ElementPair = z.infer<typeof ElementPairSchema>;

export const DeterministicMeasurementSchema = z.object({
  name: z.string().min(1),
  value: z.union([z.number(), z.string(), z.boolean()]),
  unit: z.string().optional()
});
export type DeterministicMeasurement = z.infer<typeof DeterministicMeasurementSchema>;

export const UiArtifactSchema = z.object({
  role: z.enum([
    "expected_normalized",
    "actual_normalized",
    "pixel_diff",
    "pixel_diff_mask",
    "directional_overlay",
    "target_map_expected",
    "target_map_actual",
    "expected_crop",
    "actual_crop",
    "local_directional_overlay",
    "local_pixel_diff_mask",
    "context_crop",
    "recovery_expected_crop",
    "recovery_actual_crop",
    "recovery_directional_overlay",
    "recovery_pixel_diff_mask"
  ]),
  path: z.string().min(1),
  pairId: z.string().optional(),
  diffId: z.string().optional(),
  targetLabel: z.string().optional()
});
export type UiArtifact = z.infer<typeof UiArtifactSchema>;

export const UnassignedVisualEvidenceSchema = z.object({
  id: z.string().min(1),
  componentBox: BoxSchema,
  pixelCount: z.number().int().positive(),
  componentArea: z.number().int().positive(),
  expectedCropArtifact: UiArtifactSchema,
  actualCropArtifact: UiArtifactSchema,
  directionalOverlayArtifact: UiArtifactSchema,
  pixelDiffMaskArtifact: UiArtifactSchema
});
export type UnassignedVisualEvidence = z.infer<typeof UnassignedVisualEvidenceSchema>;

export const DiffRecordSchema = z.object({
  id: z.string().min(1),
  pairId: z.string().optional(),
  criterion: UiCriterionSchema,
  severity: z.enum(["low", "medium", "high"]),
  title: z.string().min(1),
  location: BoxSchema,
  evidence: z.array(z.string().min(1)).min(1),
  measurements: z.array(DeterministicMeasurementSchema).default([]),
  artifactPaths: z.array(UiArtifactSchema).default([]),
  reviewerStatus: z.enum(["accepted", "rejected", "needs_escalation", "not_reviewed"]),
  model: z.string().optional()
});
export type DiffRecord = z.infer<typeof DiffRecordSchema>;

export const RunStatusSchema = z.enum(["complete", "incomplete", "model_unavailable", "insufficient_free_quota", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const VisualClassificationStatusSchema = z.enum(["complete", "incomplete", "not_run"]);
export type VisualClassificationStatus = z.infer<typeof VisualClassificationStatusSchema>;

export const LocatorCoverageStatusSchema = z.enum(["complete", "weak", "failed", "not_run"]);
export type LocatorCoverageStatus = z.infer<typeof LocatorCoverageStatusSchema>;

export const LocatorMetadataSchema = z.object({
  promptCount: z.number().int().nonnegative(),
  queryCounts: z.record(z.string(), z.number().int().nonnegative())
});

export const AuditScopeSchema = z.object({
  auditedPairs: z.number().int().nonnegative(),
  totalPairs: z.number().int().nonnegative(),
  auditLimited: z.boolean(),
  limitReason: z.string().optional()
});
export type AuditScope = z.infer<typeof AuditScopeSchema>;

export const ModelSelectionSchema = z.object({
  auditor: z.object({
    model: z.string().min(1),
    provider: z.string().min(1),
    costClass: z.enum(["free", "paid"])
  }).optional(),
  reviewer: z.object({
    model: z.string().min(1),
    provider: z.string().min(1),
    costClass: z.enum(["free", "paid"])
  }).optional()
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const RecoverySummarySchema = z.object({
  totalUncoveredComponents: z.number().int().min(0),
  attemptedComponents: z.number().int().min(0),
  skippedComponents: z.number().int().min(0),
  recoveredDiffs: z.number().int().min(0),
  unclassifiedCount: z.number().int().min(0),
  stoppedReason: z.enum(["none", "component_cap", "model_call_cap", "deadline_exceeded"]).default("none"),
  model: z.string().optional()
});
export type RecoverySummary = z.infer<typeof RecoverySummarySchema>;

export const UiDiffReportSchema = z.object({
  schemaVersion: z.literal("0.1"),
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  status: RunStatusSchema,
  visualClassificationStatus: VisualClassificationStatusSchema,
  locatorCoverageStatus: LocatorCoverageStatusSchema.default("not_run"),
  locatorMetadata: LocatorMetadataSchema.optional(),
  auditScope: AuditScopeSchema.optional(),
  modelSelection: ModelSelectionSchema.optional(),
  expectedImagePath: z.string().min(1),
  actualImagePath: z.string().min(1),
  artifactRoot: z.string().min(1),
  elements: z.object({
    expected: z.array(UiElementSchema),
    actual: z.array(UiElementSchema)
  }),
  pairs: z.array(ElementPairSchema),
  diffs: z.array(DiffRecordSchema),
  modelHealth: z.array(z.object({
    role: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    status: z.enum(["pass", "fail", "not_checked"]),
    checkedAt: z.string().datetime(),
    detail: z.string().optional()
  })),
  runArtifacts: z.array(UiArtifactSchema).default([]),
  warnings: z.array(z.string()).default([]),
  recoverySummary: RecoverySummarySchema.optional()
});
export type UiDiffReport = z.infer<typeof UiDiffReportSchema>;
