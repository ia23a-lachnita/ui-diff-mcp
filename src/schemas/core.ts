import { z } from "zod";

export const BoxSchema = z.object({
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  width: z.number().finite().positive(),
  height: z.number().finite().positive()
});
export type Box = z.infer<typeof BoxSchema>;

export const ComparisonCoordinateSpaceSchema = z.literal("comparison_expected_normalized");
export type ComparisonCoordinateSpace = z.infer<typeof ComparisonCoordinateSpaceSchema>;

export const ComparisonBoxSourceSpaceSchema = z.enum([
  "expected_normalized",
  "actual_normalized",
  "comparison_expected_normalized"
]);
export type ComparisonBoxSourceSpace = z.infer<typeof ComparisonBoxSourceSpaceSchema>;

export const ComparisonBoxRejectionReasonSchema = z.enum([
  "non_finite",
  "non_positive",
  "disjoint",
  "below_minimum_artifact_size"
]);
export type ComparisonBoxRejectionReason = z.infer<typeof ComparisonBoxRejectionReasonSchema>;

export const ComparisonBoxResolutionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("valid"),
    box: BoxSchema,
    clipped: z.boolean(),
    coordinateSpace: ComparisonCoordinateSpaceSchema,
    sourceSpace: ComparisonBoxSourceSpaceSchema
  }).strict(),
  z.object({
    status: z.literal("rejected"),
    reason: ComparisonBoxRejectionReasonSchema,
    sourceSpace: ComparisonBoxSourceSpaceSchema
  }).strict()
]);
export type ComparisonBoxResolution = z.infer<typeof ComparisonBoxResolutionSchema>;

const GeometryRejectionCountsSchema = z.record(
  ComparisonBoxRejectionReasonSchema,
  z.number().int().nonnegative()
);

export const GeometryDiagnosticReferenceSchema = z.object({
  producer: z.string().min(1),
  reason: ComparisonBoxRejectionReasonSchema,
  reference: z.string().min(1)
}).strict();
export type GeometryDiagnosticReference = z.infer<typeof GeometryDiagnosticReferenceSchema>;

export const GeometryDiagnosticsSchema = z.object({
  countsByReason: GeometryRejectionCountsSchema,
  countsByProducer: z.record(z.string().min(1), GeometryRejectionCountsSchema),
  references: z.array(GeometryDiagnosticReferenceSchema).default([])
}).strict();
export type GeometryDiagnostics = z.infer<typeof GeometryDiagnosticsSchema>;

export const NormalizedBoxSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  width: z.number().finite().positive().max(1),
  height: z.number().finite().positive().max(1)
});
export type NormalizedBox = z.infer<typeof NormalizedBoxSchema>;

export const ImageNormalizationMetadataSchema = z.object({
  source: z.object({
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    aspectRatio: z.number().nonnegative()
  }),
  normalized: z.object({
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    aspectRatio: z.number().nonnegative()
  }),
  resizeMode: z.enum(["none", "fill"]),
  scaleX: z.number().positive(),
  scaleY: z.number().positive(),
  aspectRatioDeltaPercent: z.number().min(0),
  anisotropicScaleDeltaPercent: z.number().min(0)
});
export type ImageNormalizationMetadata = z.infer<typeof ImageNormalizationMetadataSchema>;

export const ViewportCompatibilityStatusSchema = z.enum(["compatible", "mismatch"]);
export type ViewportCompatibilityStatus = z.infer<typeof ViewportCompatibilityStatusSchema>;

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

export const CompactRoleSourceSchema = z.enum(["query_mapping", "deterministic"]);
export type CompactRoleSource = z.infer<typeof CompactRoleSourceSchema>;

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

export const RepairLocalitySchema = z.enum(["local", "broad"]);
export type RepairLocality = z.infer<typeof RepairLocalitySchema>;

export const FindingSuppressionReasonSchema = z.enum([
  "duplicate_child_of_group",
  "screen_sized_context_only",
  "nonlocal_parent_explanation"
]);
export type FindingSuppressionReason = z.infer<typeof FindingSuppressionReasonSchema>;

export const FindingSuppressionSchema = z.object({
  reason: FindingSuppressionReasonSchema,
  retainedFindingIds: z.array(z.string().min(1)).min(1)
}).strict();
export type FindingSuppression = z.infer<typeof FindingSuppressionSchema>;

const FindingGroupLegendBaseShape = {
  id: z.string().min(1),
  label: z.string().min(1),
  box: BoxSchema,
  diffIds: z.array(z.string().min(1)),
  retainedFindingIds: z.array(z.string().min(1)).default([]),
  suppressions: z.array(FindingSuppressionSchema).default([]),
  criteria: z.array(UiCriterionSchema),
  severity: z.enum(["low", "medium", "high"]),
  coordinateSpace: ComparisonCoordinateSpaceSchema
};

