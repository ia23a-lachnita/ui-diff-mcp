import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hydrateReportParts } from "../../src/report/report-parts.js";
import { UiDiffReportSchema } from "../../src/schemas/core.js";
import type { InputProvenanceRequest, UiDiffReport } from "../../src/schemas/core.js";
import {
  createCalorixInputProvenance,
  resolveCalorixActualImage
} from "../helpers/calorix-device.js";
import { prepareCalorixLiveGate, type PreparedCalorixLiveGate } from "../helpers/calorix-live-gate.js";
import { startUiDiffMcpClient, waitForUiDiffRun } from "../helpers/mcp-client.js";

const calorixLive = process.env["RUN_CALORIX_UI_DIFF_LIVE"] === "1";
const calorixFullLive = process.env["RUN_CALORIX_FULL_LIVE"] === "1";
const calorixReleaseLive = process.env["RUN_CALORIX_RELEASE_LIVE"] === "1";
const calorixDeterministicLive = process.env["RUN_CALORIX_DETERMINISTIC_LIVE"] === "1";
const calorixLiveSuiteStartedAt = Date.now();

type UiDiffRunStatusOutput = {
  status: string;
  reportPath?: string;
  error?: string;
};

async function readHydratedReport(reportPath: string): Promise<UiDiffReport> {
  const rawReport = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(reportPath, "utf8")));
  return hydrateReportParts(rawReport, reportPath);
}

async function resolveCalorixGateImages(gate: PreparedCalorixLiveGate): Promise<{ expectedImagePath: string; actualImagePath: string; projectRoot: string; inputProvenance: InputProvenanceRequest }> {
  const actual = await resolveCalorixActualImage({ projectRoot: gate.projectRoot });
  await expect(fs.access(actual.actualImagePath), "actual screenshot must exist on disk").resolves.toBeUndefined();
  if (actual.source === "auto_capture") {
    expect(path.resolve(actual.actualImagePath).startsWith(path.resolve(gate.projectRoot, ".ui-diff", "captures") + path.sep),
      "default Calorix live gate must capture actual screenshots into .ui-diff/captures").toBe(true);
    const stat = await fs.stat(actual.actualImagePath);
    expect(stat.mtimeMs, "auto-captured actual screenshot must be from this live test process").toBeGreaterThanOrEqual(calorixLiveSuiteStartedAt);
  } else {
    console.warn(`[EXPLICIT ACTUAL OVERRIDE] Using UI_DIFF_LIVE_ACTUAL_IMAGE=${actual.actualImagePath}; freshness is not guaranteed.`);
  }
  const inputProvenance = createCalorixInputProvenance(gate.expected, actual);
  console.info(`[calorix-input-provenance] expected=${gate.expected.expectedImagePath} actualSource=${inputProvenance.acquisition?.actual.source}`);
  return { expectedImagePath: gate.expected.expectedImagePath, actualImagePath: actual.actualImagePath, projectRoot: gate.projectRoot, inputProvenance };
}

function overlapRatio(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (width * height) / Math.min(a.width * a.height, b.width * b.height);
}

function assertFinalFindingIntegrity(report: UiDiffReport): void {
  expect(report.diffs.every(diff => diff.criterion !== "unclassified_visual_change"), "raw/unclassified regions must never be final findings").toBe(true);
  const projectedRoles = ["projected_expected_crop", "projected_actual_crop", "projected_directional_overlay", "projected_pixel_diff_mask"] as const;
  for (const diff of report.diffs.filter(item => item.classificationSource === "deterministic_projected_mismatch")) {
    expect(diff.reviewerStatus, `deterministic diff ${diff.id} must not imply model review`).toBe("not_reviewed");
    const artifactRoles = new Set(diff.artifactPaths.map(artifact => artifact.role));
    for (const requiredRole of projectedRoles) {
      expect(artifactRoles.has(requiredRole), `projected diff ${diff.id} must have ${requiredRole}`).toBe(true);
    }
  }
  const grouped = report.diffs.filter(diff => diff.findingGroupId !== undefined);
  expect(new Set(grouped.map(diff => diff.findingGroupId)).size, "each displacement group must appear once in final findings").toBe(grouped.length);
  const groupRoles = [
    "projected_group_expected_crop",
    "projected_group_actual_crop",
    "projected_group_directional_overlay",
    "projected_group_pixel_diff_mask"
  ] as const;
  for (const diff of grouped) {
    const roles = new Set(diff.artifactPaths.map(artifact => artifact.role));
    for (const role of groupRoles) expect(roles.has(role), `grouped diff ${diff.id} must have ${role}`).toBe(true);
  }
  expect(report.recoverySummary?.statusCounts["skipped_component_cap"] ?? 0, "component batch size must never become a terminal skip").toBe(0);
  const childIds = report.diffs.flatMap(diff => diff.childFindingIds ?? []);
  expect(new Set(childIds).size, "consolidated child finding IDs must be globally unique").toBe(childIds.length);
  for (let i = 0; i < report.diffs.length; i++) {
    for (let j = i + 1; j < report.diffs.length; j++) {
      const a = report.diffs[i]!;
      const b = report.diffs[j]!;
      const sharedTarget = (a.targetIds ?? []).some(id => (b.targetIds ?? []).includes(id));
      expect(sharedTarget && a.criterion === b.criterion && overlapRatio(a.location, b.location) >= 0.7,
        `duplicate final findings ${a.id} and ${b.id} share target, criterion, and location`).toBe(false);
    }
  }
}

