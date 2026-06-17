import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UiDiffReportSchema } from "../../src/schemas/core.js";
import { writeTwoButtonFixture } from "../../src/testing/fixture-images.js";
import { startUiDiffMcpClient, type StartedMcpClient } from "../helpers/mcp-client.js";

const liveEnabled = process.env["RUN_UI_DIFF_LIVE"] === "1";

let tmpDir = "";
let started: StartedMcpClient | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-live-full-"));
  if (liveEnabled) {
    started = await startUiDiffMcpClient({ UI_DIFF_FOREGROUND_BUDGET_MS: "240000" });
  }
});

afterEach(async () => {
  await started?.close();
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!liveEnabled)("live full MCP discover_ui_diffs (default free mode)", () => {
  test("runs through stdio with real sidecar and default free mode", async () => {
    expect(process.env["LOCATEANYTHING_SIDECAR_URL"], "LOCATEANYTHING_SIDECAR_URL must be set").toBeTruthy();

    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "expected.png", "actual.png");
    const result = await started!.client.callTool({
      name: "discover_ui_diffs",
      arguments: {
        expectedImagePath: expected,
        actualImagePath: actual,
        projectRoot: tmpDir,
        mode: "free"
      }
    }, undefined, { timeout: 600000, maxTotalTimeout: 900000 });

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      status: string;
      diffCount: number;
      reportPath: string;
      runArtifacts: Array<{ role: string; path: string }>;
    };
    expect(structured.status).not.toBe("failed");
    expect(structured.diffCount).toBeGreaterThanOrEqual(1);
    expect(structured.runArtifacts.map(a => a.role)).toEqual(expect.arrayContaining([
      "expected_normalized",
      "actual_normalized",
      "pixel_diff",
      "pixel_diff_mask",
      "directional_overlay"
    ]));

    const report = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(structured.reportPath, "utf8")));
    expect(report.modelSelection?.auditor).toEqual(expect.objectContaining({
      provider: expect.stringMatching(/^(nvidia|openrouter)$/),
      model: expect.any(String),
      costClass: "free"
    }));
    expect(report.modelSelection?.reviewer).toEqual(expect.objectContaining({
      provider: expect.stringMatching(/^(nvidia|openrouter)$/),
      model: expect.any(String),
      costClass: "free"
    }));
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
    expect(report.locatorCoverageStatus, "locator must not have failed").not.toBe("failed");
    expect(report.elements.expected.length).toBeGreaterThan(0);
    expect(report.elements.actual.length).toBeGreaterThan(0);

    // provider-trace artifact must be written every run
    expect(report.runArtifacts.some(a => a.role === "provider_trace"), "provider_trace artifact must exist").toBe(true);
    const providerTracePath = report.runArtifacts.find(a => a.role === "provider_trace")!.path;
    const providerTraceEvents = JSON.parse(await fs.readFile(providerTracePath, "utf8")) as Array<{ event: string; phase: string; role: string; provider: string; model: string }>;
    expect(Array.isArray(providerTraceEvents)).toBe(true);
    // Probe events must be present (probes always run in free mode)
    expect(providerTraceEvents.some(e => e.event === "probe_result"), "provider trace must contain probe_result events").toBe(true);
    // If fallback warnings appear in report, a matching fallback event must be in the trace
    const fallbackWarnings = report.warnings.filter(w => /fallback|switched/i.test(w));
    if (fallbackWarnings.length > 0) {
      expect(providerTraceEvents.some(e => e.event === "fallback"), "trace must contain fallback event when fallback warning is present").toBe(true);
    }

    const reportText = JSON.stringify(report).toLowerCase();
    for (const forbidden of ["root cause", "change the code", "edit config", "acceptance passed"]) {
      expect(reportText.includes(forbidden)).toBe(false);
    }
  }, 900000);
});
