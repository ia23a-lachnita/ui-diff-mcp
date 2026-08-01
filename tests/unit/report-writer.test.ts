import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeReportCheckpoint, writeUiDiffReport } from "../../src/report/report-writer.js";
import { hydrateReportParts, slimReportForParts } from "../../src/report/report-parts.js";
import { UiDiffReportSchema, UnresolvedRegionSchema } from "../../src/schemas/core.js";
import type { UiDiffReport } from "../../src/schemas/core.js";
import { buildFindingGroups } from "../../src/report/context-overlays.js";
import { summarizeStructuralConsolidation, validateStructuralConsolidationLedger, type StructuralLedgerValidation } from "../../src/report/structural-invariants.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "report-writer-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeReport(overrides: Partial<UiDiffReport> = {}): UiDiffReport {
  const report: UiDiffReport = {
    schemaVersion: "0.1",
    runId: "run-test-1",
    createdAt: new Date().toISOString(),
    status: "incomplete",
    visualClassificationStatus: "incomplete",
    locatorCoverageStatus: "not_run",
    expectedImagePath: "expected.png",
    actualImagePath: "actual.png",
    artifactRoot: tmpDir,
    elements: { expected: [], actual: [] },
    pairs: [],
    diffs: [],
    broadEvidence: [],
    unresolvedRegions: [],
    modelHealth: [],
    runArtifacts: [],
    warnings: [],
    stages: [],
    comparisonSpace: {
      width: 200,
      height: 400,
      actualResizeMode: "contain",
      sourceCropsPreserveOriginalPixels: true
    },
    structuralConsolidation: {
      status: "pass",
      candidateCount: 0,
      retainedCount: 0,
      suppressedCount: 0,
      broadExcludedCount: 0,
      violationCount: 0
    },
    structuralConsolidationDetail: {
      ledger: { candidates: [], decisions: [], retainedFindingIds: [], candidateTerminals: [], elementLineage: [] },
      validation: { status: "pass", violations: [] }
    },
    ...overrides
  };
  if (report.diffs.length > 0 && !Object.prototype.hasOwnProperty.call(overrides, "structuralConsolidationDetail")) {
    const validDetail = makeRetainedDetail(report);
    return {
      ...report,
      structuralConsolidation: validDetail.summary,
      structuralConsolidationDetail: { ledger: validDetail.ledger, validation: validDetail.validation }
    };
  }
  return report;
}

function makeFinalFinding(id = "diff-final") {
  return {
    id,
    criterion: "geometry" as const,
    severity: "medium" as const,
    title: "Local displacement",
    location: { x: 20, y: 40, width: 12, height: 12 },
    evidence: ["Local geometry differs."],
    measurements: [],
    artifactPaths: [],
    reviewerStatus: "accepted" as const
  };
}

function schemaValidation(validation: StructuralLedgerValidation) {
  return {
    status: validation.status,
    violations: validation.violations.map(violation => ({
      ...violation,
      affectedGroupIds: [...violation.affectedGroupIds],
      ...(violation.detail === undefined ? {} : { detail: { ...violation.detail } })
    }))
  };
}

function makeRetainedDetail(report: UiDiffReport, onlyFindingId?: string) {
  const findings = onlyFindingId === undefined ? report.diffs : report.diffs.filter(finding => finding.id === onlyFindingId);
  const findingIds = findings.map(finding => finding.id);
  const ledger = {
    candidates: findings.map(finding => ({ findingId: finding.id, criterion: finding.criterion, elementIds: [] })),
    decisions: [],
    retainedFindingIds: findingIds,
    candidateTerminals: findingIds.map(findingId => ({ candidateId: findingId, terminal: "retained" as const })),
    elementLineage: []
  };
  const groups = buildFindingGroups(report.diffs, { width: report.comparisonSpace!.width, height: report.comparisonSpace!.height })
    .map(group => ({ id: group.id, diffIds: [...group.diffIds] }));
  const validation = validateStructuralConsolidationLedger(ledger, { requireGroups: true, actualGroups: groups });
  return { ledger, validation: schemaValidation(validation), summary: summarizeStructuralConsolidation(ledger, validation) };
}

