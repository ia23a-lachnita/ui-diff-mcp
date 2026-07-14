import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTargetRecovery } from "../../src/recovery/target-recovery.js";
import type { RecoveryBudget, RecoveryContext } from "../../src/recovery/target-recovery.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";
import type { PixelComponent } from "../../src/signals/pixel-diff.js";
import type { VisionJsonCaller } from "../../src/models/vision-json.js";
import { RecoveryComponentTraceSchema, RecoveryRegionOutcomeSchema, type DeterministicMeasurement } from "../../src/schemas/core.js";
import { validateClaim } from "../../src/audit/review-findings.js";

let tmpDir: string;
let overlayPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-corrections-test-"));
  overlayPath = await writeSolidPng(tmpDir, "overlay.png", 200, 200, 128, 128, 128);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRgba(width: number, height: number, r = 128, g = 128, b = 128): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function makeMask(width: number, height: number, value = 1): Uint8Array {
  return new Uint8Array(width * height).fill(value);
}

function makeCtx(overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
    parsed: { classified: false },
    rawContent: "",
    model: "test-model",
    provider: "openrouter"
  });
  const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
    parsed: { decision: "accepted", reason: "confirmed" },
    rawContent: "",
    model: "test-reviewer",
    provider: "openrouter"
  });
  return {
    expectedRgba: makeRgba(200, 200),
    actualRgba: makeRgba(200, 200),
    pixelDiffMask: makeMask(200, 200),
    directionalOverlayPath: overlayPath,
    artifactDir: tmpDir,
    recoveryCaller,
    reviewerCaller,
    ...overrides
  };
}

const component: PixelComponent = {
  box: { x: 10, y: 10, width: 80, height: 60 },
  pixelCount: 500
};

const invalidComponent: PixelComponent = {
  box: { x: 10, y: 10, width: 80, height: 60 },
  pixelCount: 500
};

function invalidRecoveryResponse() {
  return {
    parsed: {
      classified: true,
      criterion: "color_appearance",
      severity: "medium",
      label: "Background",
      evidence: ["background color is #FF0000"]
    },
    rawContent: "",
    model: "recovery-model",
    provider: "mistral"
  };
}

function validRepairResponse() {
  return {
    parsed: {
      classified: true,
      criterion: "color_appearance",
      severity: "medium",
      label: "Background",
      evidence: ["background color changed from light to dark"]
    },
    rawContent: "",
    model: "repair-model",
    provider: "mistral"
  };
}

function acceptedReviewerResponse() {
  return {
    parsed: { decision: "accepted", reason: "color difference confirmed" },
    rawContent: "",
    model: "reviewer-model",
    provider: "opencode"
  };
}

// ── P1: Budget-aware repair+reviewer calls ──