export const FindingGroupLegendEntrySchema = z.discriminatedUnion("zoomStatus", [
  z.object({
    ...FindingGroupLegendBaseShape,
    zoomStatus: z.literal("valid"),
    zoomArtifact: z.string().min(1)
  }).strict(),
  z.object({
    ...FindingGroupLegendBaseShape,
    zoomStatus: z.literal("rejected"),
    zoomRejectionReason: ComparisonBoxRejectionReasonSchema
  }).strict(),
  z.object({
    ...FindingGroupLegendBaseShape,
    zoomStatus: z.literal("skipped"),
    zoomSkippedReason: z.literal("max_zooms_exceeded")
  }).strict()
]);
export type FindingGroupLegendEntry = z.infer<typeof FindingGroupLegendEntrySchema>;

export const ProjectionMetadataSchema = z.object({
  mode: z.literal("expected_coordinate_projection"),
  coordinateSpace: z.literal("actual_source_image"),
  sourceElementId: z.string().min(1),
  scaleExpectedToActualX: z.number().positive(),
  scaleExpectedToActualY: z.number().positive()
});
export type ProjectionMetadata = z.infer<typeof ProjectionMetadataSchema>;

export const UiElementSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: UiElementTypeSchema,
  compactRoleSource: CompactRoleSourceSchema.optional(),
  queryId: z.string().optional(),
  box: BoxSchema,
  normalizedBox: NormalizedBoxSchema,
  text: z.string().optional(),
  confidence: z.number().finite().min(0).max(1),
  source: z.enum(["locator", "ocr", "deterministic", "merged", "projected"]),
  projectionMetadata: ProjectionMetadataSchema.optional(),
  parentId: z.string().optional(),
  childIds: z.array(z.string()).default([])
}).superRefine((element, context) => {
  if (element.compactRoleSource !== undefined && element.type !== "button") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["compactRoleSource"],
      message: "compactRoleSource is valid only for button elements"
    });
  }
});
export type UiElement = z.infer<typeof UiElementSchema>;

export const SemanticHierarchyNodeSchema = z.object({
  id: z.string().min(1),
  elementId: z.string().min(1).optional(),
  label: z.string().min(1),
  type: z.union([UiElementTypeSchema, z.literal("screen")]),
  box: BoxSchema,
  nodeRole: z.enum(["screen", "container", "leaf"]),
  coordinateSpace: ComparisonCoordinateSpaceSchema,
  parentNodeId: z.string().min(1).optional(),
  childNodeIds: z.array(z.string().min(1)).default([])
}).strict();
export type SemanticHierarchyNode = z.infer<typeof SemanticHierarchyNodeSchema>;

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

export const ProviderFailureDiagnosticSchema = z.object({
  kind: z.enum(["invalid_json", "truncated_json", "empty_content", "schema_invalid", "http_error", "timeout", "stream_error"]),
  rawContentLength: z.number().int().min(0).optional(),
  firstChars: z.string().max(500).optional(),
  lastChars: z.string().max(500).optional(),
  startsWithJson: z.boolean().optional(),
  endsWithJson: z.boolean().optional(),
  streamCompleted: z.boolean().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  finishReason: z.string().max(64).optional(),
  retryDecision: z.enum(["none", "same_route_compact_retry", "same_route_retry_failed"]).optional()
});
export type ProviderFailureDiagnostic = z.infer<typeof ProviderFailureDiagnosticSchema>;

