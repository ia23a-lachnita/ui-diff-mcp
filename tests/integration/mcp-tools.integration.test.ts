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
      "capture_mobile_screen",
      "start_ui_diff_run",
      "get_ui_diff_run_status"
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
      unresolvedRegionCount: number;
      reportPath: string;
      artifactRoot: string;
      runArtifacts: string[];
    };
    expect(structured.status).toBe("complete");
    expect(structured.diffCount).toBe(0);
    expect(structured.unresolvedRegionCount).toBeGreaterThanOrEqual(1);
    expect(structured.reportPath.endsWith("report.json")).toBe(true);
    expect(structured.runArtifacts.length).toBeGreaterThanOrEqual(9);

    const report = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(structured.reportPath, "utf8")));
    expect(report.visualClassificationStatus).toBe("not_run");
    expect(report.diffs.every(diff => diff.criterion !== "unclassified_visual_change")).toBe(true);
    expect(report.unresolvedRegions.length).toBe(structured.unresolvedRegionCount);
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

  it("ui_diff_model_health returns structured results for all free candidates", async () => {
    const result = await started!.client.callTool({
      name: "ui_diff_model_health",
      arguments: {}
    });

    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
      checkedAt: string;
      results: Array<{ role: string; provider: string; model: string; status: string; detail?: string }>;
    };
    expect(structured.checkedAt).toBeTruthy();
    expect(Array.isArray(structured.results)).toBe(true);
    expect(structured.results.length).toBeGreaterThan(0);
    for (const r of structured.results) {
      expect(["auditor", "reviewer", "target_recovery", "locator", "fast_auditor", "escalation"]).toContain(r.role);
      expect(["pass", "fail", "not_checked"]).toContain(r.status);
    }
  }, 60000);

  it("discover_ui_diffs returns structured incomplete result when foreground budget is exceeded", async () => {
    // Start a server with a 100ms foreground budget — well below any real probe+model round-trip.
    const fastBudgetClient = await startUiDiffMcpClient({
      OPENROUTER_API_KEY: "",
      LOCATEANYTHING_SIDECAR_URL: "http://127.0.0.1:9",
      UI_DIFF_FOREGROUND_BUDGET_MS: "100"
    });
    try {
      const { expected, actual } = await writeTwoButtonFixture(tmpDir, "exp-budget.png", "act-budget.png");
      const result = await fastBudgetClient.client.callTool({
        name: "discover_ui_diffs",
        arguments: {
          expectedImagePath: expected,
          actualImagePath: actual,
          projectRoot: tmpDir,
          mode: "free"
        }
      });
      // Must not error at MCP protocol level — must return structured content
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as { status: string; visualClassificationStatus: string };
      expect(structured.status).toBe("incomplete");
      expect(structured.visualClassificationStatus).toBe("incomplete");
    } finally {
      await fastBudgetClient.close();
    }
  }, 30000);

  it("start_ui_diff_run returns queued status and get_ui_diff_run_status returns the run state", async () => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "exp-async.png", "act-async.png");
    const testLabel = `test-run-${Date.now()}`;
    const startResult = await started!.client.callTool({
      name: "start_ui_diff_run",
      arguments: {
        expectedImagePath: expected,
        actualImagePath: actual,
        projectRoot: tmpDir,
        mode: "deterministic_only",
        label: testLabel
      }
    });
    expect(startResult.isError).not.toBe(true);
    const startOut = startResult.structuredContent as { runId: string; status:string };
    expect(startOut.status).toBe("queued");
    expect(startOut.runId).toBeTruthy();

    // Poll for up to 20 seconds until complete or failed
    let statusOut: { runId: string; status: string; label?: string } | undefined;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      const statusResult = await started!.client.callTool({
        name: "get_ui_diff_run_status",
        arguments: { projectRoot: tmpDir, runId: startOut.runId }
      });
      statusOut = statusResult.structuredContent as { runId: string; status: string; label?: string };
      if (statusOut.status === "complete" || statusOut.status === "incomplete" || statusOut.status === "failed") break;
    }
    expect(statusOut?.runId).toBe(startOut.runId);
    expect(statusOut?.label).toBe(testLabel);
    expect(["complete", "incomplete"]).toContain(statusOut?.status);
  }, 30000);

  it("get_ui_diff_run_status rejects path-traversal runIds", async () => {
    const result = await started!.client.callTool({
      name: "get_ui_diff_run_status",
      arguments: { projectRoot: tmpDir, runId: "../../../etc/passwd" }
    });
    // Must not error at protocol level but must return not-found, not file contents
    const structured = result.structuredContent as { status?: string } | undefined;
    expect(structured?.status ?? "not_found").toBe("not_found");
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