describe("writeReportCheckpoint", () => {
  it("writes a schema-valid report.json to artifactRoot", async () => {
    const report = makeReport();
    const reportPath = await writeReportCheckpoint(report);

    expect(reportPath).toBe(path.join(tmpDir, "report.json"));
    const written = JSON.parse(await fs.readFile(reportPath, "utf8"));
    expect(() => UiDiffReportSchema.parse(written)).not.toThrow();
  });

  it("persists structural consolidation as a dedicated part and hydrates the exact detail", async () => {
    const detail = {
      ledger: { candidates: [], decisions: [], retainedFindingIds: [], candidateTerminals: [], elementLineage: [] },
      validation: { status: "pass" as const, violations: [] }
    };
    const report = makeReport({
      structuralConsolidation: {
        status: "pass",
        candidateCount: 0,
        retainedCount: 0,
        suppressedCount: 0,
        broadExcludedCount: 0,
        violationCount: 0
      },
      structuralConsolidationDetail: detail
    });
    await writeUiDiffReport(report);
    const written = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(path.join(tmpDir, "report.json"), "utf8")));
    expect(written.structuralConsolidationDetail).toBeUndefined();
    expect(written.reportParts).toContainEqual({ role: "structural_consolidation", path: "parts/structural-consolidation.json" });
    const hydrated = await hydrateReportParts(written, path.join(tmpDir, "report.json"));
    expect(hydrated.structuralConsolidationDetail).toEqual(detail);
    await expect(fs.access(path.join(tmpDir, "parts", "structural-consolidation.json"))).resolves.toBeUndefined();
  });

  it("rejects a final report without structural detail before creating artifacts", async () => {
    const report = makeReport({ structuralConsolidationDetail: undefined });
    await expect(writeUiDiffReport(report)).rejects.toThrow(/structural consolidation detail/i);
    await expect(fs.access(path.join(tmpDir, "report.json"))).rejects.toThrow();
  });

  it("rejects forged structural validation or summary before writing", async () => {
    await expect(writeUiDiffReport(makeReport({
      structuralConsolidation: { ...makeReport().structuralConsolidation!, status: "fail", violationCount: 1 }
    }))).rejects.toThrow(/structural consolidation authenticity/i);
    await expect(writeUiDiffReport(makeReport({
      structuralConsolidationDetail: {
        ledger: { candidates: [], decisions: [], retainedFindingIds: [], candidateTerminals: [], elementLineage: [] },
        validation: { status: "fail", violations: [] }
      }
    }))).rejects.toThrow(/structural consolidation authenticity/i);
  });

  it("rejects forged structural detail or summary during hydration", async () => {
    await expect(hydrateReportParts(makeReport({ structuralConsolidationContract: "v1", structuralConsolidationDetail: undefined }), path.join(tmpDir, "missing-structural-report.json")))
      .rejects.toThrow(/missing structural part\/detail/i);

    const output = await writeUiDiffReport(makeReport());
    const compact = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(output.reportPath, "utf8")));
    const structuralPart = compact.reportParts?.find(part => part.role === "structural_consolidation");
    expect(structuralPart).toBeDefined();
    const structuralPath = path.resolve(path.dirname(output.reportPath), structuralPart!.path);
    await fs.writeFile(structuralPath, JSON.stringify({
      ledger: { candidates: [], decisions: [], retainedFindingIds: [], candidateTerminals: [], elementLineage: [] },
      validation: { status: "fail", violations: [] }
    }), "utf8");
    await expect(hydrateReportParts(compact, output.reportPath)).rejects.toThrow(/structural consolidation authenticity/i);

    const fresh = await writeUiDiffReport(makeReport());
    const forgedSummary = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(fresh.reportPath, "utf8")));
    forgedSummary.structuralConsolidation = { ...forgedSummary.structuralConsolidation!, status: "fail", violationCount: 1 };
    await expect(hydrateReportParts(forgedSummary, fresh.reportPath)).rejects.toThrow(/structural consolidation authenticity/i);
  });

  it("rejects duplicate report part roles and normalized paths at slim/hydrate boundaries", async () => {
    const duplicateRole = [
      { role: "elements" as const, path: "parts/elements.json" },
      { role: "elements" as const, path: "parts/elements-copy.json" }
    ];
    expect(() => slimReportForParts(makeReport(), duplicateRole)).toThrow(/duplicate report part role/i);
    const duplicatePath = [
      { role: "elements" as const, path: "parts/elements.json" },
      { role: "pairs" as const, path: "parts/./elements.json" }
    ];
    expect(() => slimReportForParts(makeReport(), duplicatePath)).toThrow(/duplicate report part path/i);
    await expect(hydrateReportParts(makeReport({ reportParts: duplicateRole }), path.join(tmpDir, "report.json"))).rejects.toThrow(/duplicate report part role/i);
  });

  it("creates artifactRoot directory if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "nested", "artifacts");
    const report = makeReport({ artifactRoot: nestedDir });
    await writeReportCheckpoint(report);

    const exists = await fs.access(path.join(nestedDir, "report.json")).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("writes atomically: final file exists after write", async () => {
    const report = makeReport({ status: "incomplete" });
    const reportPath = await writeReportCheckpoint(report);

    const tmpPath = `${reportPath}.tmp`;
    const tmpExists = await fs.access(tmpPath).then(() => true).catch(() => false);
    expect(tmpExists).toBe(false);

    const written = JSON.parse(await fs.readFile(reportPath, "utf8")) as { status: string };
    expect(written.status).toBe("running");
  });

  it("records stages in the written report", async () => {
    const report = makeReport({
      stages: [
        { name: "locator_pairing", status: "complete", outcome: "success", completedAt: new Date().toISOString() }
      ]
    });
    const reportPath = await writeReportCheckpoint(report);

    const written = JSON.parse(await fs.readFile(reportPath, "utf8")) as { stages: unknown[] };
    expect(written.stages).toHaveLength(1);
  });

  it("forces checkpoint reports to honest running state", async () => {
    const reportPath = await writeReportCheckpoint(makeReport({ status: "complete" }));
    const written = JSON.parse(await fs.readFile(reportPath, "utf8")) as { status: string; isCheckpoint?: boolean };
    expect(written.status).toBe("running");
    expect(written.isCheckpoint).toBe(true);
  });

  it("rejects checkpoint-shaped input in the final writer before creating artifacts", async () => {
    await expect(writeUiDiffReport(makeReport({ isCheckpoint: true }))).rejects.toThrow(/final writer|checkpoint/i);
    await expect(fs.access(path.join(tmpDir, "report.json"))).rejects.toThrow();
  });

  it("rejects impossible checkpoint and final status combinations during hydration", async () => {
    await expect(hydrateReportParts(makeReport({ isCheckpoint: true, status: "complete" }), path.join(tmpDir, "checkpoint.json")))
      .rejects.toThrow(/checkpoint status/i);
    await expect(hydrateReportParts(makeReport({ isCheckpoint: false, status: "running" }), path.join(tmpDir, "final.json")))
      .rejects.toThrow(/final report status/i);
  });

  it("rejects complete visual status when structural validation fails", async () => {
    const ledger = {
      candidates: [{ findingId: "orphan", criterion: "geometry" as const, elementIds: [] }],
      decisions: [],
      retainedFindingIds: [],
      candidateTerminals: [],
      elementLineage: []
    };
    const validation = validateStructuralConsolidationLedger(ledger, { requireGroups: true, actualGroups: [] });
    const summary = summarizeStructuralConsolidation(ledger, validation);
    await expect(writeUiDiffReport(makeReport({
      visualClassificationStatus: "complete",
      structuralConsolidation: summary,
      structuralConsolidationDetail: { ledger, validation: schemaValidation(validation) }
    }))).rejects.toThrow(/visual classification|structural consolidation/i);
  });

  it("normalizes old multipart reports without structural detail to not_evaluated", async () => {
    const legacy = makeReport({
      status: "complete",
      visualClassificationStatus: "complete",
      structuralConsolidation: { status: "fail", candidateCount: 2, retainedCount: 1, suppressedCount: 1, broadExcludedCount: 0, violationCount: 1 },
      structuralConsolidationDetail: undefined,
      reportParts: [{ role: "unresolved_regions", path: "parts/unresolved-regions.json" }]
    });
    const readFile = async () => Buffer.from(JSON.stringify({ unresolvedRegions: [] }));
    const hydrated = await hydrateReportParts(legacy, path.join(tmpDir, "legacy.json"), readFile);
    expect(hydrated.structuralConsolidation).toMatchObject({ status: "not_evaluated" });
    expect(hydrated.structuralConsolidationDetail).toBeUndefined();
  });

  it("rejects a forged empty passing ledger when final diffs exist at write and hydrate", async () => {
    const finding = makeFinalFinding();
    const report = makeReport({
      diffs: [finding],
      structuralConsolidation: {
        status: "pass",
        candidateCount: 0,
        retainedCount: 0,
        suppressedCount: 0,
        broadExcludedCount: 0,
        violationCount: 0
      },
      structuralConsolidationDetail: {
        ledger: { candidates: [], decisions: [], retainedFindingIds: [], candidateTerminals: [], elementLineage: [] },
        validation: { status: "pass", violations: [] }
      }
    });
    await expect(writeUiDiffReport(report)).rejects.toThrow(/final finding|structural consolidation authenticity/i);

    const validDetail = makeRetainedDetail(report, finding.id);
    const validReport = makeReport({
      diffs: [finding],
      structuralConsolidation: validDetail.summary,
      structuralConsolidationDetail: { ledger: validDetail.ledger, validation: validDetail.validation }
    });
    const output = await writeUiDiffReport(validReport);
    const compact = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(output.reportPath, "utf8")));
    const structuralPart = compact.reportParts?.find(part => part.role === "structural_consolidation");
    expect(structuralPart).toBeDefined();
    await fs.writeFile(path.resolve(path.dirname(output.reportPath), structuralPart!.path), JSON.stringify({
      ledger: { candidates: [], decisions: [], retainedFindingIds: [], candidateTerminals: [], elementLineage: [] },
      validation: { status: "pass", violations: [] }
    }), "utf8");
    await expect(hydrateReportParts(compact, output.reportPath)).rejects.toThrow(/structural consolidation authenticity/i);
  });
});

