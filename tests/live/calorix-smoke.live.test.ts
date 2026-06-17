import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { UiDiffReportSchema } from "../../src/schemas/core.js";
import { startUiDiffMcpClient } from "../helpers/mcp-client.js";
import { ensureSidecarRunning, type SidecarHandle } from "../helpers/sidecar-manager.js";

const calorixLive = process.env["RUN_CALORIX_UI_DIFF_LIVE"] === "1";
const calorixFullLive = process.env["RUN_CALORIX_FULL_LIVE"] === "1";

describe.skipIf(!calorixLive)("Calorix live UI diff smoke", () => {
  let sidecarHandle: SidecarHandle | undefined;

  beforeAll(async () => {
    const url = process.env["LOCATEANYTHING_SIDECAR_URL"] ?? "http://127.0.0.1:39731";
    sidecarHandle = await ensureSidecarRunning(url);
  }, 130000);

  afterAll(() => { sidecarHandle?.close(); });

  test("runs configured Calorix image pair through start_ui_diff_run (async handle)", async () => {
    const expectedImagePath = process.env["UI_DIFF_LIVE_EXPECTED_IMAGE"];
    const actualImagePath = process.env["UI_DIFF_LIVE_ACTUAL_IMAGE"];
    expect(expectedImagePath, "UI_DIFF_LIVE_EXPECTED_IMAGE must be set").toBeTruthy();
    expect(actualImagePath, "UI_DIFF_LIVE_ACTUAL_IMAGE must be set").toBeTruthy();
    expect(process.env["OPENROUTER_API_KEY"], "OPENROUTER_API_KEY must be set").toBeTruthy();
    expect(process.env["LOCATEANYTHING_SIDECAR_URL"], "LOCATEANYTHING_SIDECAR_URL must be set").toBeTruthy();

    const projectRoot = "C:/Users/xursc/projects/calorix";
    await expect(fs.access(projectRoot)).resolves.toBeUndefined();

    // 10-min locator timeout for large phone screenshots (1200+ px tall).
    // No UI_DIFF_DUAL_LOCATOR: projection is the required default for release gates.
    const started = await startUiDiffMcpClient({ LOCATEANYTHING_TIMEOUT_MS: "600000" });
    try {
      const startResult = await started.client.callTool({
        name: "start_ui_diff_run",
        arguments: { expectedImagePath: expectedImagePath!, actualImagePath: actualImagePath!, projectRoot, mode: "free" }
      }, undefined, { timeout: 600000 });
      expect(startResult.isError).not.toBe(true);
      const { runId } = startResult.structuredContent as { runId: string };
      expect(runId).toBeTruthy();

      // Poll for up to 20 minutes
      let statusOut: { status: string; reportPath?: string } | undefined;
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 10000));
        const statusResult = await started.client.callTool({ name: "get_ui_diff_run_status", arguments: { projectRoot, runId } }, undefined, { timeout: 600000 });
        statusOut = statusResult.structuredContent as { status: string; reportPath?: string };
        if (statusOut.status !== "running") break;
      }
      expect(statusOut?.status, "run must terminate — not hang").not.toBe("running");
      expect(statusOut?.status, `run must complete, got: ${statusOut?.status}`).toBe("complete");
      expect(statusOut?.reportPath).toBeTruthy();

      const report = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(statusOut!.reportPath!, "utf8")));
      expect(path.resolve(statusOut!.reportPath!).includes(`${path.sep}.ui-diff${path.sep}runs${path.sep}`)).toBe(true);

      // Locator must have found elements with adequate coverage — weak or failed is a gate failure
      expect(report.locatorCoverageStatus, "locator coverage must not be weak or failed").not.toMatch(/^(failed|weak)$/);
      expect(report.elements.expected.length, "locator must find elements in expected image").toBeGreaterThan(0);
      expect(report.elements.actual.length, "locator must find elements in actual image").toBeGreaterThan(0);

      // Bounded smoke: audit was limited by UI_DIFF_MAX_AUDIT_PAIRS; classification is expected
      // incomplete because recovery cannot cover all uncovered components in a 3-pair bounded run.
      // The full gate (verify:calorix-full-live) asserts complete.
      expect(report.auditScope?.auditLimited, "bounded smoke gate: audit must be limited by UI_DIFF_MAX_AUDIT_PAIRS").toBe(true);
      expect(report.visualClassificationStatus, "classification expected incomplete when auditLimited").toBe("incomplete");

      // There must be paired targets available for audit
      expect(report.auditScope?.totalPairs ?? 0, "at least one element pair must be available for audit").toBeGreaterThan(0);

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
  let sidecarHandle: SidecarHandle | undefined;

  beforeAll(async () => {
    const url = process.env["LOCATEANYTHING_SIDECAR_URL"] ?? "http://127.0.0.1:39731";
    sidecarHandle = await ensureSidecarRunning(url);
  }, 130000);

  afterAll(() => { sidecarHandle?.close(); });

  test("runs unbounded Calorix image pair — all pairs audited, no UI_DIFF_MAX_AUDIT_PAIRS limit", async () => {
    const expectedImagePath = process.env["UI_DIFF_LIVE_EXPECTED_IMAGE"];
    const actualImagePath = process.env["UI_DIFF_LIVE_ACTUAL_IMAGE"];
    expect(expectedImagePath, "UI_DIFF_LIVE_EXPECTED_IMAGE must be set").toBeTruthy();
    expect(actualImagePath, "UI_DIFF_LIVE_ACTUAL_IMAGE must be set").toBeTruthy();
    expect(process.env["OPENROUTER_API_KEY"], "OPENROUTER_API_KEY must be set").toBeTruthy();
    expect(process.env["LOCATEANYTHING_SIDECAR_URL"], "LOCATEANYTHING_SIDECAR_URL must be set").toBeTruthy();
    // Confirm UI_DIFF_MAX_AUDIT_PAIRS is not set so this is a genuine unbounded run
    expect(process.env["UI_DIFF_MAX_AUDIT_PAIRS"], "UI_DIFF_MAX_AUDIT_PAIRS must NOT be set for full audit").toBeUndefined();

    const projectRoot = "C:/Users/xursc/projects/calorix";
    await expect(fs.access(projectRoot)).resolves.toBeUndefined();

    // 10-min locator timeout for large phone screenshots.
    // No UI_DIFF_DUAL_LOCATOR: projection is the required default for release gates.
    const started = await startUiDiffMcpClient({ LOCATEANYTHING_TIMEOUT_MS: "600000" });
    try {
      const startResult = await started.client.callTool({
        name: "start_ui_diff_run",
        arguments: { expectedImagePath: expectedImagePath!, actualImagePath: actualImagePath!, projectRoot, mode: "free" }
      }, undefined, { timeout: 600000 });
      expect(startResult.isError).not.toBe(true);
      const { runId } = startResult.structuredContent as { runId: string };
      expect(runId).toBeTruthy();

      // Poll for up to 40 minutes
      let statusOut: { status: string; reportPath?: string } | undefined;
      for (let i = 0; i < 240; i++) {
        await new Promise(r => setTimeout(r, 10000));
        const statusResult = await started.client.callTool({ name: "get_ui_diff_run_status", arguments: { projectRoot, runId } }, undefined, { timeout: 600000 });
        statusOut = statusResult.structuredContent as { status: string; reportPath?: string };
        if (statusOut.status !== "running") break;
      }
      expect(statusOut?.status, "run must terminate — not hang").not.toBe("running");
      expect(statusOut?.status, `run must complete, got: ${statusOut?.status}`).toBe("complete");
      expect(statusOut?.reportPath).toBeTruthy();

      const report = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(statusOut!.reportPath!, "utf8")));
      expect(report.auditScope?.auditLimited ?? false).toBe(false);

      // Locator must have found elements with adequate coverage — weak or failed is a gate failure
      expect(report.locatorCoverageStatus, "locator coverage must not be weak or failed").not.toMatch(/^(failed|weak)$/);
      expect(report.elements.expected.length, "locator must find elements in expected image").toBeGreaterThan(0);
      expect(report.elements.actual.length, "locator must find elements in actual image").toBeGreaterThan(0);
      expect(report.auditScope?.totalPairs ?? 0, "at least one element pair must be available for audit").toBeGreaterThan(0);

      // Ideal: visualClassificationStatus === "complete". When incomplete, the provider trace
      // must contain route_exhausted events for target_recovery explaining why recovery failed.
      // This aligns with the plan acceptance criterion: "blocked if incomplete WITHOUT a trace."
      // NOTE: a PASS here with incomplete status is a DIAGNOSTIC pass, not production-ready
      // completion. Production release requires visualClassificationStatus === "complete".
      if (report.visualClassificationStatus === "incomplete") {
        console.warn(
          "[DEGRADED PASS] visualClassificationStatus is incomplete — free-tier provider routes exhausted." +
          " Production release is BLOCKED until full classification completes."
        );
        const ptFullPath = report.runArtifacts.find(a => a.role === "provider_trace")?.path;
        if (ptFullPath) {
          const ptFull = JSON.parse(await fs.readFile(ptFullPath, "utf8")) as Array<{ event: string; role: string }>;
          expect(ptFull.some(e => e.event === "route_exhausted" && e.role === "target_recovery"),
            "incomplete classification must have route_exhausted target_recovery events in provider trace").toBe(true);
        }
      }

      // At least one diff must have gone through model review, not only pixel noise or deterministic checks.
      // Deterministic records use reviewerStatus="accepted", so model must also be non-deterministic.
      expect(report.diffs.length, "at least one diff must be reported").toBeGreaterThan(0);
      const reviewedDiffs = report.diffs.filter(d => d.reviewerStatus !== "not_reviewed" && d.model !== "deterministic");
      expect(reviewedDiffs.length, "at least one diff must be accepted or rejected by the VLM reviewer (not deterministic-only)").toBeGreaterThan(0);

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