export const ProviderTraceEventSchema = z.object({
  eventId: z.string().min(1),
  // Legacy traces predate call lifecycle IDs. New call_start/call_success/call_error
  // events always carry this field; absence remains parseable for backward reads.
  callId: z.string().min(1).optional(),
  phase: z.enum(["probe", "audit", "reviewer", "recovery", "quota_preflight"]),
  event: z.enum([
    "call_start", "call_success", "call_error",
    "route_unhealthy", "fallback", "route_exhausted",
    "probe_result", "quota_result"
  ]),
  role: z.enum(["auditor", "reviewer", "target_recovery", "locator", "quota"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  modelFamilyKey: z.string().min(1),
  routeIndex: z.number().int().min(0).optional(),
  attempt: z.number().int().min(0).optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().min(0).optional(),
  status: z.enum(["ok", "error", "pass", "fail", "not_checked", "skipped"]).optional(),
  errorKind: z.string().max(120).optional(),
  httpStatus: z.number().int().optional(),
  retryable: z.boolean().optional(),
  reason: z.string().max(500).optional(),
  // Safe usage metadata — no prompt text, image data, API keys, or raw response bodies
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  totalTokens: z.number().int().min(0).optional(),
  reasoningTokens: z.number().int().min(0).optional(),
  ttftMs: z.number().min(0).optional(),
  finishReason: z.string().max(64).optional(),
  retryDecision: z.enum(["same_route_compact_retry"]).optional(),
  diagnostic: ProviderFailureDiagnosticSchema.optional()
}).strict(); // strict() rejects unknown fields to prevent accidental leakage of sensitive data
export type ProviderTraceEvent = z.infer<typeof ProviderTraceEventSchema>;

export const RuntimeModelUsageSchema = z.object({
  phase: z.enum(["probe", "audit", "reviewer", "recovery", "quota_preflight"]),
  role: z.enum(["auditor", "reviewer", "target_recovery", "locator", "quota"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  callStartCount: z.number().int().nonnegative(),
  callSuccessCount: z.number().int().nonnegative(),
  callErrorCount: z.number().int().nonnegative(),
  fallbackCount: z.number().int().nonnegative(),
  incompleteStartedCallCount: z.number().int().nonnegative().default(0),
  successesWithUsage: z.number().int().nonnegative().default(0),
  successesMissingUsage: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional()
}).strict();
export type RuntimeModelUsage = z.infer<typeof RuntimeModelUsageSchema>;

export const RuntimeModelUsageDiagnosticsSchema = z.object({
  orphanTerminalCount: z.number().int().nonnegative().default(0),
  legacyUnmatchedLifecycleEventCount: z.number().int().nonnegative().default(0),
  duplicateCallStartCount: z.number().int().nonnegative().default(0),
  fallbackWithoutCallStartCount: z.number().int().nonnegative().default(0),
  terminalRouteMismatchCount: z.number().int().nonnegative().default(0),
  terminalStatusMismatchCount: z.number().int().nonnegative().default(0)
}).strict();
export type RuntimeModelUsageDiagnostics = z.infer<typeof RuntimeModelUsageDiagnosticsSchema>;

export const DiffScopeSchema = z.preprocess(
  value => value ?? { kind: "full" },
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("full") }),
    z.object({ kind: z.literal("screen") }),
    z.object({
      kind: z.literal("regions"),
      regions: z.array(z.enum(["top", "middle", "bottom", "header", "content", "nav"])).min(1).optional()
    }),
    z.object({ kind: z.literal("target"), query: z.string().trim().min(1) })
  ])
);
export type DiffScope = z.infer<typeof DiffScopeSchema>;

export const UsageBucketSchema = z.object({
  calls: z.number().int().nonnegative(),
  successesWithUsage: z.number().int().nonnegative().default(0),
  successesMissingUsage: z.number().int().nonnegative().default(0),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  missingUsageCalls: z.number().int().nonnegative(),
  totalOnlyUsageCalls: z.number().int().nonnegative(),
  errorCalls: z.number().int().nonnegative(),
  fallbackCalls: z.number().int().nonnegative(),
  routeExhaustedCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative()
});
export type UsageBucket = z.infer<typeof UsageBucketSchema>;

