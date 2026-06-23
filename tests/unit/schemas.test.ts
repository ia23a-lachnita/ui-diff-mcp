import { describe, expect, it } from "vitest";
import { DiffRecordSchema, StageStatusSchema, UiArtifactSchema, UiDiffReportSchema, ModelSelectionSchema } from "../../src/schemas/core.js";

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
});
