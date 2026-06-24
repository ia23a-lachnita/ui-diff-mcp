import { describe, expect, it } from "vitest";
import { runStage } from "../../src/pipeline/stages.js";
import { auditTraceHasFailure, deriveAuditStageOutcome, deriveRecoveryStageOutcome } from "../../src/pipeline/stages.js";

describe("runStage", () => {
  it("returns stage result with timing and data", async () => {
    const result = await runStage("test-stage", async () => ({ value: 42 }));
    expect(result.name).toBe("test-stage");
    expect(result.data).toEqual({ value: 42 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();
    expect(result.warnings).toEqual([]);
  });

  it("forwards provided warnings array", async () => {
    const result = await runStage("w", async () => null, ["warn-a"]);
    expect(result.warnings).toEqual(["warn-a"]);
  });

  it("propagates rejections from fn", async () => {
    await expect(
      runStage("fail", async () => { throw new Error("boom"); })
    ).rejects.toThrow("boom");
  });
});

describe("semantic stage outcomes", () => {
  it("treats a reviewer provider error as an audit-pair failure", () => {
    expect(auditTraceHasFailure([
      { status: "reviewer_error" }
    ])).toBe(true);
  });

  it("does not treat accepted, rejected, or no-diff decisions as failures", () => {
    expect(auditTraceHasFailure([
      { status: "reviewer_accepted" },
      { status: "reviewer_rejected" },
      { status: "auditor_no_diff" }
    ])).toBe(false);
  });

  it("marks audit route exhaustion incomplete even though the stage returned", () => {
    expect(deriveAuditStageOutcome({
      auditedPairs: 2,
      totalPairs: 10,
      auditLimited: false,
      failedPairs: 1,
      remainingPairs: 8,
      stoppedReason: "route_exhausted"
    })).toEqual({ outcome: "incomplete", detail: "route_exhausted" });
  });

  it("marks deadline-limited recovery incomplete", () => {
    expect(deriveRecoveryStageOutcome({
      totalUncoveredComponents: 5,
      eligibleComponents: 5,
      completedComponents: 2,
      remainingComponents: 3,
      batchCount: 1,
      attemptedComponents: 2,
      skippedComponents: 3,
      recoveredDiffs: 0,
      unclassifiedCount: 3,
      stoppedReason: "deadline_exceeded",
      statusCounts: {}
    })).toEqual({ outcome: "incomplete", detail: "deadline_exceeded" });
  });

  it("marks missing recovery caller unavailable", () => {
    expect(deriveRecoveryStageOutcome({
      totalUncoveredComponents: 2,
      eligibleComponents: 2,
      completedComponents: 0,
      remainingComponents: 2,
      batchCount: 0,
      attemptedComponents: 0,
      skippedComponents: 2,
      recoveredDiffs: 0,
      unclassifiedCount: 2,
      stoppedReason: "caller_unavailable",
      statusCounts: {}
    })).toEqual({ outcome: "unavailable", detail: "caller_unavailable" });
  });
});