export const UsageSummarySchema = UsageBucketSchema.extend({
  byPhase: z.record(z.string(), UsageBucketSchema),
  byRole: z.record(z.string(), UsageBucketSchema),
  byRoute: z.record(z.string(), UsageBucketSchema)
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const ReportPartSchema = z.object({
  role: z.enum([
    "elements",
    "pairs",
    "diffs",
    "unresolved_regions",
    "debug_summary",
    "usage_summary",
    "scope_summary"
  ]),
  path: z.string().min(1)
});
export type ReportPart = z.infer<typeof ReportPartSchema>;

export const UiArtifactSchema = z.object({
  role: z.enum([
    "expected_normalized",
    "actual_normalized",
    "actual_comparison_space",
    "pixel_diff",
    "pixel_diff_mask",
    "directional_overlay",
    "locator_input_expected",
    "locator_input_actual",
    "locator_expected_overlay",
    "locator_actual_overlay",
    "locator_overlay_legend",
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
    "recovery_pixel_diff_mask",
    "projected_expected_crop",
    "projected_actual_crop",
    "projected_directional_overlay",
    "projected_pixel_diff_mask",
    "projected_group_expected_crop",
    "projected_group_actual_crop",
    "projected_group_directional_overlay",
    "projected_group_pixel_diff_mask",
    "audit_trace",
    "coverage_trace",
    "recovery_trace",
    "debug_summary",
    "provider_trace",
    "unresolved_regions_overlay",
    "final_diff_regions_overlay",
    "region_context_overlay",
    "final_diff_groups_overlay",
    "final_diff_groups_legend",
    "final_diff_zoom",
    "semantic_hierarchy_overlay",
    "semantic_hierarchy_legend"
  ]),
  path: z.string().min(1),
  pairId: z.string().optional(),
  diffId: z.string().optional(),
  targetLabel: z.string().optional()
});
export type UiArtifact = z.infer<typeof UiArtifactSchema>;

export const ClaimDiagnosticsSchema = z.object({
  code: z.enum([
    "unsupported_absence",
    "unsupported_crop_boundary",
    "unsupported_quantitative",
    "invalid_palette"
  ]),
  message: z.string().max(200),
  offendingExcerpt: z.string().max(200).optional(),
  quantitative: z.object({
    offendingValue: z.number().finite(),
    offendingUnit: z.string().max(32),
    supportedMeasurements: z.array(z.object({
      name: z.string().min(1),
      value: z.union([z.number(), z.string(), z.boolean()]),
      unit: z.string().optional()
    })).max(10).default([])
  }).optional()
}).strict();
export type ClaimDiagnostics = z.infer<typeof ClaimDiagnosticsSchema>;

export const UnresolvedRegionSchema = z.object({
  id: z.string().min(1),
  location: BoxSchema,
  pixelCount: z.number().int().positive(),
  sourceComponentIds: z.array(z.string().min(1)).min(1),
  relatedFindingIds: z.array(z.string().min(1)).default([]),
  relation: z.enum(["nearby_larger_finding", "inside_larger_finding", "none"]).default("none"),
  reason: z.enum([
    "not_classified",
    "audit_route_exhausted",
    "recovery_route_exhausted",
    "recovery_budget_exhausted",
    "evidence_crop_rejected",
    "broad_vlm_evidence",
    "interrupted",
    "unsupported_recovery_claim"
  ]),
  detail: z.string().max(200).optional(),
  diagnostics: ClaimDiagnosticsSchema.optional(),
  artifactPaths: z.array(UiArtifactSchema).default([])
}).strict();
export type UnresolvedRegion = z.infer<typeof UnresolvedRegionSchema>;

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

const DefaultedIdArraySchema = z.preprocess(
  value => value ?? [],
  z.array(z.string().min(1)).optional()
);

export const DiffRecordSchema = z.object({
  id: z.string().min(1),
  pairId: z.string().optional(),
  criterion: UiCriterionSchema,
  severity: z.enum(["low", "medium", "high"]),
  title: z.string().min(1),
  location: BoxSchema,
  coverageLocations: z.array(BoxSchema).min(1).optional(),
  evidence: z.array(z.string().min(1)).min(1),
  measurements: z.array(DeterministicMeasurementSchema).default([]),
  artifactPaths: z.array(UiArtifactSchema).default([]),
  childFindingIds: DefaultedIdArraySchema,
  targetIds: DefaultedIdArraySchema,
  findingGroupId: z.string().min(1).optional(),
  findingGroupKind: z.enum(["coherent_displacement", "structural_region_mismatch"]).optional(),
  groupLabel: z.string().min(1).optional(),
  scopeId: z.string().min(1).optional(),
  scopeKind: z.enum(["screen", "region", "target"]).optional(),
  scopeLabel: z.string().min(1).optional(),
  coordinateSpace: ComparisonCoordinateSpaceSchema.optional(),
  repairLocality: RepairLocalitySchema.optional(),
  suppression: FindingSuppressionSchema.optional(),
  reviewerStatus: z.enum(["accepted", "rejected", "needs_escalation", "not_reviewed"]),
  reviewerReason: z.string().min(1).optional(),
  model: z.string().optional(),
  classificationSource: z.enum([
    "vlm_reviewed",
    "deterministic_projected_mismatch",
    "target_recovery",
    "unclassified",
    "deterministic_geometry",
    "deterministic_presence"
  ]).optional(),
  projectionMismatchReason: z.enum([
    "expected_target_absent_at_projected_location",
    "projected_crop_low_overlap",
    "projected_crop_high_diff_mass",
    "projection_dimension_mismatch"
  ]).optional(),
  projectionMismatchKind: z.enum(["absent_at_location", "displaced", "region_mismatch"]).optional()
}).superRefine((record, ctx) => {
  const deterministicSources = new Set([
    "deterministic_projected_mismatch",
    "deterministic_geometry",
    "deterministic_presence"
  ]);
  if (record.classificationSource && deterministicSources.has(record.classificationSource) && record.reviewerStatus !== "not_reviewed") {
    ctx.addIssue({
      code: "custom",
      path: ["reviewerStatus"],
      message: "Deterministic findings must use reviewerStatus=not_reviewed."
    });
  }
});
export type DiffRecord = z.infer<typeof DiffRecordSchema>;

export const RunStatusSchema = z.enum(["running", "interrupted", "complete", "incomplete", "model_unavailable", "insufficient_free_quota", "failed"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const VisualClassificationStatusSchema = z.enum(["complete", "incomplete", "not_run"]);
export type VisualClassificationStatus = z.infer<typeof VisualClassificationStatusSchema>;

export const LocatorCoverageStatusSchema = z.enum(["complete", "weak", "failed", "not_run", "projected"]);
export type LocatorCoverageStatus = z.infer<typeof LocatorCoverageStatusSchema>;

export const ImageLocatorCoverageSchema = z.object({
  status: LocatorCoverageStatusSchema,
  promptCount: z.number().int().nonnegative(),
  usefulElementCount: z.number().int().nonnegative(),
  queryCounts: z.record(z.string(), z.number().int().nonnegative()),
  queryCoverageRatio: z.number().finite().min(0).max(1),
  rejectedElementCount: z.number().int().nonnegative(),
  reasons: z.array(z.string()).default([])
});

export const LocatorLaneMetadataSchema = z.object({
  status: z.enum(["complete", "failed", "not_configured", "skipped"]),
  count: z.number().int().nonnegative(),
  detail: z.string().optional(),
  model: z.string().optional(),
  license: z.string().optional()
});
export type LocatorLaneMetadata = z.infer<typeof LocatorLaneMetadataSchema>;

export const LocatorMetadataSchema = z.object({
  promptCount: z.number().int().nonnegative(),
  queryCounts: z.record(z.string(), z.number().int().nonnegative()),
  expected: ImageLocatorCoverageSchema.optional(),
  actual: ImageLocatorCoverageSchema.optional(),
  locatorActualMode: z.enum(["independent", "projected"]).optional(),
  lanes: z.record(z.string(), LocatorLaneMetadataSchema).optional()
});

export const LocatorImageSizingSchema = z.object({
  imageRole: z.enum(["expected", "actual"]),
  maxDimension: z.number().int().positive(),
  originalWidth: z.number().int().positive(),
  originalHeight: z.number().int().positive(),
  sentWidth: z.number().int().positive(),
  sentHeight: z.number().int().positive(),
  scale: z.number().positive(),
  resized: z.boolean()
});

export const LocatorInputSizingSchema = z.object({
  mode: z.enum(["single_pass_projected_actual", "dual_locator"]),
  expected: LocatorImageSizingSchema.optional(),
  actual: LocatorImageSizingSchema.optional(),
  warning: z.string().optional()
});
export type LocatorInputSizing = z.infer<typeof LocatorInputSizingSchema>;

export const ProjectedPreAuditSummarySchema = z.object({
  projectedPairsChecked: z.number().int().nonnegative(),
  deterministicProjectedDiffs: z.number().int().nonnegative(),
  sentToVlmPairs: z.number().int().nonnegative(),
  skippedFromVlmPairIds: z.array(z.string()).default([]),
  uniqueDisplacements: z.number().int().nonnegative().default(0),
  displacementGroups: z.number().int().nonnegative().default(0),
  structuralMismatchGroups: z.number().int().nonnegative().default(0),
  groupedPairs: z.number().int().nonnegative().default(0)
});
export type ProjectedPreAuditSummary = z.infer<typeof ProjectedPreAuditSummarySchema>;

export const AuditScopeSchema = z.object({
  auditedPairs: z.number().int().nonnegative(),
  totalPairs: z.number().int().nonnegative(),
  auditLimited: z.boolean(),
  limitReason: z.string().optional(),
  vlmAuditedPairs: z.number().int().nonnegative().optional(),
  preAuditDeterministicPairs: z.number().int().nonnegative().optional(),
  selectedPairs: z.number().int().nonnegative().optional(),
  enteredPairs: z.number().int().nonnegative().optional(),
  providerCalledPairs: z.number().int().nonnegative().optional(),
  validAuditorPairs: z.number().int().nonnegative().optional(),
  reviewedPairs: z.number().int().nonnegative().optional(),
  skippedNoTriggeredPairs: z.number().int().nonnegative().optional(),
  failedPairs: z.number().int().nonnegative().optional(),
  remainingPairs: z.number().int().nonnegative().optional(),
  stoppedReason: z.enum(["none", "route_exhausted", "interrupted"]).optional()
});
export type AuditScope = z.infer<typeof AuditScopeSchema>;

const ModelRouteEntrySchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  costClass: z.enum(["free", "paid"])
});

export const ModelSelectionSchema = z.object({
  auditor: ModelRouteEntrySchema.optional(),
  reviewer: ModelRouteEntrySchema.optional(),
  targetRecovery: ModelRouteEntrySchema.optional(),
  auditorRoutes: z.array(ModelRouteEntrySchema).optional(),
  reviewerRoutes: z.array(ModelRouteEntrySchema).optional(),
  targetRecoveryRoutes: z.array(ModelRouteEntrySchema).optional()
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const StageOutcomeSchema = z.enum(["success", "incomplete", "unavailable", "not_applicable"]);
export type StageOutcome = z.infer<typeof StageOutcomeSchema>;

const StageStatusRecordSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["pending", "running", "complete", "failed", "skipped"]),
  outcome: StageOutcomeSchema,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().min(0).optional(),
  detail: z.string().optional()
});

export const StageStatusSchema = z.preprocess(value => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record["outcome"] !== undefined) return value;
  return {
    ...record,
    outcome: record["status"] === "skipped" ? "not_applicable" : "incomplete"
  };
}, StageStatusRecordSchema);
export type StageStatus = z.infer<typeof StageStatusSchema>;