function assertNoSplitDisplacementConsensus(report: UiDiffReport): void {
  const elementMap = new Map(report.elements.expected.map(element => [element.id, element]));
  const ancestors = (diff: UiDiffReport["diffs"][number]): Set<string> => {
    const result = new Set<string>();
    for (const targetId of diff.targetIds ?? []) {
      let element = elementMap.get(targetId);
      const visited = new Set<string>();
      while (element && !visited.has(element.id)) {
        visited.add(element.id);
        result.add(element.id);
        element = element.parentId ? elementMap.get(element.parentId) : undefined;
      }
    }
    return result;
  };
  const shifted = report.diffs.flatMap(diff => {
    const dx = diff.measurements.find(measurement => measurement.name === "horizontal_shift")?.value;
    const dy = diff.measurements.find(measurement => measurement.name === "vertical_shift")?.value;
    return typeof dx === "number" && typeof dy === "number" ? [{ diff, dx, dy, ancestors: ancestors(diff) }] : [];
  });
  const width = report.comparisonSpace?.width ?? report.imageNormalization?.actual.source.width ?? 1000;
  const tolerance = Math.max(8, width * 0.015);
  for (let leftIndex = 0; leftIndex < shifted.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < shifted.length; rightIndex++) {
      const left = shifted[leftIndex]!;
      const right = shifted[rightIndex]!;
      const sharedAncestor = [...left.ancestors].some(id => right.ancestors.has(id));
      const sameVector = Math.hypot(left.dx - right.dx, left.dy - right.dy) <= tolerance;
      expect(sharedAncestor && sameVector,
        `same-vector findings ${left.diff.id} and ${right.diff.id} share an ancestor but were not consolidated`).toBe(false);
    }
  }
}

describe.skipIf(!calorixDeterministicLive)("Calorix deterministic pipeline quality gate", () => {
  let gate: PreparedCalorixLiveGate | undefined;

  beforeAll(async () => {
    gate = await prepareCalorixLiveGate();
  }, 130000);

  afterAll(() => { gate?.sidecarHandle.close(); });

  test("consolidates large projected displacement without model providers", async () => {
    const { expectedImagePath, actualImagePath, projectRoot, inputProvenance } = await resolveCalorixGateImages(gate!);
    const started = await startUiDiffMcpClient({
      LOCATEANYTHING_TIMEOUT_MS: "600000",
      UI_DIFF_DETERMINISTIC_LOCATOR: "1"
    });
    try {
      const startResult = await started.client.callTool({
        name: "start_ui_diff_run",
        arguments: { expectedImagePath, actualImagePath, projectRoot, mode: "deterministic_only", inputProvenance }
      }, undefined, { timeout: 600000 });
      expect(startResult.isError, `start_ui_diff_run failed: ${JSON.stringify(startResult)}`).not.toBe(true);
      const { runId } = startResult.structuredContent as { runId: string };
      let statusOut: { status: string; reportPath?: string } | undefined;
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const statusResult = await started.client.callTool({ name: "get_ui_diff_run_status", arguments: { projectRoot, runId } }, undefined, { timeout: 600000 });
        statusOut = statusResult.structuredContent as { status: string; reportPath?: string };
        if (statusOut.status !== "running") break;
      }
      expect(statusOut?.status, `deterministic gate must terminate; child=${JSON.stringify(started.getDiagnostics())}`).not.toBe("running");
      expect(statusOut?.reportPath).toBeTruthy();
      const report = await readHydratedReport(statusOut!.reportPath!);
      expect(report.inputProvenance?.acquisition).toEqual(inputProvenance.acquisition);
      assertFinalFindingIntegrity(report);
      assertNoSplitDisplacementConsensus(report);
      const groupCount = (report.projectedPreAudit?.displacementGroups ?? 0) + (report.projectedPreAudit?.structuralMismatchGroups ?? 0);
      expect(groupCount, "baseline contains at least two grouped projected-mismatch UI areas").toBeGreaterThanOrEqual(2);
      expect(report.projectedPreAudit?.groupedPairs ?? 0, "baseline eight fragments must become grouped mismatch evidence").toBeGreaterThanOrEqual(8);
      console.info(`[calorix-deterministic] run=${report.runId} displacementGroups=${report.projectedPreAudit?.displacementGroups ?? 0} structuralGroups=${report.projectedPreAudit?.structuralMismatchGroups ?? 0} groupedPairs=${report.projectedPreAudit?.groupedPairs ?? 0} finalDiffs=${report.diffs.length} unresolved=${report.unresolvedRegions.length}`);
    } finally {
      await started.close();
    }
  }, 1200000);
});

