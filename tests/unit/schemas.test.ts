import { describe, expect, it } from "vitest";
import {
  CoverageDecisionTraceSchema,
  DiffScopeSchema,
  DiffRecordSchema,
  UsageSummarySchema,
  ModelSelectionSchema,
  RunDebugSummarySchema,
  StageStatusSchema,
  UiArtifactSchema,
  UiDiffReportSchema,
  UnresolvedRegionSchema
} from "../../src/schemas/core.js";

function makeMinimalReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "0.1",
    runId: "run-1",
    createdAt: new Date().toISOString(),
    status: "complete",
    visualClassificationStatus: "complete",
    expectedImagePath: "expected.png",
    actualImagePath: "actual.png",
    artifactRoot: ".ui-diff/runs/run-1/artifacts",
    elements: { expected: [], actual: [] },
    pairs: [],
    diffs: [],
    modelHealth: [],
    ...overrides
  };
}

describe("core schemas", () => {
  it("accepts the actual comparison-space image as a primary run artifact", () => {
    expect(UiArtifactSchema.parse({
      role: "actual_comparison_space",
      path: "C:/run/actual-comparison-space.png"
    })).toMatchObject({ role: "actual_comparison_space" });
  });

  it("accepts exact LocateAnything input payload images as run artifacts", () => {
    expect(UiArtifactSchema.parse({
      role: "locator_input_expected",
      path: "C:/run/artifacts/locator-input-expected.png"
    })).toMatchObject({ role: "locator_input_expected" });
    expect(UiArtifactSchema.parse({
      role: "locator_input_actual",
      path: "C:/run/artifacts/locator-input-actual.png"
    })).toMatchObject({ role: "locator_input_actual" });
  });

  it("accepts locator detection overlay artifacts", () => {
    expect(UiArtifactSchema.parse({
      role: "locator_expected_overlay",
      path: "C:/run/artifacts/locator-expected-overlay.png"
    })).toMatchObject({ role: "locator_expected_overlay" });
    expect(UiArtifactSchema.parse({
      role: "locator_actual_overlay",
      path: "C:/run/artifacts/locator-actual-projected-overlay.png"
    })).toMatchObject({ role: "locator_actual_overlay" });
    expect(UiArtifactSchema.parse({
      role: "locator_overlay_legend",
      path: "C:/run/artifacts/locator-overlay-legend.json"
    })).toMatchObject({ role: "locator_overlay_legend" });
  });

  it("accepts full-screen context overlay artifacts", () => {
    expect(UiArtifactSchema.parse({
      role: "region_context_overlay",
      path: "C:/run/region-context-overlay.png"
    })).toMatchObject({ role: "region_context_overlay" });
    expect(UiArtifactSchema.parse({
      role: "unresolved_regions_overlay",
      path: "C:/run/unresolved-regions-overlay.png"
    })).toMatchObject({ role: "unresolved_regions_overlay" });
    expect(UiArtifactSchema.parse({
      role: "final_diff_regions_overlay",
      path: "C:/run/final-diff-regions-overlay.png"
    })).toMatchObject({ role: "final_diff_regions_overlay" });
  });

  it("accepts residual coverage trace statuses and unresolved region relation metadata", () => {
    expect(CoverageDecisionTraceSchema.parse({
      componentId: "component-1",
      componentBox: { x: 10, y: 10, width: 3, height: 30 },
      pixelCount: 90,
      status: "noise_residual_fragment",
      coveringDiffId: "diff-large",
      coveringCriterion: "geometry",
      overlapRatio: 0
    }).status).toBe("noise_residual_fragment");

    expect(UnresolvedRegionSchema.parse({
      id: "region-1",
      location: { x: 10, y: 10, width: 3, height: 30 },
      pixelCount: 90,
      sourceComponentIds: ["component-1"],
      reason: "not_classified",
      relatedFindingIds: ["diff-large"],
      relation: "nearby_larger_finding",
      artifactPaths: []
    }).relatedFindingIds).toEqual(["diff-large"]);
  });

  it("debug summary records residual coverage counters", () => {
    const parsed = RunDebugSummarySchema.parse({
      auditPairs: 0,
      auditCriterionCalls: 0,
      auditAccepted: 0,
      auditRejected: 0,
      auditNoDiff: 0,
      auditErrors: 0,
      coverageComponents: 2,
      coverageCovered: 0,
      coverageUncovered: 0,
      coverageBelowThreshold: 0,
      coverageResidualCovered: 1,
      coverageResidualNoise: 1,
      recoveryAttempted: 0,
      recoveryAccepted: 0,
      recoveryRejected: 0,
      recoveryClassifiedFalse: 0,
      recoveryErrors: 0,
      recoverySkipped: 0
    });

    expect(parsed.coverageResidualNoise).toBe(1);
  });

  it("parses legacy complete stage records fail-closed as incomplete", () => {
    expect(StageStatusSchema.parse({ name: "audit", status: "complete" })).toMatchObject({
      status: "complete",
      outcome: "incomplete"
    });
  });

  it("parses legacy skipped stage records as not applicable", () => {
    expect(StageStatusSchema.parse({ name: "audit", status: "skipped" })).toMatchObject({
      status: "skipped",
      outcome: "not_applicable"
    });
  });

  it("accepts a visible diff record with evidence", () => {
    const parsed = DiffRecordSchema.parse({
      id: "diff-1",
      criterion: "geometry",
      severity: "high",
      title: "Button is lower than expected",
      location: { x: 10, y: 20, width: 100, height: 44 },
      evidence: ["actual y=20, expected y=12"],
      reviewerStatus: "accepted"
    });
    expect(parsed.criterion).toBe("geometry");
  });

  it("accepts scope metadata on screen-level diff records", () => {
    const parsed = DiffRecordSchema.parse({
      id: "screen-diff-1",
      criterion: "color_appearance",
      severity: "medium",
      title: "Overall palette differs",
      location: { x: 0, y: 0, width: 360, height: 800 },
      evidence: ["Full-screen overlay shows broad color differences."],
      reviewerStatus: "accepted",
      classificationSource: "vlm_reviewed",
      scopeId: "screen",
      scopeKind: "screen",
      scopeLabel: "Whole screen"
    });

    expect(parsed.scopeKind).toBe("screen");
    expect(parsed.scopeLabel).toBe("Whole screen");
  });

  it("accepts deterministic findings only as not reviewed", () => {
    const parsed = DiffRecordSchema.parse({
      id: "deterministic-1",
      criterion: "geometry",
      severity: "medium",
      title: "Target is displaced",
      location: { x: 10, y: 20, width: 100, height: 44 },
      evidence: ["Deterministic translation dx=4px, dy=8px."],
      reviewerStatus: "not_reviewed",
      model: "deterministic",
      classificationSource: "deterministic_projected_mismatch"
    });

    expect(parsed.reviewerStatus).toBe("not_reviewed");
  });

  it("rejects deterministic findings labeled as reviewer accepted", () => {
    expect(() => DiffRecordSchema.parse({
      id: "deterministic-accepted",
      criterion: "presence",
      severity: "high",
      title: "Target absent at projected location",
      location: { x: 10, y: 20, width: 100, height: 44 },
      evidence: ["Projected crop mismatch."],
      reviewerStatus: "accepted",
      model: "deterministic",
      classificationSource: "deterministic_projected_mismatch"
    })).toThrow(/deterministic findings must use reviewerStatus=not_reviewed/i);
  });

  it("rejects a report without evidence-backed diffs", () => {
    expect(() => UiDiffReportSchema.parse(makeMinimalReport({
      diffs: [{
        id: "bad",
        criterion: "presence",
        severity: "low",
        title: "Bad",
        location: { x: 0, y: 0, width: 1, height: 1 },
        evidence: [],
        reviewerStatus: "accepted"
      }]
    }))).toThrow();
  });

  it("accepts modelSelection with auditor and reviewer", () => {
    const parsed = UiDiffReportSchema.parse(makeMinimalReport({
      modelSelection: {
        auditor: { model: "qwen/qwen3-vl-30b:free", provider: "openrouter", costClass: "free" },
        reviewer: { model: "moonshotai/kimi-k2.6", provider: "nvidia", costClass: "free" }
      }
    }));
    expect(parsed.modelSelection?.auditor?.provider).toBe("openrouter");
    expect(parsed.modelSelection?.reviewer?.provider).toBe("nvidia");
    expect(parsed.modelSelection?.reviewer?.costClass).toBe("free");
  });

  it("accepts report without modelSelection (optional)", () => {
    const parsed = UiDiffReportSchema.parse(makeMinimalReport());
    expect(parsed.modelSelection).toBeUndefined();
  });

  it("ModelSelectionSchema rejects empty model string", () => {
    expect(() => ModelSelectionSchema.parse({
      auditor: { model: "", provider: "openrouter", costClass: "free" }
    })).toThrow();
  });

  it("bounded smoke run exposes visualClassificationStatus and auditLimited to distinguish from full run", () => {
    const parsed = UiDiffReportSchema.parse(makeMinimalReport({
      status: "incomplete",
      visualClassificationStatus: "incomplete",
      auditScope: { auditedPairs: 3, totalPairs: 10, auditLimited: true, limitReason: "max pairs limit" }
    }));
    // Both fields must be present so callers cannot confuse a bounded smoke with a full classification
    expect(parsed.visualClassificationStatus).toBe("incomplete");
    expect(parsed.auditScope?.auditLimited).toBe(true);
    expect(parsed.auditScope?.auditedPairs).toBe(3);
    expect(parsed.auditScope?.totalPairs).toBe(10);
  });

  it("accepts locator input sizing metadata on reports", () => {
    const parsed = UiDiffReportSchema.parse(makeMinimalReport({
      locatorInputSizing: {
        mode: "single_pass_projected_actual",
        expected: {
          imageRole: "expected",
          maxDimension: 600,
          originalWidth: 1206,
          originalHeight: 2622,
          sentWidth: 276,
          sentHeight: 600,
          scale: 0.2288,
          resized: true
        },
        warning: "Low locator max dimension can hide small UI targets."
      }
    }));

    expect(parsed.locatorInputSizing?.mode).toBe("single_pass_projected_actual");
    expect(parsed.locatorInputSizing?.expected?.sentHeight).toBe(600);
    expect(parsed.locatorInputSizing?.warning).toContain("hide small UI targets");
  });

  it("defaults diff scope to full and validates target query", () => {
    expect(DiffScopeSchema.parse(undefined)).toEqual({ kind: "full" });
    expect(DiffScopeSchema.parse({ kind: "screen" })).toEqual({ kind: "screen" });
    expect(DiffScopeSchema.parse({ kind: "regions", regions: ["top", "nav"] })).toEqual({ kind: "regions", regions: ["top", "nav"] });
    expect(DiffScopeSchema.parse({ kind: "target", query: "scan button" })).toEqual({ kind: "target", query: "scan button" });
    expect(() => DiffScopeSchema.parse({ kind: "target", query: "" })).toThrow();
  });

  it("usage summary preserves input and output tokens separately", () => {
    const parsed = UsageSummarySchema.parse({
      calls: 2,
      inputTokens: 1000,
      outputTokens: 120,
      totalTokens: 1120,
      reasoningTokens: 7,
      missingUsageCalls: 1,
      totalOnlyUsageCalls: 0,
      errorCalls: 1,
      fallbackCalls: 1,
      routeExhaustedCount: 0,
      durationMs: 42,
      byPhase: {
        audit: {
          calls: 1,
          inputTokens: 700,
          outputTokens: 80,
          totalTokens: 780,
          reasoningTokens: 0,
          missingUsageCalls: 0,
          totalOnlyUsageCalls: 0,
          errorCalls: 0,
          fallbackCalls: 0,
          routeExhaustedCount: 0,
          durationMs: 20
        }
      },
      byRole: {},
      byRoute: {}
    });

    expect(parsed.inputTokens).toBe(1000);
    expect(parsed.outputTokens).toBe(120);
    expect(parsed.totalTokens).toBe(1120);
  });

  it("report accepts diff scope, report parts, diff summary, and usage summary", () => {
    const usage = UsageSummarySchema.parse({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      missingUsageCalls: 0,
      totalOnlyUsageCalls: 0,
      errorCalls: 0,
      fallbackCalls: 0,
      routeExhaustedCount: 0,
      durationMs: 0,
      byPhase: {},
      byRole: {},
      byRoute: {}
    });
    const parsed = UiDiffReportSchema.parse(makeMinimalReport({
      diffScope: { kind: "regions", regions: ["top", "nav"] },
      usageSummary: usage,
      reportParts: [{ role: "usage_summary", path: "parts/usage-summary.json" }],
      diffSummary: {
        finalDiffCount: 0,
        unresolvedRegionCount: 0,
        bySeverity: {},
        byCriterion: {},
        byClassificationSource: {},
        scopeSummaries: [{
          id: "nav",
          kind: "region",
          label: "Bottom navigation",
          box: { x: 0, y: 700, width: 360, height: 100 },
          changedPixelPercent: 12.5,
          edgeChangedPercent: 8.2,
          triggeredCriteria: ["geometry", "color_appearance"],
          measurements: []
        }]
      }
    }));

    expect(parsed.diffScope?.kind).toBe("regions");
    expect(parsed.reportParts?.[0]?.path).toBe("parts/usage-summary.json");
    expect(parsed.diffSummary?.scopeSummaries[0]?.triggeredCriteria).toContain("geometry");
  });
});