export const RecoverySummarySchema = z.object({
  totalUncoveredComponents: z.number().int().min(0),
  eligibleComponents: z.number().int().min(0).default(0),
  completedComponents: z.number().int().min(0).default(0),
  remainingComponents: z.number().int().min(0).default(0),
  batchCount: z.number().int().min(0).default(0),
  preClusterUncoveredComponents: z.number().int().min(0).optional(),
  postClusterUncoveredComponents: z.number().int().min(0).optional(),
  attemptedComponents: z.number().int().min(0),
  skippedComponents: z.number().int().min(0),
  recoveredDiffs: z.number().int().min(0),
  unclassifiedCount: z.number().int().min(0),
  stoppedReason: z.enum(["none", "component_cap", "model_call_cap", "deadline_exceeded", "caller_unavailable"]).default("none"),
  model: z.string().optional(),
  statusCounts: z.record(z.string(), z.number().int().nonnegative()).default({})
});
export type RecoverySummary = z.infer<typeof RecoverySummarySchema>;

export const RecoveryCursorSchema = z.object({
  nextRegionIndex: z.number().int().nonnegative(),
  remainingModelCalls: z.number().int().nonnegative(),
  remainingRegionIds: z.array(z.string().min(1)).default([])
});
export type RecoveryCursor = z.infer<typeof RecoveryCursorSchema>;