describe.skipIf(!calorixLive)("Calorix live UI diff smoke", () => {
  let gate: PreparedCalorixLiveGate | undefined;

  beforeAll(async () => {
    gate = await prepareCalorixLiveGate();
  }, 130000);

  afterAll(() => { gate?.sidecarHandle.close(); });

  test("runs configured Calorix image pair through start_ui_diff_run (async handle)", async () => {
    const { expectedImagePath, actualImagePath, projectRoot, inputProvenance } = await resolveCalorixGateImages(gate!);
    expect(process.env["LOCATEANYTHING_SIDECAR_URL"], "LOCATEANYTHING_SIDECAR_URL must be set").toBeTruthy();

    await expect(fs.access(projectRoot)).resolves.toBeUndefined();

    // 10-min locator timeout for large phone screenshots (1200+ px tall).
    // No UI_DIFF_DUAL_LOCATOR: projection is the required default for release gates.
    const started = await startUiDiffMcpClient({ LOCATEANYTHING_TIMEOUT_MS: "600000" });
    try {
      const startResult = await started.client.callTool({
        name: "start_ui_diff_run",
        arguments: { expectedImagePath, actualImagePath, projectRoot, mode: "free", inputProvenance }
      }, undefined, { timeout: 600000 });
      expect(startResult.isError).not.toBe(true);
      const { runId } = startResult.structuredContent as { runId: string };
      expect(runId).toBeTruthy();

      const statusOut = await waitForUiDiffRun(started, {
        projectRoot,
        runId,
        maxWaitMs: 20 * 60_000,
        intervalMs: 10_000,
        callTimeoutMs: 600_000
      }) as UiDiffRunStatusOutput;
      expect(statusOut.status, `run must complete, got: ${statusOut.status}; error=${statusOut.error ?? "none"}; child=${JSON.stringify(started.getDiagnostics())}`).toBe("complete");
      expect(statusOut.reportPath).toBeTruthy();

      const report = await readHydratedReport(statusOut.reportPath!);
      expect(report.inputProvenance?.acquisition).toEqual(inputProvenance.acquisition);
      started.recordRunStatus(report.status);
      expect(path.resolve(statusOut.reportPath!).includes(`${path.sep}.ui-diff${path.sep}runs${path.sep}`)).toBe(true);

      // Locator must have found elements with adequate coverage — weak or failed is a gate failure
      expect(report.locatorCoverageStatus, "locator coverage must not be weak or failed").not.toMatch(/^(failed|weak)$/);
      expect(report.elements.expected.length, "locator must find elements in expected image").toBeGreaterThan(0);
      expect(report.elements.actual.length, "locator must find elements in actual image").toBeGreaterThan(0);

      // Bounded smoke: audit was limited by UI_DIFF_MAX_AUDIT_PAIRS; classification is expected
      // incomplete because recovery cannot cover all uncovered components in a 3-pair bounded run.
      // The full gate (verify:calorix-full-live) accepts incomplete-with-route_exhausted as a degraded diagnostic pass.
      expect(report.auditScope?.auditLimited, "bounded smoke gate: audit must be limited by UI_DIFF_MAX_AUDIT_PAIRS").toBe(true);
      expect(report.visualClassificationStatus, "classification expected incomplete when auditLimited").toBe("incomplete");

      // There must be paired targets available for audit
      expect(report.auditScope?.totalPairs ?? 0, "at least one element pair must be available for audit").toBeGreaterThan(0);

      // Pre-audit summary must be present — confirms the projection pre-audit stage ran
      expect(report.projectedPreAudit, "projectedPreAudit summary must be present").toBeDefined();

      // At least one pair must have reached the VLM auditor. If vlmAuditedPairs=0 it means all
      // bounded slots were consumed by deterministic pre-audit (the exact June-20 failure mode).
      const vlmAuditedBounded = report.auditScope?.vlmAuditedPairs ?? report.auditScope?.auditedPairs ?? 0;
      expect(vlmAuditedBounded, "bounded smoke must have at least one VLM-audited pair — all-pre-audit means projection short-circuited the budget").toBeGreaterThan(0);

      // The bounded smoke gate does not require VLM-reviewed diffs — 3 pairs may yield none.
      // The full gate (verify:calorix-full-live) asserts at least one VLM-reviewed diff.
      expect(report.diffs.length, "at least one diff must be reported").toBeGreaterThan(0);

      // Projection mode: expected locator must be complete; actual is projected (not independently located).
      expect(report.locatorMetadata?.expected?.status, "expected image locator coverage must be complete").toBe("complete");
      expect(report.locatorMetadata?.actual?.status, "actual image locator coverage must be projected in single-pass mode").toBe("projected");
      expect(report.locatorMetadata?.locatorActualMode, "locatorActualMode must be projected").toBe("projected");

      // Target-map artifacts must be written for both images
      expect(report.runArtifacts.some(a => a.role === "target_map_expected"), "target_map_expected artifact must be present").toBe(true);
      expect(report.runArtifacts.some(a => a.role === "target_map_actual"), "target_map_actual artifact must be present").toBe(true);

      // Debug insight artifacts must be present before Calorix sign-off
      expect(report.debugSummary, "debug summary must be written").toBeDefined();
      expect(report.runArtifacts.some(a => a.role === "audit_trace"), "audit trace artifact must exist").toBe(true);
      expect(report.runArtifacts.some(a => a.role === "coverage_trace"), "coverage trace artifact must exist").toBe(true);
      expect(report.runArtifacts.some(a => a.role === "recovery_trace"), "recovery trace artifact must exist").toBe(true);

      // Provider fallback gate: auditor and reviewer route lists must be recorded
      expect(report.modelSelection?.auditorRoutes, "auditorRoutes must be recorded").toBeDefined();
      expect((report.modelSelection?.auditorRoutes ?? []).length, "at least one auditor route must be in auditorRoutes").toBeGreaterThanOrEqual(1);
      expect(report.modelSelection?.reviewerRoutes, "reviewerRoutes must be recorded").toBeDefined();
      expect((report.modelSelection?.reviewerRoutes ?? []).length, "at least one reviewer route must be in reviewerRoutes").toBeGreaterThanOrEqual(1);

      // Provider trace artifact must be present and contain probe + runtime events
      expect(report.runArtifacts.some(a => a.role === "provider_trace"), "provider_trace artifact must exist").toBe(true);
      const ptPath = report.runArtifacts.find(a => a.role === "provider_trace")!.path;
      const ptEvents = JSON.parse(await fs.readFile(ptPath, "utf8")) as Array<{ event: string; phase: string; role: string; provider: string }>;
      expect(Array.isArray(ptEvents)).toBe(true);
      expect(ptEvents.some(e => e.event === "probe_result"), "provider trace must contain probe_result events").toBe(true);
      expect(ptEvents.some(e => e.phase === "audit" && e.event === "call_start"), "provider trace must contain audit call_start events").toBe(true);

      // If OpenRouter fallback fires, auditor OR routes must include a different-family model, not only nemotron:free
      const auditorOrRoutes = (report.modelSelection?.auditorRoutes ?? []).filter(r => r.provider === "openrouter");
      if (auditorOrRoutes.length > 1) {
        const families = new Set(auditorOrRoutes.map(r => r.model.replace(/:(?:free|beta|nitro|\d{8})$/i, "")));
        console.info(`[calorix-bounded] OpenRouter auditor families: ${[...families].join(", ")}`);
      }

      // In free mode, any actual runtime NVIDIA→OpenRouter fallback must be in provider trace
      const runtimeFallbackWarnings = report.warnings.filter(w => /\[provider-fallback\].*switched from/i.test(w));
      if (runtimeFallbackWarnings.length > 0) {
        console.info(`[calorix-bounded] Runtime fallback warnings (${runtimeFallbackWarnings.length}): ${runtimeFallbackWarnings.join("; ")}`);
        expect(ptEvents.some(e => e.event === "fallback"), "trace must contain fallback event when runtime fallback warning is present").toBe(true);
      }
    } finally {
      await started.close();
    }
  }, 1200000);
});

