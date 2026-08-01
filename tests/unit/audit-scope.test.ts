import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditScopeSummaries } from "../../src/audit/audit-scope.js";
import { UiArtifactSchema } from "../../src/schemas/core.js";
import type { ScopeDiffSummary } from "../../src/schemas/core.js";
import type { VisionJsonCaller } from "../../src/models/vision-json.js";
import { modelFamilyKey } from "../../src/models/model-registry.js";
import { makeFallbackVisionCaller } from "../../src/models/fallback-caller.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-scope-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writePng(name: string): Promise<string> {
  const out = path.join(tmpDir, name);
  await sharp({ create: { width: 20, height: 20, channels: 4, background: "#202020" } }).png().toFile(out);
  return out;
}

function makeSummary(criterion: ScopeDiffSummary["triggeredCriteria"][number] = "geometry"): ScopeDiffSummary {
  return {
    id: "screen",
    kind: "screen",
    label: "Whole screen",
    box: { x: 0, y: 0, width: 20, height: 20 },
    changedPixelPercent: 20,
    edgeChangedPercent: 5,
    triggeredCriteria: [criterion],
    measurements: []
  };
}

describe("auditScopeSummaries", () => {
  it("audits only triggered scope criteria and records scope metadata", async () => {
    const expectedPath = await writePng("expected.png");
    const actualPath = await writePng("actual.png");
    const overlayPath = await writePng("overlay.png");
    const maskPath = await writePng("mask.png");
    const summaries: ScopeDiffSummary[] = [{
      id: "screen",
      kind: "screen",
      label: "Whole screen",
      box: { x: 0, y: 0, width: 20, height: 20 },
      changedPixelPercent: 20,
      edgeChangedPercent: 5,
      triggeredCriteria: ["geometry"],
      measurements: [{ name: "changed_pixel_percent", value: 20, unit: "percent" }]
    }];
    const auditor: VisionJsonCaller = vi.fn(async () => ({
      parsed: {
        hasDiff: true,
        severity: "high",
        title: "Whole screen layout differs",
        evidence: ["Full-screen overlay shows a broad placement difference."]
      },
      rawContent: "{}",
      model: "mock-auditor",
      provider: "mock"
    }));
    const reviewer: VisionJsonCaller = vi.fn(async () => ({
      parsed: { decision: "accepted", reason: "Supported by overlay." },
      rawContent: "{}",
      model: "mock-reviewer",
      provider: "mock"
    }));

    const result = await auditScopeSummaries({
      summaries,
      diffScope: { kind: "screen" },
      expectedImagePath: expectedPath,
      actualImagePath: actualPath,
      directionalOverlayPath: overlayPath,
      pixelDiffMaskPath: maskPath,
      auditorCaller: auditor,
      reviewerResolver: () => ({
        caller: reviewer,
        routes: [{ provider: "mock", model: "mock-reviewer", familyKey: modelFamilyKey("mock-reviewer") }]
      })
    });

    expect(auditor).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(result.trace).toHaveLength(1);
    expect(result.summary).toMatchObject({ scopeAuditCalls: 1, scopeAuditAccepted: 1, scopeFailedAudits: 0 });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      criterion: "geometry",
      scopeId: "screen",
      scopeKind: "screen",
      scopeLabel: "Whole screen",
      classificationSource: "vlm_reviewed",
      reviewerStatus: "accepted"
    });
    const artifacts = result.accepted[0]?.artifactPaths ?? [];
    expect(artifacts).toEqual(expect.arrayContaining([
      { role: "expected_normalized", path: expectedPath },
      { role: "actual_comparison_space", path: actualPath },
      { role: "directional_overlay", path: overlayPath },
      { role: "pixel_diff_mask", path: maskPath }
    ]));
    expect(artifacts).toHaveLength(4);
    for (const artifact of artifacts) UiArtifactSchema.parse(artifact);
  });

  it("keeps rejected and no-diff outcomes distinct without fake records", async () => {
    const expectedPath = await writePng("expected-2.png");
    const actualPath = await writePng("actual-2.png");
    const overlayPath = await writePng("overlay-2.png");
    const maskPath = await writePng("mask-2.png");
    const summary: ScopeDiffSummary = {
      id: "screen",
      kind: "screen",
      label: "Whole screen",
      box: { x: 0, y: 0, width: 20, height: 20 },
      changedPixelPercent: 20,
      edgeChangedPercent: 5,
      triggeredCriteria: ["geometry", "color_appearance"],
      measurements: []
    };
    let calls = 0;
    const auditor: VisionJsonCaller = vi.fn(async () => {
      calls++;
      return calls === 1
        ? { parsed: { hasDiff: true, severity: "medium", title: "Unsupported claim", evidence: ["The overlay does not support this claim."] }, rawContent: "{}", model: "auditor", provider: "p" }
        : { parsed: { hasDiff: false }, rawContent: "{}", model: "auditor", provider: "p" };
    });
    const reviewer: VisionJsonCaller = vi.fn(async () => ({
      parsed: { decision: "rejected", reason: "Not visibly supported." },
      rawContent: "{}", model: "reviewer", provider: "q"
    }));
    const result = await auditScopeSummaries({
      summaries: [summary],
      diffScope: { kind: "screen" },
      expectedImagePath: expectedPath,
      actualImagePath: actualPath,
      directionalOverlayPath: overlayPath,
      pixelDiffMaskPath: maskPath,
      auditorCaller: auditor,
      reviewerResolver: () => ({ caller: reviewer, routes: [{ provider: "q", model: "reviewer", familyKey: modelFamilyKey("reviewer") }] })
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.trace.map(entry => entry.status)).toEqual(["reviewer_rejected", "auditor_no_diff"]);
    expect(result.summary).toMatchObject({ scopeAuditCalls: 2, scopeAuditRejected: 1, scopeAuditNoDiff: 1, scopeUnresolvedAudits: 0 });
    expect(result.rejected[0]?.pairId).toBeUndefined();
  });

  it("fails closed when no independent reviewer exists", async () => {
    const paths = await Promise.all([writePng("e-3.png"), writePng("a-3.png"), writePng("o-3.png"), writePng("m-3.png")]);
    const auditor: VisionJsonCaller = vi.fn(async () => ({
      parsed: { hasDiff: true, severity: "high", title: "Scope mismatch", evidence: ["A broad mismatch is visible."] },
      rawContent: "{}", model: "same-family-auditor", provider: "p"
    }));
    const reviewer = vi.fn();
    const result = await auditScopeSummaries({
      summaries: [{ id: "screen", kind: "screen", label: "Whole screen", box: { x: 0, y: 0, width: 20, height: 20 }, changedPixelPercent: 10, edgeChangedPercent: 1, triggeredCriteria: ["geometry"], measurements: [] }],
      diffScope: { kind: "screen" }, expectedImagePath: paths[0]!, actualImagePath: paths[1]!, directionalOverlayPath: paths[2]!, pixelDiffMaskPath: paths[3]!,
      auditorCaller: auditor,
      reviewerResolver: () => null
    });
    expect(reviewer).not.toHaveBeenCalled();
    expect(result.trace[0]?.status).toBe("independent_reviewer_unavailable");
    expect(result.accepted[0]?.reviewerStatus).toBe("needs_escalation");
    expect(result.summary.scopeUnresolvedAudits).toBe(1);
  });

  it("rejects undeclared and same-family reviewer identities after the call", async () => {
    const paths = await Promise.all([writePng("e-4.png"), writePng("a-4.png"), writePng("o-4.png"), writePng("m-4.png")]);
    const auditor: VisionJsonCaller = vi.fn(async () => ({ parsed: { hasDiff: true, severity: "high", evidence: ["Visible scope difference."] }, rawContent: "{}", model: "auditor-family", provider: "p" }));
    const reviewer: VisionJsonCaller = vi.fn(async () => ({ parsed: { decision: "accepted", reason: "Looks different." }, rawContent: "{}", model: "same-family-auditor", provider: "p" }));
    const result = await auditScopeSummaries({
      summaries: [{ id: "screen", kind: "screen", label: "Whole screen", box: { x: 0, y: 0, width: 20, height: 20 }, changedPixelPercent: 10, edgeChangedPercent: 1, triggeredCriteria: ["geometry"], measurements: [] }],
      diffScope: { kind: "screen" }, expectedImagePath: paths[0]!, actualImagePath: paths[1]!, directionalOverlayPath: paths[2]!, pixelDiffMaskPath: paths[3]!, auditorCaller: auditor,
      reviewerResolver: () => ({ caller: reviewer, routes: [{ provider: "q", model: "reviewer-family", familyKey: modelFamilyKey("reviewer-family") }] })
    });
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(result.trace[0]?.status).toBe("reviewer_identity_error");
    expect(result.accepted[0]?.reviewerStatus).toBe("needs_escalation");
    expect(result.summary.scopeAuditErrors).toBe(1);
  });

  it("resolves the reviewer from the actual successful auditor fallback route", async () => {
    const paths = await Promise.all([writePng("e-5.png"), writePng("a-5.png"), writePng("o-5.png"), writePng("m-5.png")]);
    const first = vi.fn(async () => { throw new Error("HTTP 429"); });
    const second = vi.fn(async () => ({ parsed: { hasDiff: true, severity: "medium", evidence: ["Fallback route found a visible mismatch."] }, rawContent: "{}", model: "wrong", provider: "wrong" }));
    const auditor = makeFallbackVisionCaller([
      { caller: first, provider: "p1", model: "auditor-one", phase: "audit" },
      { caller: second, provider: "p2", model: "auditor-two", phase: "audit" }
    ]);
    const reviewer = vi.fn(async () => ({ parsed: { decision: "accepted", reason: "Confirmed." }, rawContent: "{}", model: "reviewer-two", provider: "q" }));
    const resolver = vi.fn(() => ({ caller: reviewer, routes: [{ provider: "q", model: "reviewer-two", familyKey: modelFamilyKey("reviewer-two") }] }));
    const result = await auditScopeSummaries({
      summaries: [{ id: "screen", kind: "screen", label: "Whole screen", box: { x: 0, y: 0, width: 20, height: 20 }, changedPixelPercent: 10, edgeChangedPercent: 1, triggeredCriteria: ["geometry"], measurements: [] }],
      diffScope: { kind: "screen" }, expectedImagePath: paths[0]!, actualImagePath: paths[1]!, directionalOverlayPath: paths[2]!, pixelDiffMaskPath: paths[3]!, auditorCaller: auditor, reviewerResolver: resolver
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith("p2", "auditor-two");
    expect(result.trace[0]).toMatchObject({ auditorProvider: "p2", auditorModel: "auditor-two", reviewerProvider: "q" });
  });

  it.each([
    { name: "auditor provider error", kind: "auditor_provider", traceStatus: "auditor_error", evidenceCount: 0, accepted: 0, rejected: 0, failed: 1, errors: 1, unresolved: 0, escalated: 0 },
    { name: "auditor schema error", kind: "auditor_schema", traceStatus: "auditor_schema_error", evidenceCount: 0, accepted: 0, rejected: 0, failed: 1, errors: 1, unresolved: 0, escalated: 0 },
    { name: "auditor empty evidence", kind: "auditor_empty", traceStatus: "auditor_empty_evidence", evidenceCount: 0, accepted: 0, rejected: 0, failed: 1, errors: 1, unresolved: 0, escalated: 0 },
    { name: "reviewer provider error", kind: "reviewer_provider", traceStatus: "reviewer_error", evidenceCount: 1, accepted: 1, rejected: 0, failed: 1, errors: 1, unresolved: 0, escalated: 1 },
    { name: "reviewer schema error", kind: "reviewer_schema", traceStatus: "reviewer_error", evidenceCount: 1, accepted: 1, rejected: 0, failed: 1, errors: 1, unresolved: 0, escalated: 1 },
    { name: "reviewer identity error", kind: "reviewer_identity", traceStatus: "reviewer_identity_error", evidenceCount: 1, accepted: 1, rejected: 0, failed: 1, errors: 1, unresolved: 0, escalated: 1 },
    { name: "reviewer decision escalation", kind: "reviewer_escalation", traceStatus: "reviewer_needs_escalation", evidenceCount: 1, accepted: 1, rejected: 0, failed: 0, errors: 0, unresolved: 1, escalated: 1 },
    { name: "no independent reviewer", kind: "no_reviewer", traceStatus: "independent_reviewer_unavailable", evidenceCount: 1, accepted: 1, rejected: 0, failed: 0, errors: 0, unresolved: 1, escalated: 1 },
    { name: "accepted", kind: "accepted", traceStatus: "reviewer_accepted", evidenceCount: 1, accepted: 1, rejected: 0, failed: 0, errors: 0, unresolved: 0, escalated: 0 },
    { name: "rejected", kind: "rejected", traceStatus: "reviewer_rejected", evidenceCount: 1, accepted: 0, rejected: 1, failed: 0, errors: 0, unresolved: 0, escalated: 0 },
    { name: "auditor no diff", kind: "no_diff", traceStatus: "auditor_no_diff", evidenceCount: 0, accepted: 0, rejected: 0, failed: 0, errors: 0, unresolved: 0, escalated: 0 }
  ] as const)("keeps exact counters and records for $name", async testCase => {
    const paths = await Promise.all([
      writePng(`matrix-${testCase.kind}-expected.png`),
      writePng(`matrix-${testCase.kind}-actual.png`),
      writePng(`matrix-${testCase.kind}-overlay.png`),
      writePng(`matrix-${testCase.kind}-mask.png`)
    ]);
    const auditor: VisionJsonCaller = testCase.kind === "auditor_provider"
      ? vi.fn(async () => { throw new Error("auditor provider failed"); })
      : vi.fn(async () => {
        if (testCase.kind === "auditor_schema") return { parsed: {}, rawContent: "{}", model: "auditor", provider: "p" };
        if (testCase.kind === "auditor_empty") return { parsed: { hasDiff: true, severity: "medium", evidence: [] }, rawContent: "{}", model: "auditor", provider: "p" };
        if (testCase.kind === "no_diff") return { parsed: { hasDiff: false }, rawContent: "{}", model: "auditor", provider: "p" };
        return { parsed: { hasDiff: true, severity: "high", title: "Scope mismatch", evidence: ["Visible scope mismatch."] }, rawContent: "{}", model: "auditor", provider: "p" };
      });
    const reviewer: VisionJsonCaller = testCase.kind === "reviewer_provider"
      ? vi.fn(async () => { throw new Error("reviewer provider failed"); })
      : testCase.kind === "reviewer_schema"
        ? vi.fn(async () => ({ parsed: {}, rawContent: "{}", model: "reviewer", provider: "q" }))
        : testCase.kind === "reviewer_identity"
          ? vi.fn(async () => ({ parsed: { decision: "accepted", reason: "Claim" }, rawContent: "{}", model: "auditor", provider: "p" }))
          : vi.fn(async () => ({ parsed: { decision: testCase.kind === "rejected" ? "rejected" : testCase.kind === "reviewer_escalation" ? "needs_escalation" : "accepted", reason: "Decision." }, rawContent: "{}", model: "reviewer", provider: "q" }));
    const result = await auditScopeSummaries({
      summaries: [makeSummary()],
      diffScope: { kind: "screen" },
      expectedImagePath: paths[0]!, actualImagePath: paths[1]!, directionalOverlayPath: paths[2]!, pixelDiffMaskPath: paths[3]!,
      auditorCaller: auditor,
      reviewerResolver: testCase.kind === "no_reviewer" ? () => null : () => ({
        caller: reviewer,
        routes: [{ provider: "q", model: "reviewer", familyKey: modelFamilyKey("reviewer") }]
      })
    });
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]?.status).toBe(testCase.traceStatus);
    expect(result.trace[0]?.evidenceCount).toBe(testCase.evidenceCount);
    expect(result.accepted).toHaveLength(testCase.accepted);
    expect(result.rejected).toHaveLength(testCase.rejected);
    const records = [...result.accepted, ...result.rejected];
    expect(new Set(records.map(record => record.id)).size).toBe(records.length);
    expect(result.summary).toMatchObject({
      scopeAuditCalls: 1,
      scopeAuditAccepted: testCase.kind === "accepted" ? 1 : 0,
      scopeAuditRejected: testCase.kind === "rejected" ? 1 : 0,
      scopeAuditNoDiff: testCase.kind === "no_diff" ? 1 : 0,
      scopeFailedAudits: testCase.failed,
      scopeAuditErrors: testCase.errors,
      scopeUnresolvedAudits: testCase.unresolved,
      scopeAuditEscalated: testCase.escalated
    });
    if (records.length === 0) {
      expect(result.trace[0]?.diffId).toBeUndefined();
    } else {
      expect(result.trace[0]?.diffId).toBe(records[0]?.id);
    }
  });

  it("stops after one reviewer route exhaustion with one retained auditor-supported record", async () => {
    const paths = await Promise.all([writePng("reviewer-exhaust-e.png"), writePng("reviewer-exhaust-a.png"), writePng("reviewer-exhaust-o.png"), writePng("reviewer-exhaust-m.png")]);
    const reviewer = makeFallbackVisionCaller([{ caller: vi.fn(async () => { throw new Error("HTTP 429"); }), provider: "q", model: "reviewer", phase: "reviewer" }]);
    const result = await auditScopeSummaries({
      summaries: [makeSummary()],
      diffScope: { kind: "screen" }, expectedImagePath: paths[0]!, actualImagePath: paths[1]!, directionalOverlayPath: paths[2]!, pixelDiffMaskPath: paths[3]!,
      auditorCaller: vi.fn(async () => ({ parsed: { hasDiff: true, severity: "high", evidence: ["Visible mismatch."] }, rawContent: "{}", model: "auditor", provider: "p" })),
      reviewerResolver: () => ({ caller: reviewer, routes: [{ provider: "q", model: "reviewer", familyKey: modelFamilyKey("reviewer") }] })
    });
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({ status: "reviewer_error", diffId: expect.any(String) });
    expect(result.accepted).toHaveLength(1);
    expect(result.summary).toMatchObject({ stoppedReason: "route_exhausted", scopeAuditCalls: 1, scopeFailedAudits: 1, scopeAuditErrors: 1, scopeUnresolvedAudits: 0, scopeAuditEscalated: 1 });
    expect(result.trace[0]?.evidenceCount).toBe(1);
  });

  it("records permanent auditor exhaustion once and never throws or fabricates a pair", async () => {
    const paths = await Promise.all([writePng("e-6.png"), writePng("a-6.png"), writePng("o-6.png"), writePng("m-6.png")]);
    const auditor = makeFallbackVisionCaller([{ caller: vi.fn(async () => { throw new Error("HTTP 429"); }), provider: "p", model: "auditor", phase: "audit" }]);
    const result = await auditScopeSummaries({
      summaries: [{ id: "screen", kind: "screen", label: "Whole screen", box: { x: 0, y: 0, width: 20, height: 20 }, changedPixelPercent: 10, edgeChangedPercent: 1, triggeredCriteria: ["geometry", "color_appearance"], measurements: [] }],
      diffScope: { kind: "screen" }, expectedImagePath: paths[0]!, actualImagePath: paths[1]!, directionalOverlayPath: paths[2]!, pixelDiffMaskPath: paths[3]!, auditorCaller: auditor, reviewerResolver: () => null
    });
    expect(result.summary.stoppedReason).toBe("route_exhausted");
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]?.status).toBe("auditor_error");
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.trace[0]?.diffId).toBeUndefined();
    expect(result.summary).toMatchObject({
      scopeAuditCalls: 1,
      scopeFailedAudits: 1,
      scopeAuditErrors: 1,
      scopeUnresolvedAudits: 0,
      scopeAuditEscalated: 0
    });
  });
});
