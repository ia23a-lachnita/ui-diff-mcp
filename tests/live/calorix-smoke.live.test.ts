import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { UiDiffReportSchema } from "../../src/schemas/core.js";
import { startUiDiffMcpClient } from "../helpers/mcp-client.js";

const calorixLive = process.env["RUN_CALORIX_UI_DIFF_LIVE"] === "1";

describe.skipIf(!calorixLive)("Calorix live UI diff smoke", () => {
  test("runs configured Calorix image pair through discover_ui_diffs", async () => {
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
      const result = await started.client.callTool({
        name: "discover_ui_diffs",
        arguments: {
          expectedImagePath: expectedImagePath!,
          actualImagePath: actualImagePath!,
          projectRoot,
          mode: "full"
        }
      }, undefined, { timeout: 180000, maxTotalTimeout: 240000 });

      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as { status: string; reportPath: string; artifactRoot: string };
      expect(structured.status).not.toBe("failed");
      expect(path.resolve(structured.reportPath).includes(`${path.sep}.ui-diff${path.sep}runs${path.sep}`)).toBe(true);

      const report = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(structured.reportPath, "utf8")));
      expect(report.expectedImagePath).toBe(path.resolve(projectRoot, expectedImagePath!));
      expect(report.actualImagePath).toBe(path.resolve(projectRoot, actualImagePath!));
      expect(report.diffs.every(d => d.evidence.length > 0)).toBe(true);
    } finally {
      await started.close();
    }
  }, 240000);
});