export const AuditDecisionStatusSchema = z.enum([
  "criterion_not_triggered",
  "auditor_has_diff",
  "auditor_no_diff",
  "auditor_error",
  "auditor_schema_error",
  "empty_evidence",
  "reviewer_accepted",
  "reviewer_rejected",
  "reviewer_needs_escalation",
  "reviewer_error",
  "deterministic_projected_mismatch"
]);

export const AuditCriterionTraceSchema = z.object({
  pairId: z.string().min(1),
  expectedId: z.string().optional(),
  actualId: z.string().optional(),
  targetLabel: z.string().min(1),
  targetType: UiElementTypeSchema,
  criterion: UiCriterionSchema.exclude(["unclassified_visual_change"]),
  status: AuditDecisionStatusSchema,
  model: z.string().optional(),
  reviewerModel: z.string().optional(),
  auditorDurationMs: z.number().int().min(0).optional(),
  reviewerDurationMs: z.number().int().min(0).optional(),
  evidenceCount: z.number().int().min(0).default(0),
  diffId: z.string().optional(),
  skipReason: z.string().max(500).optional(),
  rejectionReason: z.string().optional(),
  errorKind: z.enum(["provider", "schema", "unexpected"]).optional(),
  errorMessage: z.string().max(500).optional(),
  imageRoles: z.array(z.string()).default([]),
  artifactPaths: z.array(UiArtifactSchema).default([])
});
export type AuditCriterionTrace = z.infer<typeof AuditCriterionTraceSchema>;

export const CoverageDecisionStatusSchema = z.enum([
  "below_threshold",
  "covered_by_diff",
  "covered_by_residual_rule",
  "noise_residual_fragment",
  "uncovered"
]);

export const CoverageDecisionTraceSchema = z.object({
  componentId: z.string().min(1),
  componentBox: BoxSchema,
  pixelCount: z.number().int().min(0),
  status: CoverageDecisionStatusSchema,
  coveringDiffId: z.string().optional(),
  coveringCriterion: UiCriterionSchema.optional(),
  overlapRatio: z.number().finite().min(0).max(1).optional()
});
export type CoverageDecisionTrace = z.infer<typeof CoverageDecisionTraceSchema>;

