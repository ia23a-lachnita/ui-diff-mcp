import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeRunDebug, writeRunDebugArtifacts } from "../../src/debug/run-debug.js";
import type { RunDebugTrace } from "../../src/debug/run-debug.js";

describe("run debug trace", () => {
  it("summarizes audit, coverage, and recovery outcomes", () => {
    const trace: RunDebugTrace = {
      audit: [
        { pairId: "p1", targetLabel: "card", targetType: "card", criterion: "geometry", status: "auditor_no_diff", evidenceCount: 0, imageRoles: [], artifactPaths: [] },
        { pairId: "p1", targetLabel: "card", targetType: "card", criterion: "color_appearance", status: "reviewer_accepted", evidenceCount: 2, diffId: "d1", imageRoles: [], artifactPaths: [] },
        { pairId: "p2", targetLabel: "label", targetType: "text", criterion: "typography_content", status: "reviewer_rejected", evidenceCount: 1, imageRoles: [], artifactPaths: [] }
      ],
      coverage: [
        { componentId: "c1", componentBox: { x: 0, y: 0, width: 10, height: 10 }, pixelCount: 100, status: "covered_by_diff", coveringDiffId: "d1", coveringCriterion: "color_appearance", overlapRatio: 1 },
        { componentId: "c2", componentBox: { x: 20, y: 0, width: 10, height: 10 }, pixelCount: 100, status: "uncovered" }
      ],
      recovery: [
        { componentId: "c2", rank: 0, componentBox: { x: 20, y: 0, width: 10, height: 10 }, pixelCount: 100, status: "classified_false", artifactPaths: [] }
      ],
      scopeAudit: [{ scopeId: "screen", scopeKind: "screen", scopeLabel: "Whole screen", criterion: "geometry", status: "reviewer_accepted", evidenceCount: 1, imageRoles: [], artifactPaths: [] }]
    };
    const summary = summarizeRunDebug(trace);
    expect(summary.auditPairs).toBe(2);
    expect(summary.auditNoDiff).toBe(1);
    expect(summary.auditAccepted).toBe(1);
    expect(summary.auditRejected).toBe(1);
    expect(summary.coverageUncovered).toBe(1);
    expect(summary.recoveryClassifiedFalse).toBe(1);
  });

  it("writes four debug artifact files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-debug-"));
    const result = await writeRunDebugArtifacts(dir, { audit: [], coverage: [], recovery: [], scopeAudit: [] });
    expect(result.artifacts.map(a => a.role).sort()).toEqual(["audit_trace", "coverage_trace", "debug_summary", "recovery_trace", "scope_audit_trace"]);
    await expect(fs.access(path.join(dir, "audit-trace.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "coverage-trace.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "recovery-trace.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "scope-audit-trace.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "debug-summary.json"))).resolves.toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("counts every retained reviewer escalation, including reviewer failures", () => {
    const base = {
      scopeId: "screen",
      scopeKind: "screen" as const,
      scopeLabel: "Whole screen",
      criterion: "geometry" as const,
      imageRoles: [],
      artifactPaths: []
    };
    const trace: RunDebugTrace = {
      audit: [],
      coverage: [],
      recovery: [],
      scopeAudit: [
        { ...base, status: "reviewer_error", evidenceCount: 2, diffId: "d-provider" },
        { ...base, status: "reviewer_identity_error", evidenceCount: 3, diffId: "d-identity" },
        { ...base, status: "reviewer_needs_escalation", evidenceCount: 1, diffId: "d-decision" },
        { ...base, status: "independent_reviewer_unavailable", evidenceCount: 1, diffId: "d-unavailable" }
      ]
    };
    const summary = summarizeRunDebug(trace);
    expect(summary.scopeAuditErrors).toBe(2);
    expect(summary.scopeAuditEscalated).toBe(4);
  });

  it("counts auditCriterionCalls excluding criterion_not_triggered", () => {
    const trace: RunDebugTrace = {
      audit: [
        { pairId: "p1", targetLabel: "btn", targetType: "button", criterion: "geometry", status: "criterion_not_triggered", evidenceCount: 0, imageRoles: [], artifactPaths: [] },
        { pairId: "p1", targetLabel: "btn", targetType: "button", criterion: "color_appearance", status: "auditor_no_diff", evidenceCount: 0, imageRoles: [], artifactPaths: [] },
        { pairId: "p1", targetLabel: "btn", targetType: "button", criterion: "presence", status: "reviewer_accepted", evidenceCount: 1, imageRoles: [], artifactPaths: [] }
      ],
      coverage: [],
      recovery: []
      ,scopeAudit: []
    };
    const summary = summarizeRunDebug(trace);
    expect(summary.auditCriterionCalls).toBe(2);
  });

  it("counts recovery errors for validation failure statuses", () => {
    const trace: RunDebugTrace = {
      audit: [],
      coverage: [],
      recovery: [
        { componentId: "c1", rank: 0, componentBox: { x: 0, y: 0, width: 10, height: 10 }, pixelCount: 100, status: "missing_required_fields", artifactPaths: [] },
        { componentId: "c2", rank: 1, componentBox: { x: 10, y: 0, width: 10, height: 10 }, pixelCount: 100, status: "box_out_of_bounds", artifactPaths: [] },
        { componentId: "c3", rank: 2, componentBox: { x: 20, y: 0, width: 10, height: 10 }, pixelCount: 100, status: "recovery_error", artifactPaths: [] }
      ],
      scopeAudit: []
    };
    const summary = summarizeRunDebug(trace);
    expect(summary.recoveryErrors).toBe(3);
    expect(summary.recoveryAttempted).toBe(3);
  });
});
