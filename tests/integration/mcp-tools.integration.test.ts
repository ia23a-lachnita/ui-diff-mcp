import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UiDiffReportSchema } from "../../src/schemas/core.js";
import { writeTwoButtonFixture } from "../../src/testing/fixture-images.js";
import { startUiDiffMcpClient, type StartedMcpClient } from "../helpers/mcp-client.js";

let tmpDir: string;
let started: StartedMcpClient | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-mcp-integration-"));
  started = await startUiDiffMcpClient({
    OPENROUTER_API_KEY: "",
    LOCATEANYTHING_SIDECAR_URL: "http://127.0.0.1:9"
  });
});

afterEach(async () => {
  await started?.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("MCP stdio tool surface", () => {
  it("lists all tools with input and output schemas", async () => {
    const tools = await started!.client.listTools();
    const byName = new Map(tools.tools.map(t => [t.name, t]));

    for (const name of [
      "compare_ui_images",
      "discover_ui_diffs",
      "ui_diff_model_health",
      "read_ui_diff_report",
      "capture_mobile_screen"
    ]) {
      const tool = byName.get(name);
      expect(tool).toBeTruthy();
      expect(tool?.inputSchema).toBeTruthy();
      expect(tool?.outputSchema).toBeTruthy();
    }
  });

  it("compare_ui_images returns structured deterministic output and report artifacts", async () => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "expected.png", "actual.png");

    const result = await started!.client.callTool({
      name: "compare_ui_images",
      arguments: {
        expectedImagePath: expected,
        actualImagePath: actual,
        projectRoot: tmpDir,
        mode: "deterministic_only"
      }
    });

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      status: string;
      diffCount: number;
      reportPath: string;
      artifactRoot: string;
      runArtifacts: string[];
    };
    expect(structured.status).toBe("complete");
    expect(structured.diffCount).toBeGreaterThanOrEqual(1);
    expect(structured.reportPath.endsWith("report.json")).toBe(true);
    expect(structured.runArtifacts).toHaveLength(2);

    const report = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(structured.reportPath, "utf8")));
    expect(report.visualClassificationStatus).toBe("not_run");
    await expect(fs.access(path.join(structured.artifactRoot, "index.json"))).resolves.toBeUndefined();
  });

  it("read_ui_diff_report returns the parsed report through structuredContent", async () => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "expected.png", "actual.png");
    const compare = await started!.client.callTool({
      name: "compare_ui_images",
      arguments: { expectedImagePath: expected, actualImagePath: actual, projectRoot: tmpDir }
    });
    const reportPath = (compare.structuredContent as { reportPath: string }).reportPath;

    const read = await started!.client.callTool({
      name: "read_ui_diff_report",
      arguments: { reportPath }
    });

    expect(read.isError).not.toBe(true);
    const structured = read.structuredContent as { report: unknown };
    const report = UiDiffReportSchema.parse(structured.report);
    expect(report.expectedImagePath).toBe(expected);
    expect(report.actualImagePath).toBe(actual);
  });

  it("rejects read_ui_diff_report outside .ui-diff/runs", async () => {
    const outside = path.join(tmpDir, "outside.json");
    await fs.writeFile(outside, "{}", "utf8");

    const result = await started!.client.callTool({
      name: "read_ui_diff_report",
      arguments: { reportPath: outside }
    });

    expect(result.isError).toBe(true);
  });

  it("ui_diff_model_health reports not_checked without API key", async () => {
    const result = await started!.client.callTool({
      name: "ui_diff_model_health",
      arguments: {}
    });

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      results: Array<{ role: string; status: string; detail?: string }>;
    };
    const required = structured.results.filter(r => r.role === "auditor" || r.role === "reviewer");
    expect(required.every(r => r.status === "not_checked")).toBe(true);
    expect(required.every(r => /No API key/i.test(r.detail ?? ""))).toBe(true);
  });

  it("returns a validation error for invalid compare_ui_images arguments", async () => {
    const result = await started!.client.callTool({
      name: "compare_ui_images",
      arguments: {
        expectedImagePath: "",
        actualImagePath: ""
      }
    });

    expect(result.isError).toBe(true);
  });
});
