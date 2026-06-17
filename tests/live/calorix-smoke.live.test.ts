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

      // Visual classification must be complete — incomplete means the model did not finish reviewing
      expect(report.visualClassificationStatus, "visual classification must be complete").toBe("complete");

      // There must be paired targets available for audit
      expect(report.auditScope?.totalPairs ?? 0, "at least one element pair must be available for audit").toBeGreaterThan(0);

      // At least one diff must have gone through model review, not only pixel noise or deterministic checks.
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

      // Visual classification must be complete
      expect(report.visualClassificationStatus, "visual classification must be complete").toBe("complete");

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