export const RecoveryDecisionStatusSchema = z.enum([
  "below_threshold",
  "skipped_component_cap",
  "skipped_model_call_cap",
  "skipped_deadline",
  "classified_false",
  "recovery_accepted",
  "recovery_needs_escalation",
  "recovery_rejected",
  "unsupported_recovery_claim",
  "recovery_error",
  "recovery_schema_error",
  "missing_required_fields",
  "evidence_crop_rejected",
  "box_out_of_bounds",
  "box_no_component_overlap"
]);

export const RecoveryComponentTraceSchema = z.object({
  componentId: z.string().min(1),
  rank: z.number().int(),
  componentBox: BoxSchema,
  evidenceBox: BoxSchema.optional(),
  actualEvidenceBox: BoxSchema.optional(),
  pixelCount: z.number().int().min(0),
  status: RecoveryDecisionStatusSchema,
  model: z.string().optional(),
  reviewerModel: z.string().optional(),
  recoveryDurationMs: z.number().int().min(0).optional(),
  reviewerDurationMs: z.number().int().min(0).optional(),
  diffId: z.string().optional(),
  rejectionReason: z.string().optional(),
  criterion: UiCriterionSchema.exclude(["unclassified_visual_change"]).optional(),
  errorKind: z.enum(["provider", "schema", "validation", "budget", "unexpected"]).optional(),
  errorMessage: z.string().max(500).optional(),
  artifactPaths: z.array(UiArtifactSchema).default([]),
  candidateTitle: z.string().max(200).optional(),
  candidateEvidence: z.array(z.string().max(200)).max(10).optional(),
  candidateMeasurements: z.array(DeterministicMeasurementSchema).max(10).optional(),
  claimValidationDiagnostics: ClaimDiagnosticsSchema.optional(),
  supersededByFindingId: z.string().optional(),
  supersessionReason: z.enum(["same_criterion_acceptance_overlap"]).optional(),
  supersessionOverlapRatio: z.number().min(0).max(1).optional()
});
export type RecoveryComponentTrace = z.infer<typeof RecoveryComponentTraceSchema>;

export const RecoveryRegionOutcomeSchema = z.object({
  regionId: z.string().min(1),
  state: z.enum(["recovered", "noise", "unresolved"]),
  reason: z.string().min(1),
  artifactPaths: z.array(UiArtifactSchema).default([]),
  findingId: z.string().optional(),
  rejectionReason: z.string().optional(),
  criterion: UiCriterionSchema.exclude(["unclassified_visual_change"]).optional(),
  diagnostics: ClaimDiagnosticsSchema.optional(),
  candidateTitle: z.string().max(200).optional(),
  candidateEvidence: z.array(z.string().max(200)).max(10).optional()
}).strict();
export type RecoveryRegionOutcome = z.infer<typeof RecoveryRegionOutcomeSchema>;

export const RunDebugSummarySchema = z.object({
  auditPairs: z.number().int().min(0),
  auditCriterionCalls: z.number().int().min(0),
  auditAccepted: z.number().int().min(0),
  auditRejected: z.number().int().min(0),
  auditNoDiff: z.number().int().min(0),
  auditErrors: z.number().int().min(0),
  coverageComponents: z.number().int().min(0),
  coverageCovered: z.number().int().min(0),
  coverageUncovered: z.number().int().min(0),
  coverageBelowThreshold: z.number().int().min(0),
  coverageResidualCovered: z.number().int().min(0).default(0),
  coverageResidualNoise: z.number().int().min(0).default(0),
  recoveryAttempted: z.number().int().min(0),
  recoveryAccepted: z.number().int().min(0),
  recoveryRejected: z.number().int().min(0),
  recoveryClassifiedFalse: z.number().int().min(0),
  recoveryErrors: z.number().int().min(0),
  recoverySkipped: z.number().int().min(0)
});
export type RunDebugSummary = z.infer<typeof RunDebugSummarySchema>;

export const ScopeDiffSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["screen", "region"]),
  label: z.string().min(1),
  box: BoxSchema,
  changedPixelPercent: z.number().finite().min(0),
  edgeChangedPercent: z.number().finite().min(0),
  triggeredCriteria: z.array(UiCriterionSchema.exclude(["unclassified_visual_change"])).default([]),
  measurements: z.array(DeterministicMeasurementSchema).default([])
});
export type ScopeDiffSummary = z.infer<typeof ScopeDiffSummarySchema>;

