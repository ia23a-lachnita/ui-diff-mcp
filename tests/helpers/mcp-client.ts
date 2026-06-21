import { Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
    command: "node",
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
