import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { UiDiffReportSchema } from "../../src/schemas/core.js";
import { startUiDiffMcpClient } from "../helpers/mcp-client.js";

const calorixLive = process.env["RUN_CALORIX_UI_DIFF_LIVE"] === "1";
const calorixFullLive = process.env["RUN_CALORIX_FULL_LIVE"] === "1";

describe.skipIf(!calorixLive)("Calorix live UI diff smoke", () => {
  test("runs configured Calorix image pair through start_ui_diff_run (async handle)", async () => {
    const expectedImagePath = process.env["UI_DIFF_LIVE_EXPECTED_IMAGE"];
    const actualImagePath = process.env["UI_DIFF_LIVE_ACTUAL_IMAGE"];
    expect(expectedImagePath, "UI_DIFF_LIVE_EXPECTED_IMAGE must be set").toBeTruthy();
    expect(actualImagePath, "UI_DIFF_LIVE_ACTUAL_IMAGE must be set").toBeTruthy();
    expect(process.env["OPENROUTER_API_KEY"], "OPENROUTER_API_KEY must be set").toBeTruthy();
    expect(process.env["LOCATEANYTHING_SIDECAR_URL"], "LOCATEANYTHING_SIDECAR_URL must be set").toBeTruthy();

    const projectRoot = "C:/Users/xursc/projects/calorix";
    await expect(fs.access(projectRoot)).resolves.toBeUndefined();

    const started = await startUiDiffMcpClient();
    try {
      const startResult = await started.client.callTool({
        name: "start_ui_diff_run",
        arguments: { expectedImagePath: expectedImagePath!, actualImagePath: actualImagePath!, projectRoot, mode: "free" }
      });
      expect(startResult.isError).not.toBe(true);
      const { runId } = startResult.structuredContent as { runId: string };
      expect(runId).toBeTruthy();

      // Poll for up to 15 minutes
      let statusOut: { status: string; reportPath?: string } | undefined;
      for (let i = 0; i < 90; i++) {
        await new Promise(r => setTimeout(r, 10000));
        const statusResult = await started.client.callTool({ name: "get_ui_diff_run_status", arguments: { projectRoot, runId } });
        statusOut = statusResult.structuredContent as { status: string; reportPath?: string };
        if (statusOut.status === "complete" || statusOut.status === "incomplete" || statusOut.status === "failed") break;
      }
      expect(statusOut?.status, "run must complete, be incomplete, or fail — not hang").not.toBe("running");
      expect(statusOut?.status).not.toBe("failed");
      expect(statusOut?.reportPath).toBeTruthy();

      const report = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(statusOut!.reportPath!, "utf8")));
      expect(path.resolve(statusOut!.reportPath!).includes(`${path.sep}.ui-diff${path.sep}runs${path.sep}`)).toBe(true);
      expect(report.diffs.every(d => d.evidence.length > 0)).toBe(true);
    } finally {
      await started.close();
    }
  }, 900000);
});

describe.skipIf(!calorixFullLive)("verify:calorix-full-live unbounded all-target audit", () => {
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

    const started = await startUiDiffMcpClient();
    try {
      const startResult = await started.client.callTool({
        name: "start_ui_diff_run",
        arguments: { expectedImagePath: expectedImagePath!, actualImagePath: actualImagePath!, projectRoot, mode: "free" }
      });
      expect(startResult.isError).not.toBe(true);
      const { runId } = startResult.structuredContent as { runId: string };
      expect(runId).toBeTruthy();

      // Poll for up to 35 minutes
      let statusOut: { status: string; reportPath?: string } | undefined;
      for (let i = 0; i < 210; i++) {
        await new Promise(r => setTimeout(r, 10000));
        const statusResult = await started.client.callTool({ name: "get_ui_diff_run_status", arguments: { projectRoot, runId } });
        statusOut = statusResult.structuredContent as { status: string; reportPath?: string };
        if (statusOut.status === "complete" || statusOut.status === "incomplete" || statusOut.status === "failed") break;
      }
      expect(statusOut?.status).not.toBe("failed");
      expect(statusOut?.reportPath).toBeTruthy();

      const report = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(statusOut!.reportPath!, "utf8")));
      expect(report.auditScope?.auditLimited ?? false).toBe(false);
      console.info(`[full-audit] visualClassificationStatus=${report.visualClassificationStatus}`);
      console.info(`[full-audit] auditedPairs=${report.auditScope?.auditedPairs ?? "n/a"}, totalPairs=${report.auditScope?.totalPairs ?? "n/a"}`);
      console.info(`[full-audit] diffs=${report.diffs.length}`);
      if (report.modelSelection) {
        console.info(`[full-audit] auditor=${report.modelSelection.auditor?.provider}/${report.modelSelection.auditor?.model}`);
        console.info(`[full-audit] reviewer=${report.modelSelection.reviewer?.provider}/${report.modelSelection.reviewer?.model}`);
      }
      expect(report.diffs.every(d => d.evidence.length > 0)).toBe(true);
    } finally {
      await started.close();
    }
  }, 2400000);
});