describe("writeUiDiffReport", () => {
  it("counts final findings separately from unresolved regions", async () => {
    const report = makeReport({
      diffs: [{
        id: "diff-1",
        criterion: "geometry",
        severity: "medium",
        title: "Chart marker is displaced",
        location: { x: 20, y: 40, width: 12, height: 12 },
        evidence: ["Marker does not align with its expected position."],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "accepted"
      }],
      unresolvedRegions: [
        {
          id: "region-1",
          location: { x: 1, y: 2, width: 10, height: 11 },
          pixelCount: 45,
          sourceComponentIds: ["component-1"],
          relatedFindingIds: [],
          relation: "none",
          reason: "not_classified",
          artifactPaths: []
        },
        {
          id: "region-2",
          location: { x: 30, y: 40, width: 20, height: 10 },
          pixelCount: 80,
          sourceComponentIds: ["component-2", "component-3"],
          relatedFindingIds: [],
          relation: "none",
          reason: "recovery_budget_exhausted",
          artifactPaths: []
        }
      ]
    });

    const output = await writeUiDiffReport(report);

    expect(output.diffCount).toBe(1);
    expect(output.unresolvedRegionCount).toBe(2);
    const written = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(output.reportPath, "utf8")));
    expect(written.diffs).toHaveLength(0);
    expect(written.unresolvedRegions).toHaveLength(0);
    const hydrated = await hydrateReportParts(written, output.reportPath);
    expect(hydrated.diffs).toHaveLength(1);
    expect(hydrated.unresolvedRegions).toHaveLength(2);
  });

  it("externalizes broad semantic evidence and hydrates typed references", async () => {
    const finalDiff = {
      id: "diff-final",
      criterion: "geometry" as const,
      severity: "medium" as const,
      title: "Local displacement",
      location: { x: 20, y: 40, width: 12, height: 12 },
      evidence: ["Local geometry differs."],
      measurements: [],
      artifactPaths: [],
      reviewerStatus: "accepted" as const
    };
    const broadEvidence = {
      ...finalDiff,
      id: "broad-screen",
      title: "Screen-level displacement",
      location: { x: 0, y: 0, width: 200, height: 400 },
      classificationSource: "vlm_reviewed" as const,
      repairLocality: "broad" as const
    };
    const report = makeReport({
      diffs: [finalDiff],
      broadEvidence: [broadEvidence],
      unresolvedRegions: [{
        id: "region-1",
        location: { x: 1, y: 2, width: 3, height: 20 },
        pixelCount: 60,
        sourceComponentIds: ["component-1"],
        relatedFindingIds: ["diff-final"],
        relatedBroadEvidenceIds: ["broad-screen"],
        relation: "inside_larger_finding",
        reason: "deferred_broad_evidence_fragment",
        artifactPaths: []
      }]
    });

    const output = await writeUiDiffReport(report);
    const written = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(output.reportPath, "utf8")));
    expect(written.broadEvidence).toEqual([]);
    expect(written.reportParts?.map(part => part.role)).toContain("broad_evidence");

    const hydrated = await hydrateReportParts(written, output.reportPath);
    expect(hydrated.broadEvidence?.map(entry => entry.id)).toEqual(["broad-screen"]);
    expect(hydrated.unresolvedRegions[0]).toMatchObject({
      relatedFindingIds: ["diff-final"],
      relatedBroadEvidenceIds: ["broad-screen"]
    });
  });

  it("rejects dangling final and broad-evidence references", async () => {
    const unresolved = {
      id: "region-1",
      location: { x: 1, y: 2, width: 3, height: 20 },
      pixelCount: 60,
      sourceComponentIds: ["component-1"],
      relatedFindingIds: ["missing-final"],
      relatedBroadEvidenceIds: ["missing-broad"],
      relation: "nearby_larger_finding" as const,
      reason: "not_classified" as const,
      artifactPaths: []
    };

    await expect(writeUiDiffReport(makeReport({ unresolvedRegions: [unresolved] }))).rejects.toThrow(/dangling report reference/i);
  });

  it("rejects duplicate IDs inside final and broad-evidence namespaces", async () => {
    const finding = {
      id: "duplicate-id",
      criterion: "geometry" as const,
      severity: "medium" as const,
      title: "Duplicate finding",
      location: { x: 1, y: 2, width: 3, height: 4 },
      evidence: ["Duplicate evidence."],
      measurements: [],
      artifactPaths: [],
      reviewerStatus: "accepted" as const
    };

    await expect(writeUiDiffReport(makeReport({ diffs: [finding, finding] }))).rejects.toThrow(/duplicate final finding id/i);
    await expect(writeUiDiffReport(makeReport({ broadEvidence: [finding, finding] }))).rejects.toThrow(/duplicate broad evidence id/i);
  });

  it("rejects dangling references introduced by a tampered report part", async () => {
    const broadEvidence = {
      id: "broad-screen",
      criterion: "geometry" as const,
      severity: "medium" as const,
      title: "Screen-level displacement",
      location: { x: 0, y: 0, width: 200, height: 400 },
      evidence: ["Screen-level geometry differs."],
      measurements: [],
      artifactPaths: [],
      reviewerStatus: "accepted" as const,
      classificationSource: "vlm_reviewed" as const,
      repairLocality: "broad" as const
    };
    const output = await writeUiDiffReport(makeReport({
      broadEvidence: [broadEvidence],
      unresolvedRegions: [{
        id: "region-1",
        location: { x: 1, y: 2, width: 3, height: 20 },
        pixelCount: 60,
        sourceComponentIds: ["component-1"],
        relatedFindingIds: [],
        relatedBroadEvidenceIds: ["broad-screen"],
        relation: "nearby_larger_finding",
        reason: "deferred_broad_evidence_fragment",
        artifactPaths: []
      }]
    }));
    const written = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(output.reportPath, "utf8")));
    const broadPart = written.reportParts?.find(part => part.role === "broad_evidence");
    expect(broadPart).toBeDefined();
    await fs.writeFile(path.resolve(path.dirname(output.reportPath), broadPart!.path), JSON.stringify({ broadEvidence: [] }), "utf8");

    await expect(hydrateReportParts(written, output.reportPath)).rejects.toThrow(/dangling report reference/i);
  });

  it("hydrates legacy multipart reports that predate the broad-evidence namespace", async () => {
    const legacyRegion = {
      id: "region-legacy",
      location: { x: 1, y: 2, width: 3, height: 20 },
      pixelCount: 60,
      sourceComponentIds: ["component-1"],
      relatedFindingIds: ["legacy-broad-id"],
      relation: "nearby_larger_finding" as const,
      reason: "broad_vlm_evidence" as const,
      artifactPaths: []
    };
    const legacy = makeReport({
      unresolvedRegions: [],
      structuralConsolidation: { status: "not_evaluated", candidateCount: 0, retainedCount: 0, suppressedCount: 0, broadExcludedCount: 0, violationCount: 0 },
      structuralConsolidationDetail: undefined,
      reportParts: [{ role: "unresolved_regions", path: "parts/unresolved-regions.json" }]
    });
    const readFile = async () => Buffer.from(JSON.stringify({ unresolvedRegions: [legacyRegion] }));

    await expect(hydrateReportParts(legacy, path.join(tmpDir, "report.json"), readFile)).resolves.toMatchObject({
      unresolvedRegions: [expect.objectContaining({ relatedFindingIds: ["legacy-broad-id"] })]
    });
  });

  it("writes large report sections as relative report parts", async () => {
    const report = makeReport({
      usageSummary: {
        calls: 1,
        successesWithUsage: 1,
        successesMissingUsage: 0,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        reasoningTokens: 0,
        missingUsageCalls: 0,
        totalOnlyUsageCalls: 0,
        errorCalls: 0,
        fallbackCalls: 0,
        routeExhaustedCount: 0,
        durationMs: 10,
        byPhase: {},
        byRole: {},
        byRoute: {}
      },
      debugSummary: {
        auditPairs: 0,
        auditCriterionCalls: 0,
        auditAccepted: 0,
        auditRejected: 0,
        auditNoDiff: 0,
        auditErrors: 0,
        coverageComponents: 0,
        coverageCovered: 0,
        coverageUncovered: 0,
        coverageBelowThreshold: 0,
        coverageResidualCovered: 0,
        coverageResidualNoise: 0,
        recoveryAttempted: 0,
        recoveryAccepted: 0,
        recoveryRejected: 0,
        recoveryClassifiedFalse: 0,
        recoveryErrors: 0,
        recoverySkipped: 0,
        scopeAuditCalls: 0,
        scopeAuditAccepted: 0,
        scopeAuditRejected: 0,
        scopeAuditNoDiff: 0,
        scopeAuditErrors: 0,
        scopeAuditEscalated: 0
      },
      diffSummary: {
        finalDiffCount: 0,
        unresolvedRegionCount: 0,
        bySeverity: {},
        byCriterion: {},
        byClassificationSource: {},
        scopeSummaries: []
      }
    });

    const output = await writeUiDiffReport(report);
    const written = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(output.reportPath, "utf8")));

    expect((written.reportParts ?? []).map(part => part.role)).toEqual(expect.arrayContaining([
      "elements",
      "pairs",
      "diffs",
      "broad_evidence",
      "unresolved_regions",
      "debug_summary",
      "usage_summary",
      "scope_summary"
    ]));
    expect((written.reportParts ?? []).every(part => !path.isAbsolute(part.path))).toBe(true);
    expect(written.elements.expected).toHaveLength(0);
    expect(written.pairs).toHaveLength(0);
    expect(written.diffs).toHaveLength(0);
    expect(written.debugSummary).toBeUndefined();
    expect(written.usageSummary).toBeUndefined();
    expect(written.diffSummary?.scopeSummaries).toEqual([]);
    await expect(fs.access(path.join(tmpDir, "parts", "usage-summary.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpDir, "parts", "elements.json"))).resolves.toBeUndefined();
  });

  it("rejects reviewer fields on unresolved regions", () => {
    const parsed = UnresolvedRegionSchema.safeParse({
      id: "region-1",
      location: { x: 1, y: 2, width: 10, height: 11 },
      pixelCount: 45,
      sourceComponentIds: ["component-1"],
      reason: "not_classified",
      artifactPaths: [],
      reviewerStatus: "accepted"
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.code === "unrecognized_keys")).toBe(true);
    }
  });
});