describe.skipIf(!calorixFullLive)("verify:calorix-full-live unbounded all-target audit", () => {
  let gate: PreparedCalorixLiveGate | undefined;

  beforeAll(async () => {
    gate = await prepareCalorixLiveGate();
  }, 130000);

  afterAll(() => { gate?.sidecarHandle.close(); });

  test("runs unbounded Calorix image pair — all pairs audited, no UI_DIFF_MAX_AUDIT_PAIRS limit", async () => {
    const { expectedImagePath, actualImagePath, projectRoot, inputProvenance } = await resolveCalorixGateImages(gate!);
    expect(process.env["LOCATEANYTHING_SIDECAR_URL"], "LOCATEANYTHING_SIDECAR_URL must be set").toBeTruthy();
    // Confirm UI_DIFF_MAX_AUDIT_PAIRS is not set so this is a genuine unbounded run
    expect(process.env["UI_DIFF_MAX_AUDIT_PAIRS"], "UI_DIFF_MAX_AUDIT_PAIRS must NOT be set for full audit").toBeUndefined();

    await expect(fs.access(projectRoot)).resolves.toBeUndefined();

    // 10-min locator timeout for large phone screenshots.
    // No UI_DIFF_DUAL_LOCATOR: projection is the required default for release gates.
    const started = await startUiDiffMcpClient({ LOCATEANYTHING_TIMEOUT_MS: "600000" });
    try {
      const startResult = await started.client.callTool({
        name: "start_ui_diff_run",
        arguments: { expectedImagePath, actualImagePath, projectRoot, mode: "free", inputProvenance }
      }, undefined, { timeout: 600000 });
      expect(startResult.isError).not.toBe(true);
      const { runId } = startResult.structuredContent as { runId: string };
      expect(runId).toBeTruthy();

      const statusOut = await waitForUiDiffRun(started, {
        projectRoot,
        runId,
        maxWaitMs: 40 * 60_000,
        intervalMs: 10_000,
        callTimeoutMs: 600_000
      }) as UiDiffRunStatusOutput;
      expect(statusOut.status, `run must complete, got: ${statusOut.status}; error=${statusOut.error ?? "none"}; child=${JSON.stringify(started.getDiagnostics())}`).toBe("complete");
      expect(statusOut.reportPath).toBeTruthy();

      const report = await readHydratedReport(statusOut.reportPath!);
      expect(report.inputProvenance?.acquisition).toEqual(inputProvenance.acquisition);
      started.recordRunStatus(report.status);
      expect(report.auditScope?.auditLimited ?? false).toBe(false);

      // Pair accounting: pre-audit and audit selection partition all pairs, while entered
      // and remaining partition selected work. Entered work is either provider-called or
      // deterministically skipped because no criterion triggered.
      if (report.auditScope?.totalPairs !== undefined) {
        const selectedFull = report.auditScope.selectedPairs ?? report.auditScope.auditedPairs;
        const preAuditDetFull = report.auditScope.preAuditDeterministicPairs ?? 0;
        expect(
          selectedFull + preAuditDetFull,
          "selectedPairs + preAuditDeterministicPairs must equal totalPairs"
        ).toBe(report.auditScope.totalPairs);
        expect(
          (report.auditScope.enteredPairs ?? 0) + (report.auditScope.remainingPairs ?? 0),
          "enteredPairs + remainingPairs must equal selectedPairs"
        ).toBe(selectedFull);
        expect(
          (report.auditScope.providerCalledPairs ?? 0) + (report.auditScope.skippedNoTriggeredPairs ?? 0),
          "providerCalledPairs + skippedNoTriggeredPairs must equal enteredPairs"
        ).toBe(report.auditScope.enteredPairs ?? 0);
      }

      // All accepted diffs must have classificationSource — no untagged diffs allowed
      const untaggedFullDiffs = report.diffs.filter(d => d.reviewerStatus === "accepted" && !d.classificationSource);
      expect(
        untaggedFullDiffs.length,
        "all accepted diffs must have classificationSource"
      ).toBe(0);
      assertFinalFindingIntegrity(report);

      // Locator must have found elements with adequate coverage — weak or failed is a gate failure
      expect(report.locatorCoverageStatus, "locator coverage must not be weak or failed").not.toMatch(/^(failed|weak)$/);
      expect(report.elements.expected.length, "locator must find elements in expected image").toBeGreaterThan(0);
      expect(report.elements.actual.length, "locator must find elements in actual image").toBeGreaterThan(0);
      expect(report.auditScope?.totalPairs ?? 0, "at least one element pair must be available for audit").toBeGreaterThan(0);

      // Incomplete classification is allowed only as a diagnostic pass with provider evidence.
      // It always blocks production release, even when the trace explains the failure.
      if (report.visualClassificationStatus === "incomplete") {
        console.warn(
          "[DEGRADED PASS] visualClassificationStatus is incomplete — inspect auditScope, recoverySummary, and provider trace." +
          " Production release is BLOCKED until full classification completes."
        );
        const ptFullPath = report.runArtifacts.find(a => a.role === "provider_trace")?.path;
        expect(ptFullPath, "incomplete classification must include a provider trace").toBeTruthy();
        const ptFull = JSON.parse(await fs.readFile(ptFullPath!, "utf8")) as Array<{ event: string; role: string }>;
        if (report.auditScope?.stoppedReason === "route_exhausted") {
          expect(ptFull.some(e => e.event === "route_exhausted" && e.role === "auditor"),
            "audit route exhaustion must have a matching auditor event in provider trace").toBe(true);
        }
        if (report.recoverySummary?.stoppedReason && report.recoverySummary.stoppedReason !== "none") {
          expect(report.unresolvedRegions.length,
            `recovery stopped with ${report.recoverySummary.stoppedReason}, so unresolved regions must remain`).toBeGreaterThan(0);
        }
      }

      // At least one diff must be semantically classified by the auditor/reviewer or recovery model,
      // rather than all findings coming from deterministic checks.
      expect(report.diffs.length, "at least one diff must be reported").toBeGreaterThan(0);
      const modelClassifiedDiffs = report.diffs.filter(d =>
        d.classificationSource === "vlm_reviewed" || d.classificationSource === "target_recovery"
      );
      expect(modelClassifiedDiffs.length, "at least one diff must be model-classified (not deterministic-only)").toBeGreaterThan(0);

      // Projection mode: expected locator must be complete; actual is projected (not independently located).
      expect(report.locatorMetadata?.expected?.status, "expected image locator coverage must be complete").toBe("complete");
      expect(report.locatorMetadata?.actual?.status, "actual image locator coverage must be projected in single-pass mode").toBe("projected");
      expect(report.locatorMetadata?.locatorActualMode, "locatorActualMode must be projected").toBe("projected");

      // Target-map artifacts must be written for both images
      expect(report.runArtifacts.some(a => a.role === "target_map_expected"), "target_map_expected artifact must be present").toBe(true);
      expect(report.runArtifacts.some(a => a.role === "target_map_actual"), "target_map_actual artifact must be present").toBe(true);

      // Debug insight artifacts must be present before Calorix sign-off
      expect(report.debugSummary, "debug summary must be written").toBeDefined();
      expect(report.runArtifacts.some(a => a.role === "audit_trace"), "audit trace artifact must exist").toBe(true);
      expect(report.runArtifacts.some(a => a.role === "coverage_trace"), "coverage trace artifact must exist").toBe(true);
      expect(report.runArtifacts.some(a => a.role === "recovery_trace"), "recovery trace artifact must exist").toBe(true);
      expect(report.debugSummary?.auditPairs ?? 0).toBeGreaterThan(0);
      expect(report.debugSummary?.auditCriterionCalls ?? 0).toBeGreaterThan(0);
      expect(report.debugSummary?.coverageComponents ?? 0).toBeGreaterThan(0);

      // Provider fallback gate: auditor and reviewer route lists must be recorded
      expect(report.modelSelection?.auditorRoutes, "auditorRoutes must be recorded").toBeDefined();
      expect((report.modelSelection?.auditorRoutes ?? []).length, "at least one auditor route must be in auditorRoutes").toBeGreaterThanOrEqual(1);
      expect(report.modelSelection?.reviewerRoutes, "reviewerRoutes must be recorded").toBeDefined();
      expect((report.modelSelection?.reviewerRoutes ?? []).length, "at least one reviewer route must be in reviewerRoutes").toBeGreaterThanOrEqual(1);
      // targetRecoveryRoutes must be present when recovery was attempted
      if ((report.recoverySummary?.attemptedComponents ?? 0) > 0) {
        expect(report.modelSelection?.targetRecoveryRoutes, "targetRecoveryRoutes must be recorded when recovery ran").toBeDefined();
      }

      // Provider trace artifact must be present with probe and runtime call events
      expect(report.runArtifacts.some(a => a.role === "provider_trace"), "provider_trace artifact must exist").toBe(true);
      const ptPath = report.runArtifacts.find(a => a.role === "provider_trace")!.path;
      const ptEvents = JSON.parse(await fs.readFile(ptPath, "utf8")) as Array<{ event: string; phase: string; role: string; provider: string }>;
      expect(Array.isArray(ptEvents)).toBe(true);
      expect(ptEvents.some(e => e.event === "probe_result"), "provider trace must contain probe_result events").toBe(true);
      expect(ptEvents.some(e => e.phase === "audit" && e.event === "call_start"), "provider trace must contain audit call_start events").toBe(true);

      // Detect same-family fallback and log a diagnostic warning for reviewers
      const auditorOrRoutes = (report.modelSelection?.auditorRoutes ?? []).filter(r => r.provider === "openrouter");
      const auditorNvidiaRoutes = (report.modelSelection?.auditorRoutes ?? []).filter(r => r.provider === "nvidia");
      if (auditorOrRoutes.length > 0 && auditorNvidiaRoutes.length > 0) {
        const nvidiaFamilies = new Set(auditorNvidiaRoutes.map(r => r.model.replace(/:(?:free|beta|nitro|\d{8})$/i, "")));
        const sameFamilyRoutes = auditorOrRoutes.filter(r => nvidiaFamilies.has(r.model.replace(/:(?:free|beta|nitro|\d{8})$/i, "")));
        if (sameFamilyRoutes.length > 0) {
          console.warn(`[full-audit] Same-family OR fallback detected (provider changed, model did not): ${sameFamilyRoutes.map(r => r.model).join(", ")}`);
        }
      }

      // Any actual runtime NVIDIA→OpenRouter fallback must be in provider trace
      const runtimeFallbackWarnings = report.warnings.filter(w => /\[provider-fallback\].*switched from/i.test(w));
      if (runtimeFallbackWarnings.length > 0) {
        console.info(`[full-audit] Runtime fallback warnings (${runtimeFallbackWarnings.length}): ${runtimeFallbackWarnings.join("; ")}`);
        expect(ptEvents.some(e => e.event === "fallback"), "trace must contain fallback event when runtime fallback warning is present").toBe(true);
      }

      // Source-crop projection contract: original pixels must be preserved
      expect(
        report.comparisonSpace?.sourceCropsPreserveOriginalPixels,
        "sourceCropsPreserveOriginalPixels must be true — source crops must not be stretched to comparison space"
      ).toBe(true);

      // Provider diagnostics are required for provider-caused incompleteness. Budget/deadline
      // incompleteness is explained by recoverySummary and the stage outcome instead.
      const providerCausedIncomplete = report.auditScope?.stoppedReason === "route_exhausted" ||
        report.recoverySummary?.stoppedReason === "caller_unavailable";
      if (providerCausedIncomplete) {
        expect(
          report.providerDiagnosticsPresent,
          "providerDiagnosticsPresent must be true when a provider route caused incompleteness"
        ).toBe(true);
      }

      // Recovery summary: must be present when route_exhausted for target_recovery is in trace
      const ptPathForRecovery = report.runArtifacts.find(a => a.role === "provider_trace")?.path;
      if (ptPathForRecovery) {
        const ptForRecovery = JSON.parse(await fs.readFile(ptPathForRecovery, "utf8")) as Array<{ event: string; role: string }>;
        const hasRecoveryExhausted = ptForRecovery.some(e => e.event === "route_exhausted" && e.role === "target_recovery");
        if (hasRecoveryExhausted) {
          expect(report.recoverySummary, "recoverySummary must be present when route_exhausted for target_recovery is in trace").toBeDefined();
        }
      }

      // Deterministic projected mismatches must have projectionMismatchReason
      const projMismatches = report.diffs.filter(d => d.classificationSource === "deterministic_projected_mismatch");
      for (const diff of projMismatches) {
        expect(diff.projectionMismatchReason, `diff ${diff.id} must have projectionMismatchReason`).toBeDefined();
      }

      console.info(`[full-audit] visualClassificationStatus=${report.visualClassificationStatus}`);
      console.info(`[full-audit] auditedPairs=${report.auditScope?.auditedPairs ?? "n/a"}, totalPairs=${report.auditScope?.totalPairs ?? "n/a"}`);
      console.info(`[full-audit] diffs=${report.diffs.length}`);
      if (report.modelSelection) {
        console.info(`[full-audit] auditor=${report.modelSelection.auditor?.provider}/${report.modelSelection.auditor?.model}`);
        console.info(`[full-audit] reviewer=${report.modelSelection.reviewer?.provider}/${report.modelSelection.reviewer?.model}`);
      }
    } finally {
      await started.close();
    }
  }, 2400000);
});

