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
        mode: "full"
      }
    }, undefined, { timeout: 180000, maxTotalTimeout: 240000 });

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      status: string;
      diffCount: number;
      reportPath: string;
      runArtifacts: string[];
    };
    expect(structured.status).toBe("complete");
    expect(structured.diffCount).toBeGreaterThanOrEqual(1);
    expect(structured.runArtifacts).toHaveLength(2);

    const report = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(structured.reportPath, "utf8")));
    expect(report.visualClassificationStatus).toBe("complete");
    expect(report.modelHealth.filter(m => m.role === "auditor" || m.role === "reviewer").every(m => m.status === "pass")).toBe(true);
    expect(report.elements.expected.length).toBeGreaterThan(0);
    expect(report.elements.actual.length).toBeGreaterThan(0);

    const reportText = JSON.stringify(report).toLowerCase();
    for (const forbidden of ["root cause", "change the code", "edit config", "acceptance passed"]) {
      expect(reportText.includes(forbidden)).toBe(false);
    }
  }, 240000);
});
