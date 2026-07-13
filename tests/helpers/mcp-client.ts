import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpRunStatusPoller {
  client: Pick<Client, "callTool">;
  getDiagnostics(): Record<string, unknown>;
  recordRunStatus(status: string): void;
}

export interface McpToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
}

export interface WaitForUiDiffRunOptions {
  runId: string;
  projectRoot: string;
  intervalMs?: number;
  maxWaitMs?: number;
  callTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_STATUS_POLL_INTERVAL_MS = 10_000;
const DEFAULT_STATUS_MAX_WAIT_MS = 10 * 60_000;
const DEFAULT_STATUS_CALL_TIMEOUT_MS = 10 * 60_000;

function diagnosticsJson(poller: McpRunStatusPoller): string {
  return JSON.stringify(poller.getDiagnostics());
}

function statusFrom(result: McpToolResult): Record<string, unknown> {
  if (typeof result.structuredContent !== "object" || result.structuredContent === null) {
    throw new Error(`get_ui_diff_run_status returned no structured status; result=${JSON.stringify(result)}`);
  }
  return result.structuredContent as Record<string, unknown>;
}

export async function waitForUiDiffRun(
  poller: McpRunStatusPoller,
  options: WaitForUiDiffRunOptions
): Promise<Record<string, unknown>> {
  const intervalMs = options.intervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_STATUS_MAX_WAIT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_STATUS_CALL_TIMEOUT_MS;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const deadline = now() + maxWaitMs;
  let lastStatus = "unknown";

  while (true) {
    if (now() >= deadline) {
      throw new Error(`get_ui_diff_run_status timed out after ${maxWaitMs}ms for run ${options.runId}; lastStatus=${lastStatus}; diagnostics=${diagnosticsJson(poller)}`);
    }

    let result: McpToolResult;
    try {
      result = await poller.client.callTool({
        name: "get_ui_diff_run_status",
        arguments: { projectRoot: options.projectRoot, runId: options.runId }
      }, undefined, { timeout: callTimeoutMs }) as McpToolResult;
    } catch (error) {
      throw new Error(`get_ui_diff_run_status status call threw for run ${options.runId}: ${String(error)}; diagnostics=${diagnosticsJson(poller)}`);
    }

    if (result.isError === true) {
      throw new Error(`get_ui_diff_run_status returned isError for run ${options.runId}: ${JSON.stringify(result)}; diagnostics=${diagnosticsJson(poller)}`);
    }

    let status: Record<string, unknown>;
    try {
      status = statusFrom(result);
    } catch (error) {
      throw new Error(`get_ui_diff_run_status status parsing threw for run ${options.runId}: ${String(error)}; diagnostics=${diagnosticsJson(poller)}`);
    }

    const runStatus = String(status["status"] ?? "unknown");
    lastStatus = runStatus;
    poller.recordRunStatus(runStatus);
    if (runStatus === "complete") return status;
    if (runStatus === "failed") {
      throw new Error(`get_ui_diff_run_status reached failed for run ${options.runId}: ${JSON.stringify(status)}; diagnostics=${diagnosticsJson(poller)}`);
    }
    if (runStatus !== "queued" && runStatus !== "running") {
      throw new Error(`get_ui_diff_run_status reached terminal ${runStatus} for run ${options.runId}: ${JSON.stringify(status)}; diagnostics=${diagnosticsJson(poller)}`);
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new Error(`get_ui_diff_run_status timed out after ${maxWaitMs}ms for run ${options.runId}; lastStatus=${runStatus}; diagnostics=${diagnosticsJson(poller)}`);
    }
    await sleep(Math.min(intervalMs, remainingMs));
  }
}

export interface StartedMcpClient {
  client: Client;
  getDiagnostics(): { stderr: string; exitCode: number | null; exitSignal: NodeJS.Signals | null; lastRunStatus?: string };
  recordRunStatus(status: string): void;
  close(): Promise<void>;
}

export async function startUiDiffMcpClient(
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<StartedMcpClient> {
  const client = new Client({ name: "ui-diff-test-client", version: "0.0.1" });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...extraEnv })) {
    if (value !== undefined) env[key] = value;
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/src/index.js"],
    cwd: process.cwd(),
    env,
    stderr: "pipe"
  });

  await client.connect(transport);

  const diagnostics: { stderr: string; exitCode: number | null; exitSignal: NodeJS.Signals | null; lastRunStatus?: string } = {
    stderr: "",
    exitCode: null,
    exitSignal: null
  };
  const stderr = transport.stderr as Readable | null;
  stderr?.on("data", chunk => {
    diagnostics.stderr = `${diagnostics.stderr}${String(chunk)}`.slice(-32768);
  });
  const child = (transport as unknown as { _process?: ChildProcess })._process;
  child?.on("close", (code, signal) => {
    diagnostics.exitCode = code;
    diagnostics.exitSignal = signal;
  });

  return {
    client,
    getDiagnostics: () => ({ ...diagnostics }),
    recordRunStatus: status => { diagnostics.lastRunStatus = status; },
    close: async () => {
      await client.close();
    }
  };
}