describe.skipIf(!calorixReleaseLive)("Calorix release sign-off gate", () => {
  let gate: PreparedCalorixLiveGate | undefined;

  beforeAll(async () => {
    gate = await prepareCalorixLiveGate();
  }, 130000);

  afterAll(() => { gate?.sidecarHandle.close(); });

  test("production sign-off: complete classification, no viewport mismatch, audit not limited", async () => {
    const { expectedImagePath, actualImagePath, projectRoot, inputProvenance } = await resolveCalorixGateImages(gate!);
    expect(process.env["LOCATEANYTHING_SIDECAR_URL"], "LOCATEANYTHING_SIDECAR_URL must be set").toBeTruthy();

    await expect(fs.access(projectRoot)).resolves.toBeUndefined();

    const started = await startUiDiffMcpClient({ LOCATEANYTHING_TIMEOUT_MS: "600000" });
    try {
      const startResult = await started.client.callTool({
        name: "start_ui_diff_run",
        arguments: { expectedImagePath, actualImagePath, projectRoot, mode: "free", inputProvenance }
      }, undefined, { timeout: 600000 });
      expect(startResult.isError).not.toBe(true);
      const { runId } = startResult.structuredContent as { runId: string };

      const statusOut = await waitForUiDiffRun(started, {
        projectRoot,
        runId,
        maxWaitMs: 38 * 60_000,
        intervalMs: 10_000,
        callTimeoutMs: 600_000
      }) as UiDiffRunStatusOutput;
      expect(statusOut.status, `release gate requires complete status, got: ${statusOut.status}; error=${statusOut.error ?? "none"}; child=${JSON.stringify(started.getDiagnostics())}`).toBe("complete");

      const report = await readHydratedReport(statusOut.reportPath!);
      expect(report.inputProvenance?.acquisition).toEqual(inputProvenance.acquisition);
      started.recordRunStatus(report.status);

      expect(report.status, "release gate requires report status=complete").toBe("complete");
      expect(report.isCheckpoint, "release gate requires a durable final report, not a checkpoint").toBe(false);
      expect(
        report.visualClassificationStatus,
        "release gate requires complete visual classification; inspect audit and recovery stage outcomes for the exact blocker"
      ).toBe("complete");

      expect(
        report.auditScope?.auditLimited ?? false,
        "release gate requires auditLimited=false"
      ).toBe(false);

      expect(report.unresolvedRegions, "release gate requires zero unresolved canonical regions").toHaveLength(0);
      expect(report.auditScope?.stoppedReason ?? "none", "release gate must not have terminal route exhaustion").toBe("none");
      expect(report.auditScope?.remainingPairs ?? 0, "release gate requires zero remaining audit pairs").toBe(0);
      const selectedPairs = report.auditScope?.selectedPairs ?? report.auditScope?.auditedPairs ?? 0;
      const providerCalledPairs = report.auditScope?.providerCalledPairs ?? report.auditScope?.vlmAuditedPairs ?? 0;
      const skippedNoTrigger = report.auditScope?.skippedNoTriggeredPairs ?? 0;
      expect(providerCalledPairs + skippedNoTrigger, "every selected pair must be provider-called or deterministically skipped before call").toBe(selectedPairs);
      expect(report.auditScope?.failedPairs ?? 0, "release gate requires zero failed audit pairs").toBe(0);

      const stageMap = Object.fromEntries(report.stages.map(stage => [stage.name, stage]));
      expect(stageMap["model_probe"], "release gate requires a model_probe stage record").toBeDefined();
      expect(stageMap["model_probe"]?.outcome, "release gate requires successful model probes").toBe("success");
      expect(stageMap["audit"], "release gate requires an audit stage record").toBeDefined();
      expect(stageMap["audit"]?.outcome, "release gate requires a semantically complete audit").toBe("success");
      expect(stageMap["target_recovery"], "release gate requires a target_recovery stage record").toBeDefined();
      expect(
        ["success", "not_applicable"],
        "release gate requires successful recovery or no uncovered regions"
      ).toContain(stageMap["target_recovery"]?.outcome);

      const escalatedDiffs = report.diffs.filter(d => d.reviewerStatus === "needs_escalation");
      expect(
        escalatedDiffs.length,
        "release gate must not pass with unresolved review escalations (needs_escalation)"
      ).toBe(0);

      // Every accepted diff must have a classificationSource — no untagged diffs allowed at release.
      const untaggedAcceptedDiffs = report.diffs.filter(d => d.reviewerStatus === "accepted" && !d.classificationSource);
      expect(
        untaggedAcceptedDiffs.length,
        "release gate must not pass with accepted diffs missing classificationSource"
      ).toBe(0);
      assertFinalFindingIntegrity(report);

      // Unclassified recovery leftovers must be zero for production release.
      expect(
        report.recoverySummary?.unclassifiedCount ?? 0,
        "release gate requires zero unclassified recovery leftovers"
      ).toBe(0);

      // If viewport is mismatch, source crops must preserve original pixels and all accepted
      // diffs must be VLM-reviewed/recovered or explicitly labeled as projected-location evidence.
      const viewportStatus = report.viewportCompatibilityStatus ?? "compatible";
      if (viewportStatus !== "compatible") {
        expect(
          report.comparisonSpace?.sourceCropsPreserveOriginalPixels,
          "when viewport is mismatch, source crops must preserve original pixels"
        ).toBe(true);
        const unsafeDiffs = report.diffs.filter(d =>
          d.reviewerStatus === "accepted" &&
          d.classificationSource !== "vlm_reviewed" &&
          d.classificationSource !== "target_recovery" &&
          d.classificationSource !== "deterministic_projected_mismatch" &&
          d.classificationSource !== "deterministic_geometry" &&
          d.classificationSource !== "deterministic_presence"
        );
        expect(
          unsafeDiffs.length,
          "all accepted diffs under viewport mismatch must be VLM-reviewed or projected-location evidence"
        ).toBe(0);
      } else {
        expect(viewportStatus, "release gate requires no viewport distortion").toBe("compatible");
      }

      console.info(`[release-gate] diffs=${report.diffs.length}`);
      console.info(`[release-gate] locatorCoverageStatus=${report.locatorCoverageStatus}`);
      if (report.imageNormalization) {
        console.info(`[release-gate] expected=${report.imageNormalization.expected.source.width}x${report.imageNormalization.expected.source.height}`);
        console.info(`[release-gate] actual=${report.imageNormalization.actual.source.width}x${report.imageNormalization.actual.source.height}`);
        console.info(`[release-gate] anisotropicDelta=${report.imageNormalization.actual.anisotropicScaleDeltaPercent.toFixed(2)}%`);
      }
    } finally {
      await started.close();
    }
  }, 2400000);
});