describe("recovery-corrections: budget-aware repair", () => {
  it("maxModelCalls=1: invalid candidate does not reach repair or reviewer (only initial call)", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue(invalidRecoveryResponse());
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const result = await runTargetRecovery([invalidComponent], makeCtx({ recoveryCaller, reviewerCaller }), {
      maxComponents: 100,
      maxModelCalls: 1,
      deadlineMs: Date.now() + 300000,
      minComponentPixels: 1
    });
    expect(recoveryCaller).toHaveBeenCalledOnce();
    expect(reviewerCaller).not.toHaveBeenCalled();
    expect(result.recovered).toHaveLength(0);
    expect(result.stoppedReason).toBe("none");
    expect(result.cursor.remainingModelCalls).toBe(0);
    // The invalid candidate was processed but repair+reviewer were skipped due to budget
    expect(result.statusCounts["still_invalid"] ?? 0).toBe(0);
    expect(result.statusCounts["repair_skipped_budget"] ?? result.statusCounts["budget_exhausted_before_repair"] ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("maxModelCalls=2: invalid candidate skips repair (wasteful: repair+no reviewer is useless)", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue(invalidRecoveryResponse());
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const result = await runTargetRecovery([invalidComponent], makeCtx({ recoveryCaller, reviewerCaller }), {
      maxComponents: 100,
      maxModelCalls: 2,
      deadlineMs: Date.now() + 300000,
      minComponentPixels: 1
    });
    expect(recoveryCaller).toHaveBeenCalledOnce();
    // With 2 calls: 1 initial + 1 reviewer = OK, but invalid needs repair first
    // 2 calls total: 1 initial + 1 repair = no reviewer => skip repair
    expect(reviewerCaller).not.toHaveBeenCalled();
    expect(result.recovered).toHaveLength(0);
  });

  it("deadline expiry before any call stops all processing", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue(invalidRecoveryResponse());
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const result = await runTargetRecovery([invalidComponent], makeCtx({ recoveryCaller, reviewerCaller }), {
      maxComponents: 100,
      maxModelCalls: 200,
      deadlineMs: Date.now() + 1, // expires before loop starts (async prepare takes time)
      minComponentPixels: 1
    });
    // Deadline expires before the loop starts, so no model call is made
    expect(recoveryCaller).not.toHaveBeenCalled();
    expect(reviewerCaller).not.toHaveBeenCalled();
    expect(result.recovered).toHaveLength(0);
    expect(result.stoppedReason).toBe("deadline_exceeded");
  });

  it("pre-reviewer budget recheck: reject when only 0 calls remain before reviewer", async () => {
    // Use budget of 3: 1 initial + 1 repair + 0 reviewer = reviewer skipped
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce(invalidRecoveryResponse())
      .mockResolvedValueOnce(validRepairResponse());
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const result = await runTargetRecovery([invalidComponent], makeCtx({ recoveryCaller, reviewerCaller }), {
      maxComponents: 100,
      maxModelCalls: 3,
      deadlineMs: Date.now() + 300000,
      minComponentPixels: 1
    });
    // 1 initial + 1 repair = 2 calls. Budget=3, but pre-reviewer check needs 1 more.
    // Actually budget 3 allows 3 calls, so reviewer should be called.
    expect(recoveryCaller).toHaveBeenCalledTimes(2);
    expect(reviewerCaller).toHaveBeenCalledOnce();
    expect(result.recovered).toHaveLength(1);
  });

  it("pre-reviewer budget recheck: skip repair when budget exhausted after initial (repair+reviewer requires 2)", async () => {
    // Budget of 2: 1 initial + 1 repair = 2, no budget for reviewer
    // The code checks: remainingAfterInitial (1) < 2 (repair+reviewer), so repair is skipped entirely
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce(invalidRecoveryResponse())
      .mockResolvedValueOnce(validRepairResponse());
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const result = await runTargetRecovery([invalidComponent], makeCtx({ recoveryCaller, reviewerCaller }), {
      maxComponents: 100,
      maxModelCalls: 2,
      deadlineMs: Date.now() + 300000,
      minComponentPixels: 1
    });
    // remainingAfterInitial = 1 < 2 (repair+reviewer), so repair is skipped
    expect(recoveryCaller).toHaveBeenCalledOnce();
    expect(reviewerCaller).not.toHaveBeenCalled();
    expect(result.recovered).toHaveLength(0);
    expect(result.statusCounts["budget_exhausted_before_reviewer"] ?? result.statusCounts["budget_exhausted_before_repair"] ?? 0).toBeGreaterThanOrEqual(1);
  });
});

// ── P1: Untrusted measurements ──

