import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hydrateReportParts } from "../../src/report/report-parts.js";
import { UiDiffReportSchema } from "../../src/schemas/core.js";
import { writeTwoButtonFixture } from "../../src/testing/fixture-images.js";
import { startUiDiffMcpClient, waitForUiDiffRun, type StartedMcpClient } from "../helpers/mcp-client.js";

const liveEnabled = process.env["RUN_OPENROUTER_FREE_LIVE"] === "1";

let tmpDir = "";
let started: StartedMcpClient | undefined;
let passed = false;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-live-openrouter-"));
  passed = false;
  if (liveEnabled) {
    started = await startUiDiffMcpClient();
  }
});

afterEach(async () => {
  try {
    await started?.close();
  } finally {
    if (tmpDir) {
      if (passed) await fs.rm(tmpDir, { recursive: true, force: true });
      else console.warn(`[PRESERVED OPENROUTER LIVE ARTIFACTS] ${tmpDir}`);
    }
  }
});

describe.skipIf(!liveEnabled)("live MCP start_ui_diff_run (OpenRouter-only free mode)", () => {
  test("runs through stdio with real sidecar and free_openrouter mode", async () => {
    expect(process.env["OPENROUTER_API_KEY"], "OPENROUTER_API_KEY must be set").toBeTruthy();
    expect(process.env["LOCATEANYTHING_SIDECAR_URL"], "LOCATEANYTHING_SIDECAR_URL must be set").toBeTruthy();

    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "expected.png", "actual.png");
    const startResult = await started!.client.callTool({
      name: "start_ui_diff_run",
      arguments: {
        expectedImagePath: expected,
        actualImagePath: actual,
        projectRoot: tmpDir,
        mode: "free_openrouter"
      }
    }, undefined, { timeout: 600000 });

    expect(startResult.isError).not.toBe(true);
    const { runId } = startResult.structuredContent as { runId: string };
    expect(runId).toBeTruthy();
    const statusOut = await waitForUiDiffRun(started!, {
      runId,
      projectRoot: tmpDir,
      callTimeoutMs: 600000
    });
    expect(statusOut.status).toBe("complete");
    const reportPath = String(statusOut.reportPath ?? "");
    expect(reportPath).toBeTruthy();

    const rawReport = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(reportPath, "utf8")));
    const report = await hydrateReportParts(rawReport, reportPath);
    expect(report.status).not.toBe("failed");
    expect(
      report.diffs.length + report.unresolvedRegions.length,
      "the known fixture change must be finalized or retained as an unresolved region"
    ).toBeGreaterThanOrEqual(1);
    expect(report.runArtifacts.map(a => a.role)).toEqual(expect.arrayContaining([
      "expected_normalized",
      "actual_normalized",
      "pixel_diff",
      "pixel_diff_mask",
      "directional_overlay"
    ]));

    expect(report.diffs.every(diff => diff.criterion !== "unclassified_visual_change")).toBe(true);
    expect(report.modelSelection?.auditor?.provider).toBe("openrouter");
    expect(report.modelSelection?.reviewer?.provider).toBe("openrouter");
    const selectedRoutes = [
      report.modelSelection?.auditor,
      report.modelSelection?.reviewer
    ].filter((route): route is NonNullable<typeof route> => Boolean(route));
    for (const route of selectedRoutes) {
      expect(report.modelHealth).toEqual(expect.arrayContaining([
        expect.objectContaining({
          provider: route.provider,
          model: route.model,
          status: "pass"
        })
      ]));
    }
    expect(report.elements.expected.length).toBeGreaterThan(0);
    expect(report.elements.actual.length).toBeGreaterThan(0);

    const reportText = JSON.stringify(report).toLowerCase();
    for (const forbidden of ["root cause", "change the code", "edit config", "acceptance passed"]) {
      expect(reportText.includes(forbidden)).toBe(false);
    }
    passed = true;
  }, 660000);
});
