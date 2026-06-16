import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface StartedMcpClient {
  client: Client;
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

  // Drain the piped stderr so the server's event loop never blocks on a full OS pipe buffer.
  // Without this, verbose pipeline logging fills the 64KB pipe and freezes the server mid-run.
  if (transport.stderr) (transport.stderr as Readable).resume();

  return {
    client,
    close: async () => {
      await client.close();
    }
  };
}