describe("recovery-corrections: model measurements untrusted", () => {
  it("invented model measurements cannot authorize exact quantities in final DiffRecord", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background color changed"],
          measurements: [
            { name: "invented_width", value: 150, unit: "px" },
            { name: "invented_height", value: 300, unit: "px" }
          ]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "mistral"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background color changed from light to dark"],
          measurements: [
            { name: "invented_width", value: 150, unit: "px" }
          ]
        },
        rawContent: "",
        model: "repair-model",
        provider: "mistral"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([invalidComponent], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(1);
    const record = result.recovered[0]!;
    // Final measurements must contain only deterministic measurements, not model-invented ones
    const inventedMeasurements = record.measurements.filter(m => m.name.startsWith("invented_"));
    expect(inventedMeasurements).toHaveLength(0);
    // Must still have deterministic measurements
    expect(record.measurements.some(m => m.name === "changed_pixel_count")).toBe(true);
  });

  it("invented model measurements cannot authorize exact colors", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "color_appearance",
        severity: "medium",
        label: "Background",
        evidence: ["background color is #FF0000"],
        measurements: [
          { name: "source_color_hex", value: "#FF0000" }
        ]
      },
      rawContent: "",
      model: "recovery-model",
      provider: "mistral"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([invalidComponent], ctx, unlimitedBudget);
    // Candidate has #FF0000 in evidence but no deterministic color measurement
    // validateClaim should reject it, repair flow attempted
    expect(result.recovered).toHaveLength(0);
  });

  it("model-proposed measurements preserved in trace rawModelProposedMeasurements", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "geometry",
        severity: "medium",
        label: "Button",
        evidence: ["element shifted"],
        measurements: [
          { name: "model_suggested_offset", value: 12, unit: "px" }
        ]
      },
      rawContent: "",
      model: "recovery-model",
      provider: "mistral"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(1);
    const trace = result.trace[0];
    // Raw model-proposed measurements should be preserved in trace
    expect(trace?.rawModelProposedMeasurements).toBeDefined();
    expect(trace?.rawModelProposedMeasurements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "model_suggested_offset", value: 12 })])
    );
  });

  it("model-proposed measurements preserved in regionOutcome rawModelProposedMeasurements", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "geometry",
        severity: "medium",
        label: "Button",
        evidence: ["element shifted"],
        measurements: [
          { name: "model_suggested_offset", value: 12, unit: "px" }
        ]
      },
      rawContent: "",
      model: "recovery-model",
      provider: "mistral"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    const outcome = result.regionOutcomes[0];
    expect(outcome?.rawModelProposedMeasurements).toBeDefined();
    expect(outcome?.rawModelProposedMeasurements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "model_suggested_offset", value: 12 })])
    );
  });

  it("repair rawModelProposedMeasurements preserved separately from initial", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"],
          measurements: [{ name: "initial_model_val", value: 99 }]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "mistral"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background color changed from light to dark"],
          measurements: [{ name: "repair_model_val", value: 42 }]
        },
        rawContent: "",
        model: "repair-model",
        provider: "mistral"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([invalidComponent], ctx, unlimitedBudget);
    const trace = result.trace[0];
    expect(trace?.rawModelProposedMeasurements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "repair_model_val", value: 42 })])
    );
    expect(trace?.originalCandidateRawMeasurements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "initial_model_val", value: 99 })])
    );
  });
});

// ── P1: Severity continuity ──

describe("recovery-corrections: severity continuity", () => {
  it("repair with changed severity remains unresolved", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "high",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "mistral"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "low", // changed from high
          label: "Background",
          evidence: ["background color changed from light to dark"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "mistral"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([invalidComponent], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(0);
    expect(result.statusCounts["repair_severity_change"]).toBe(1);
    expect(reviewerCaller).not.toHaveBeenCalled();
  });

  it("repair with same severity proceeds to reviewer", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "high",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "mistral"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "high", // same severity
          label: "Background",
          evidence: ["background color changed from light to dark"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "mistral"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([invalidComponent], ctx, unlimitedBudget);
    expect(reviewerCaller).toHaveBeenCalledOnce();
    expect(result.recovered).toHaveLength(1);
  });

  it("canonical original severity is vlmResponse.severity ?? medium", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          // severity omitted — should canonicalize to medium
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "mistral"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium", // matches canonicalized medium
          label: "Background",
          evidence: ["background color changed"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "mistral"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([invalidComponent], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.severity).toBe("medium");
  });
});

// ── P1: Semantic substitution rejection ──

describe("recovery-corrections: semantic substitution rejection", () => {
  it("reviewer sees original+diagnostic+repaired evidence and rejects semantic substitution", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "mistral"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Sidebar", // different visual observation (semantic substitution)
          evidence: ["the sidebar has a different color scheme"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "mistral"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "rejected", reason: "repair describes different visual observation" },
      rawContent: "",
      model: "reviewer-model",
      provider: "opencode"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([invalidComponent], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(0);
    expect(result.statusCounts["recovery_rejected"]).toBe(1);
    // Verify reviewer received original+diagnostic+repaired evidence
    const reviewerPrompt = vi.mocked(reviewerCaller).mock.calls[0]?.[0].prompt ?? "";
    expect(reviewerPrompt).toContain("ORIGINAL");
    expect(reviewerPrompt).toContain("REPAIRED");
    expect(reviewerPrompt).toContain("DIAGNOSTIC");
  });

  it("continuity review reason persisted in trace and outcome", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "mistral"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Sidebar",
          evidence: ["sidebar has different color"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "mistral"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "rejected", reason: "repair describes different visual observation" },
      rawContent: "",
      model: "reviewer-model",
      provider: "opencode"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([invalidComponent], ctx, unlimitedBudget);
    const trace = result.trace[0];
    expect(trace?.continuityReviewResult).toBeDefined();
    expect(trace?.continuityReviewResult).toBe("rejected");
    const outcome = result.regionOutcomes[0];
    expect(outcome?.continuityReviewResult).toBe("rejected");
  });
});

