import { describe, expect, test, vi } from "vitest";
import {
  waitForUiDiffRun,
  type McpRunStatusPoller
} from "../helpers/mcp-client.js";

type ToolResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
};

function createPoller(results: Array<ToolResult | Error>) {
  let time = 0;
  const recordRunStatus = vi.fn();
  const callTool = vi.fn(async () => {
    const next = results.shift();
    if (next instanceof Error) throw next;
    return next as never;
  });
  const poller = {
    client: { callTool } as McpRunStatusPoller["client"],
    getDiagnostics: () => ({ stderr: "child stderr", exitCode: 17, exitSignal: null, lastRunStatus: "running" }),
    recordRunStatus
  } satisfies McpRunStatusPoller;

  return {
    poller,
    callTool,
    recordRunStatus,
    now: () => time,
    sleep: async (milliseconds: number) => { time += milliseconds; }
  };
}

describe("waitForUiDiffRun", () => {
  test("polls queued and running statuses until complete", async () => {
    const fixture = createPoller([
      { structuredContent: { runId: "run-1", status: "queued" } },
      { structuredContent: { runId: "run-1", status: "running" } },
      { structuredContent: { runId: "run-1", status: "complete", reportPath: "C:/tmp/report.json" } }
    ]);

    const result = await waitForUiDiffRun(fixture.poller, {
      runId: "run-1",
      projectRoot: "C:/tmp",
      intervalMs: 10,
      maxWaitMs: 100,
      callTimeoutMs: 25,
      now: fixture.now,
      sleep: fixture.sleep
    });

    expect(result).toEqual({ runId: "run-1", status: "complete", reportPath: "C:/tmp/report.json" });
    expect(fixture.recordRunStatus).toHaveBeenNthCalledWith(1, "queued");
    expect(fixture.recordRunStatus).toHaveBeenNthCalledWith(2, "running");
    expect(fixture.recordRunStatus).toHaveBeenNthCalledWith(3, "complete");
    expect(fixture.callTool).toHaveBeenCalledTimes(3);
    expect(fixture.callTool).toHaveBeenLastCalledWith({
      name: "get_ui_diff_run_status",
      arguments: { projectRoot: "C:/tmp", runId: "run-1" }
    }, undefined, { timeout: 25 });
  });

  test("includes diagnostics when the MCP status response is an error", async () => {
    const fixture = createPoller([{ isError: true, content: [{ type: "text", text: "status unavailable" }] }]);

    await expect(waitForUiDiffRun(fixture.poller, {
      runId: "run-1",
      projectRoot: "C:/tmp",
      now: fixture.now,
      sleep: fixture.sleep
    })).rejects.toThrow(/isError.*diagnostics=\{"stderr":"child stderr","exitCode":17,"exitSignal":null,"lastRunStatus":"running"\}/i);
  });

  test("includes diagnostics when the run reaches failed", async () => {
    const fixture = createPoller([
      { structuredContent: { runId: "run-1", status: "failed", error: "provider route exhausted" } }
    ]);

    await expect(waitForUiDiffRun(fixture.poller, {
      runId: "run-1",
      projectRoot: "C:/tmp",
      now: fixture.now,
      sleep: fixture.sleep
    })).rejects.toThrow(/failed.*provider route exhausted.*child stderr/i);
    expect(fixture.recordRunStatus).toHaveBeenCalledWith("failed");
  });

  test("includes diagnostics when a status call throws", async () => {
    const fixture = createPoller([new Error("stdio connection closed")]);

    await expect(waitForUiDiffRun(fixture.poller, {
      runId: "run-1",
      projectRoot: "C:/tmp",
      now: fixture.now,
      sleep: fixture.sleep
    })).rejects.toThrow(/status call threw.*stdio connection closed.*child stderr/i);
  });

  test("includes diagnostics when polling exceeds the total wait bound", async () => {
    const fixture = createPoller([
      { structuredContent: { runId: "run-1", status: "running" } },
      { structuredContent: { runId: "run-1", status: "running" } }
    ]);

    await expect(waitForUiDiffRun(fixture.poller, {
      runId: "run-1",
      projectRoot: "C:/tmp",
      intervalMs: 10,
      maxWaitMs: 20,
      now: fixture.now,
      sleep: fixture.sleep
    })).rejects.toThrow(/timed out.*20ms.*lastStatus=running.*child stderr/i);
    expect(fixture.callTool).toHaveBeenCalledTimes(2);
  });
});