export const DiffSummarySchema = z.object({
  finalDiffCount: z.number().int().nonnegative(),
  unresolvedRegionCount: z.number().int().nonnegative(),
  bySeverity: z.record(z.string(), z.number().int().nonnegative()),
  byCriterion: z.record(z.string(), z.number().int().nonnegative()),
  byClassificationSource: z.record(z.string(), z.number().int().nonnegative()),
  scopeSummaries: z.array(ScopeDiffSummarySchema).default([])
});
export type DiffSummary = z.infer<typeof DiffSummarySchema>;

const Sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);

const InputAcquisitionAttestationSchema = z.object({
  expected: z.object({
    source: z.enum(["canonical_default", "env_override"]),
    verification: z.literal("caller_attested")
  }).strict(),
  actual: z.object({
    source: z.enum(["auto_capture", "env_override"]),
    verification: z.literal("caller_attested")
  }).strict()
}).strict();

export const InputProvenanceRequestSchema = z.object({
  acquisition: InputAcquisitionAttestationSchema.optional(),
  expectedManifestPath: z.string().min(1).optional()
}).strict().refine(
  value => value.acquisition !== undefined || value.expectedManifestPath !== undefined,
  { message: "inputProvenance must include an acquisition attestation or expectedManifestPath" }
);
export type InputProvenanceRequest = z.infer<typeof InputProvenanceRequestSchema>;

export const InputProvenanceSchema = z.object({
  identity: z.object({
    expected: z.object({
      sha256: Sha256Schema,
      manifest: z.object({
        path: z.string().min(1),
        entryFilename: z.string().min(1),
        entrySha256: Sha256Schema,
        verification: z.literal("verified_against_expected_bytes")
      }).strict().optional()
    }).strict(),
    actual: z.object({ sha256: Sha256Schema }).strict()
  }).strict(),
  acquisition: InputAcquisitionAttestationSchema.optional()
}).strict();
export type InputProvenance = z.infer<typeof InputProvenanceSchema>;

export const UiDiffReportSchema = z.object({
  schemaVersion: z.literal("0.1"),
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  status: RunStatusSchema,
  isCheckpoint: z.preprocess(value => value ?? false, z.boolean().optional()),
  heartbeatAt: z.string().datetime().optional(),
  progress: z.object({
    stage: z.string().min(1),
    pairIndex: z.number().int().nonnegative().optional(),
    criterionIndex: z.number().int().nonnegative().optional(),
    checkpointPath: z.string().min(1).optional()
  }).optional(),
  visualClassificationStatus: VisualClassificationStatusSchema,
  locatorCoverageStatus: LocatorCoverageStatusSchema.default("not_run"),
  locatorMetadata: LocatorMetadataSchema.optional(),
  locatorInputSizing: LocatorInputSizingSchema.optional(),
  diffScope: DiffScopeSchema.optional(),
  auditScope: AuditScopeSchema.optional(),
  projectedPreAudit: ProjectedPreAuditSummarySchema.optional(),
  geometryDiagnostics: GeometryDiagnosticsSchema.optional(),
  modelSelection: ModelSelectionSchema.optional(),
  runtimeModelUsage: z.array(RuntimeModelUsageSchema).optional(),
  runtimeModelUsageDiagnostics: RuntimeModelUsageDiagnosticsSchema.optional(),
  inputProvenance: InputProvenanceSchema.optional(),
  expectedImagePath: z.string().min(1),
  actualImagePath: z.string().min(1),
  artifactRoot: z.string().min(1),
  elements: z.object({
    expected: z.array(UiElementSchema),
    actual: z.array(UiElementSchema)
  }),
  pairs: z.array(ElementPairSchema),
  diffs: z.array(DiffRecordSchema),
  unresolvedRegions: z.array(UnresolvedRegionSchema).default([]),
  reportParts: z.preprocess(value => value ?? [], z.array(ReportPartSchema).optional()),
  usageSummary: UsageSummarySchema.optional(),
  diffSummary: DiffSummarySchema.optional(),
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
  imageNormalization: z.object({
    expected: ImageNormalizationMetadataSchema,
    actual: ImageNormalizationMetadataSchema
  }).optional(),
  viewportCompatibilityStatus: ViewportCompatibilityStatusSchema.optional(),
  viewportCompatibilityReasons: z.array(z.string()).optional(),
  comparisonSpace: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    actualResizeMode: z.literal("fill"),
    sourceCropsPreserveOriginalPixels: z.boolean()
  }).optional(),
  providerDiagnosticsPresent: z.boolean().optional(),
  recoverySummary: RecoverySummarySchema.optional(),
  recoveryCursor: RecoveryCursorSchema.optional(),
  stages: z.array(StageStatusSchema).default([]),
  debugSummary: RunDebugSummarySchema.optional()
});
export type UiDiffReport = z.infer<typeof UiDiffReportSchema>;