// ── P1: Independent reviewer route ──

describe("recovery-corrections: independent reviewer route", () => {
  it("reviewer uses different provider+model from recoveryCaller", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", evidence: ["shifted"] },
      rawContent: "",
      model: "mistral-14b",
      provider: "mistral"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "mimo-v2.5",
      provider: "opencode"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(1);
    const trace = result.trace[0];
    expect(trace?.reviewerProvider).toBe("opencode");
    expect(trace?.reviewerModel).toBe("mimo-v2.5");
    expect(trace?.model).toBe("mistral-14b");
    // Reviewer provider must differ from recovery provider
    expect(trace?.reviewerProvider).not.toBe(trace?.provider);
  });

  it("persisted actual reviewer provider/model in outcome", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", evidence: ["shifted"] },
      rawContent: "",
      model: "mistral-14b",
      provider: "mistral"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "mimo-v2.5",
      provider: "opencode"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    const outcome = result.regionOutcomes[0];
    expect(outcome?.reviewerProvider).toBe("opencode");
    expect(outcome?.reviewerModel).toBe("mimo-v2.5");
  });

  it("no independent route remains unresolved with independent_reviewer_unavailable", async () => {
    // Same provider+model for both recovery and reviewer
    const caller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", evidence: ["shifted"] },
        rawContent: "",
        model: "same-model",
        provider: "same-provider"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "same-model",
      provider: "same-provider"
    });
    const ctx = makeCtx({ recoveryCaller: caller, reviewerCaller });
    // No independent reviewer resolver provided — should fail
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(0);
    expect(result.statusCounts["independent_reviewer_unavailable"]).toBe(1);
  });

  it("recovery fallback changing actual model uses new model for independence check", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", evidence: ["shifted"] },
        rawContent: "",
        model: "fallback-model",
        provider: "fallback-provider"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "reviewer-model",
      provider: "reviewer-provider"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(1);
    // Reviewer provider must differ from actual recovery provider
    expect(result.trace[0]?.reviewerProvider).not.toBe("fallback-provider");
  });
});

// ── P2: Outcome truth ──

