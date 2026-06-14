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
    started = await startUiDiffMcpClient();
  }
});

afterEach(async () => {
  await started?.close();
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!liveEnabled)("live full MCP discover_ui_diffs", () => {
  test("runs through stdio with real sidecar and real OpenRouter models", async () => {
    expect(process.env["OPENROUTER_API_KEY"], "OPENROUTER_API_KEY must be set").toBeTruthy();
    expect(process.env["LOCATEANYTHING_SIDECAR_URL"], "LOCATEANYTHING_SIDECAR_URL must be set").toBeTruthy();

    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "expected.png", "actual.png");
    const result = await started!.client.callTool({
      name: "discover_ui_diffs",
      arguments: {
        expectedImagePath: expected,
        actualImagePath: actual,
        projectRoot: tmpDir,
        mode: "free_openrouter"
      }
    }, undefined, { timeout: 600000, maxTotalTimeout: 900000 });

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      status: string;
      diffCount: number;
      reportPath: string;
      runArtifacts: Array<{ role: string; path: string }>;
    };
    expect(structured.status).toBe("complete");
    expect(structured.diffCount).toBeGreaterThanOrEqual(1);
    expect(structured.runArtifacts.map(a => a.role)).toEqual(expect.arrayContaining([
      "expected_normalized",
      "actual_normalized",
      "pixel_diff",
      "pixel_diff_mask",
      "directional_overlay"
    ]));

    const report = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(structured.reportPath, "utf8")));
    expect(report.visualClassificationStatus).toBe("complete");
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
  }, 900000);
});