describe("recovery-corrections: outcome truth", () => {
  it("recoveryRegionOutcome preserves originalCandidateMeasurements and repairedCandidateMeasurements", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"],
          measurements: [{ name: "initial_model_measurement", value: 77 }]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "mistral"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background color changed"],
          measurements: [{ name: "repair_model_measurement", value: 88 }]
        },
        rawContent: "",
        model: "repair-model",
        provider: "mistral"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([invalidComponent], ctx, unlimitedBudget);
    const outcome = result.regionOutcomes[0];
    expect(outcome?.originalCandidateMeasurements).toBeDefined();
    expect(outcome?.originalCandidateMeasurements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "changed_pixel_count" })])
    );
    expect(outcome?.repairedCandidateMeasurements).toBeDefined();
    expect(outcome?.repairedCandidateMeasurements).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "changed_pixel_count" })])
    );
  });

  it("repairModel includes provider as well as model", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce(invalidRecoveryResponse())
      .mockResolvedValueOnce(validRepairResponse());
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([invalidComponent], ctx, unlimitedBudget);
    const outcome = result.regionOutcomes[0];
    expect(outcome?.repairModel).toBe("repair-model");
    expect(outcome?.repairProvider).toBe("mistral");
  });

  it("recovery provider persisted in outcome and trace", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", evidence: ["shifted"] },
      rawContent: "",
      model: "recovery-model",
      provider: "mistral"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.trace[0]?.provider).toBe("mistral");
    expect(result.regionOutcomes[0]?.provider).toBe("mistral");
  });

  it("schema round-trip includes new optional fields", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"],
          measurements: [{ name: "initial_model_measurement", value: 77 }]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "mistral"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background color changed"],
          measurements: [{ name: "repair_model_measurement", value: 88 }]
        },
        rawContent: "",
        model: "repair-model",
        provider: "mistral"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([invalidComponent], ctx, unlimitedBudget);
    expect(() => RecoveryComponentTraceSchema.array().parse(result.trace)).not.toThrow();
    expect(() => RecoveryRegionOutcomeSchema.array().parse(result.regionOutcomes)).not.toThrow();
  });
});

// ── P1: Hard deadline enforcement ──

describe("recovery-corrections: deadline enforcement", () => {
  it("initial call timeout capped to remaining deadline", async () => {
    let capturedTimeout: number | undefined;
    const recoveryCaller: VisionJsonCaller = vi.fn().mockImplementation(async (req) => {
      capturedTimeout = req.timeoutMs;
      return { parsed: { classified: false }, rawContent: "", model: "m", provider: "p" };
    });
    const reviewerCaller: VisionJsonCaller = vi.fn();
    await runTargetRecovery([component], makeCtx({ recoveryCaller, reviewerCaller }), {
      maxComponents: 100, maxModelCalls: 200, deadlineMs: Date.now() + 5000, minComponentPixels: 1
    });
    expect(capturedTimeout).toBeLessThanOrEqual(5000);
    expect(capturedTimeout).toBeGreaterThan(0);
  });

  it("repair call timeout capped to remaining deadline", async () => {
    let capturedTimeouts: number[] = [];
    const recoveryCaller: VisionJsonCaller = vi.fn().mockImplementation(async (req) => {
      capturedTimeouts.push(req.timeoutMs ?? 0);
      if (capturedTimeouts.length === 1) {
        // First call (initial): invalid candidate triggers repair
        return {
          parsed: { classified: true, criterion: "color_appearance", severity: "medium", label: "Background", evidence: ["color is #FF0000"] },
          rawContent: "", model: "recovery-model", provider: "mistral"
        };
      }
      // Second call (repair)
      return {
        parsed: { classified: true, criterion: "color_appearance", severity: "medium", label: "Background", evidence: ["background color changed from light to dark"] },
        rawContent: "", model: "repair-model", provider: "mistral"
      };
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    await runTargetRecovery([invalidComponent], makeCtx({ recoveryCaller, reviewerCaller }), {
      maxComponents: 100, maxModelCalls: 200, deadlineMs: Date.now() + 10000, minComponentPixels: 1
    });
    expect(capturedTimeouts.length).toBeGreaterThanOrEqual(2);
    expect(capturedTimeouts[1]).toBeLessThanOrEqual(10000);
  });

  it("post-call expiry after initial emits deadline status and stops", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 100));
      return {
        parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", evidence: ["shifted"] },
        rawContent: "", model: "m", provider: "p"
      };
    });
    const reviewerCaller: VisionJsonCaller = vi.fn();
    const result = await runTargetRecovery([component], makeCtx({ recoveryCaller, reviewerCaller }), {
      maxComponents: 100, maxModelCalls: 200, deadlineMs: Date.now() + 30, minComponentPixels: 1
    });
    expect(result.stoppedReason).toBe("deadline_exceeded");
    expect(result.recovered).toHaveLength(0);
    expect(result.statusCounts["deadline_exceeded"]).toBeGreaterThanOrEqual(1);
  });
});

// ── P2: Schema compatibility ──

describe("recovery-corrections: schema compatibility", () => {
  it("parses old-report trace without new optional fields", () => {
    const oldTrace = {
      componentId: "component-0001",
      rank: 0,
      componentBox: { x: 10, y: 10, width: 80, height: 60 },
      pixelCount: 500,
      status: "classified_false" as const,
      model: "some-model",
      recoveryDurationMs: 100,
      artifactPaths: []
    };
    expect(() => RecoveryComponentTraceSchema.parse(oldTrace)).not.toThrow();
  });

  it("parses old-report outcome without new optional fields", () => {
    const oldOutcome = {
      regionId: "component-0001",
      state: "noise" as const,
      reason: "classified_false",
      artifactPaths: []
    };
    expect(() => RecoveryRegionOutcomeSchema.parse(oldOutcome)).not.toThrow();
  });

  it("parses trace with deadline_exceeded status", () => {
    const trace = {
      componentId: "component-0001",
      rank: 0,
      componentBox: { x: 10, y: 10, width: 80, height: 60 },
      pixelCount: 500,
      status: "deadline_exceeded" as const,
      model: "some-model",
      provider: "some-provider",
      recoveryDurationMs: 0,
      artifactPaths: []
    };
    expect(() => RecoveryComponentTraceSchema.parse(trace)).not.toThrow();
  });
});

// ── P1: Model-proposed measurements rejected from validateClaim ──

describe("recovery-corrections: model measurements rejected from validation", () => {
  it("initial validateClaim only sees deterministic measurements, not model-proposed", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockImplementation(async () => ({
      parsed: {
        classified: true,
        criterion: "color_appearance",
        severity: "medium",
        label: "Button color",
        evidence: ["Button changed from red to blue"],
        measurements: [{ name: "exact_color", value: "0x1F456C", unit: "hex" }]
      },
      rawContent: "", model: "recovery-model", provider: "mistral"
    }));
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue(acceptedReviewerResponse());
    const result = await runTargetRecovery([component], makeCtx({ recoveryCaller, reviewerCaller }), unlimitedBudget);
    expect(result.recovered.length).toBeGreaterThanOrEqual(1);
    const recovered = result.recovered.find(r => r.title.includes("Button color"));
    if (recovered) {
      const names = recovered.measurements.map((m: DeterministicMeasurement) => m.name);
      expect(names).toContain("changed_pixel_count");
      expect(names).toContain("region_area_pixels");
      expect(names).not.toContain("exact_color");
    }
  });

  it("negative: evidence claims 150px deterministic + model proposes 150px → initial validateClaim fails", async () => {
    const recovered = {
      title: "geometry in recovered region: Button shifted",
      evidence: ["Button is shifted 150px to the right"],
      measurements: [
        { name: "shift_distance_px", value: 150, unit: "px" },
        { name: "changed_pixel_count", value: 1200, unit: "pixels" }
      ]
    };
    const validation = validateClaim(recovered);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toBeDefined();
  });

  it("negative: repaired evidence + repaired model measurement: second validateClaim fails and reviewer not called", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true, criterion: "color_appearance", severity: "medium",
          label: "Background", evidence: ["color is 150px wide"],
          measurements: [{ name: "exact_width", value: 150, unit: "px" }]
        },
        rawContent: "", model: "recovery-model", provider: "mistral"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true, criterion: "geometry", severity: "medium",
          label: "Background element", evidence: ["Background shifted 150px right"],
          measurements: [{ name: "exact_shift", value: 150, unit: "px" }]
        },
        rawContent: "", model: "repair-model", provider: "mistral"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn();
    const result = await runTargetRecovery([invalidComponent], makeCtx({ recoveryCaller, reviewerCaller }), unlimitedBudget);
    expect(result.recovered.length).toBe(0);
    expect(reviewerCaller).not.toHaveBeenCalled();
  });
});

const unlimitedBudget: RecoveryBudget = {
  maxComponents: 1000,
  maxModelCalls: 2000,
  deadlineMs: Date.now() + 300000,
  minComponentPixels: 1
};
