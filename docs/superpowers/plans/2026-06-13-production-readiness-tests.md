# UI Diff MCP Production Readiness Test Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the missing production-readiness test gates for the MCP tool surface, mobile capture wrapper, and real model/locator integrations so `ui-diff-mcp` can graduate from Calorix dogfooding to production use.

**Architecture:** Keep normal `npm test` deterministic and credential-free, but add explicit live release-gate commands that run only when enabled by environment variables. Use the official MCP TypeScript SDK client over stdio for committed MCP integration tests, dependency injection for capture command testing, and real OpenRouter plus real LocateAnything sidecar calls for live tests.

**Tech Stack:** Node.js 22+, TypeScript ESM, Vitest 4.1, `@modelcontextprotocol/sdk@1.29.0`, Sharp fixture images, OpenRouter Chat Completions, LocateAnything sidecar HTTP API.

---

## Research Inputs

- MCP TypeScript SDK v1.29.0 supports local stdio servers with `Client` and `StdioClientTransport`; `client.connect()` spawns the server process, `client.listTools()` exposes tool schemas, and `client.callTool()` returns `content`, `structuredContent`, and `isError`.
- MCP TypeScript SDK `registerTool` supports `inputSchema` and `outputSchema`; the SDK converts Zod schemas to JSON Schema for clients.
- Vitest supports separate test include patterns, coverage thresholds, and `test.skipIf(condition)` / `describe.skipIf(condition)` for environment-gated tests.
- OpenRouter supports image inputs through Chat Completions message content and strict structured outputs through `response_format: { type: "json_schema", json_schema: { strict: true, schema } }`.
- The approved project spec requires no user-authored target maps, ROI maps, ignore masks, anchor dumps, causality explanations, app-edit advice, or MCP-edit advice.
- Live tests must not run as part of `npm test` because they require external credentials, a running sidecar, network, and possibly API quota.

Sources:

- Context7: `/modelcontextprotocol/typescript-sdk/v1.29.0`, query "testing an MCP stdio server with Client and StdioClientTransport"
- Context7: `/vitest-dev/vitest/v4.1.6`, query "conditional skip and separate integration/live test projects"
- Existing approved spec: `docs/superpowers/specs/2026-06-12-ui-diff-mcp-research-design.md`

## Current Gaps

- `src/server.ts` is the production MCP tool surface but has very low committed coverage.
- `src/capture/mobile-capture.ts` only tests the unreachable unknown-target branch and does not prove command arguments, output paths, or failure wrapping.
- Existing SDK smoke checks were run manually, not committed as tests.
- Existing full-mode e2e uses mocked models/sidecar; no committed release gate proves real OpenRouter and real LocateAnything sidecar behavior.
- No release checklist records a live Calorix or Calorix-style smoke run with exact env vars, command, output path, and acceptance criteria.

## File Structure

- Create `tests/helpers/mcp-client.ts`: starts built MCP server through `StdioClientTransport`, lists tools, calls tools, and closes the client reliably.
- Modify `src/server.ts`: export injectable dependencies and handler functions so the MCP tool surface can be tested in-process.
- Create `tests/unit/server-handlers.test.ts`: in-process tests for MCP tool handler behavior and `src/server.ts` coverage.
- Create `tests/integration/mcp-tools.integration.test.ts`: credential-free committed MCP tests for tool schemas, deterministic `compare_ui_images`, `read_ui_diff_report`, validation errors, and `ui_diff_model_health` missing-key behavior.
- Modify `src/capture/mobile-capture.ts`: inject a command runner and temp-path factory while preserving the public `captureMobileScreen(target)` API.
- Create `tests/unit/mobile-capture.test.ts`: deterministic tests for adb success, adb failure, ios-simctl success, ios-simctl failure, and unknown target.
- Create `tests/live/openrouter.live.test.ts`: real OpenRouter probe test, skipped unless `RUN_UI_DIFF_LIVE=1`.
- Create `tests/live/locateanything.live.test.ts`: real LocateAnything sidecar contract test, skipped unless `RUN_UI_DIFF_LIVE=1`.
- Create `tests/live/mcp-full.live.test.ts`: real MCP `discover_ui_diffs` full run through stdio, skipped unless `RUN_UI_DIFF_LIVE=1`.
- Create `tests/live/calorix-smoke.live.test.ts`: optional real Calorix image-pair smoke run, skipped unless `RUN_CALORIX_UI_DIFF_LIVE=1`.
- Modify `package.json`: add scripts for integration and live release gates.
- Modify `vitest.config.ts`: exclude child-process integration tests and live tests from coverage.
- Modify `README.md`: document deterministic verification, live release gates, env vars, and Calorix smoke command.
- Modify `docs/implementation-status.md`: record this production-readiness test plan as the active next task.
- Create `docs/release/production-readiness-checklist.md`: exact commands and required evidence for production sign-off.

## Test Policy

Default commands:

```bash
npm run verify
npm run test:coverage
```

These must stay deterministic and not require API keys, connected devices, or a running sidecar.

Live release commands:

```bash
npm run verify:live
npm run verify:calorix-live
```

These may use real APIs and real sidecar/device state. When enabled, missing environment variables must fail loudly.

Live gate variables:

```text
RUN_UI_DIFF_LIVE=1
OPENROUTER_API_KEY=<real key>
LOCATEANYTHING_SIDECAR_URL=http://127.0.0.1:39731
```

Optional Calorix gate variables:

```text
RUN_CALORIX_UI_DIFF_LIVE=1
UI_DIFF_LIVE_EXPECTED_IMAGE=C:/absolute/path/to/mockup.png
UI_DIFF_LIVE_ACTUAL_IMAGE=C:/absolute/path/to/screenshot.png
```

## Task 1: Add MCP SDK Test Helper

**Files:**
- Create: `tests/helpers/mcp-client.ts`
- Test: used by later tasks

- [ ] **Step 1: Write helper file**

Create `tests/helpers/mcp-client.ts`:

```ts
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
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/src/index.js"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...extraEnv
    },
    stderr: "pipe"
  });

  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
    }
  };
}
```

- [ ] **Step 2: Build before using helper**

Run:

```bash
npm run build
```

Expected: exit code 0 and `dist/src/index.js` exists.

- [ ] **Step 3: Commit**

Run:

```bash
git add tests/helpers/mcp-client.ts
git commit -m "test: add mcp client helper"
git push
```

## Task 2: Refactor MCP Handlers For In-Process Coverage

**Files:**
- Modify: `src/server.ts`
- Create: `tests/unit/server-handlers.test.ts`

- [ ] **Step 1: Export injectable server dependencies**

Modify `src/server.ts` to export dependency types and defaults above `createServer()`:

```ts
import type { RunInput, RunOutput } from "./pipeline/run-ui-diff.js";
import type { ModelEntry } from "./models/model-registry.js";
import type { ProbeResult } from "./models/probes.js";

export interface ServerDeps {
  runUiDiff: (input: RunInput) => Promise<RunOutput>;
  captureMobileScreen: (target: "adb" | "ios-simctl") => Promise<string>;
  probeRequiredModels: (entries: ModelEntry[], openRouterApiKey: string) => Promise<ProbeResult[]>;
  getRequiredModels: () => ModelEntry[];
  readFile: typeof fs.readFile;
}

export const defaultServerDeps: ServerDeps = {
  runUiDiff,
  captureMobileScreen,
  probeRequiredModels,
  getRequiredModels,
  readFile: fs.readFile
};
```

- [ ] **Step 2: Export testable handler functions**

Move the current inline tool callback bodies into these exported functions in `src/server.ts`:

```ts
export async function handleCompareUiImages(
  input: {
    expectedImagePath: string;
    actualImagePath: string;
    projectRoot?: string | undefined;
    runLabel?: string | undefined;
    mode?: "full" | "deterministic_only" | "free_only" | undefined;
  },
  deps: ServerDeps,
  forcedMode?: "deterministic_only"
) {
  const runInput = forcedMode === "deterministic_only"
    ? buildRunInput({ ...input, mode: "deterministic_only" })
    : buildRunInput(input);
  const result = await deps.runUiDiff(runInput);
  return {
    content: [{ type: "text" as const, text: result.summary }],
    structuredContent: toRecord(result)
  };
}

export async function handleModelHealth(deps: ServerDeps) {
  const apiKey = process.env["OPENROUTER_API_KEY"] ?? "";
  const results = await deps.probeRequiredModels(deps.getRequiredModels(), apiKey);
  const output = {
    checkedAt: new Date().toISOString(),
    results: results.map(r => ({
      role: r.role,
      provider: r.provider,
      model: r.model,
      status: r.status,
      ...(r.detail !== undefined ? { detail: r.detail } : {})
    }))
  };
  const passing = results.filter(r => r.status === "pass").length;
  return {
    content: [{ type: "text" as const, text: `Model health checked: ${passing}/${results.length} passing.` }],
    structuredContent: toRecord(output)
  };
}

export async function handleReadUiDiffReport(input: { reportPath: string }, deps: ServerDeps) {
  if (!input.reportPath.endsWith(".json")) {
    throw new Error("reportPath must be a .json file");
  }
  const resolved = path.resolve(input.reportPath);
  const needle = path.sep + ".ui-diff" + path.sep + "runs" + path.sep;
  if (!resolved.includes(needle)) {
    throw new Error("reportPath must be within a .ui-diff/runs/ directory");
  }
  const raw = await deps.readFile(resolved, "utf8");
  const parsed = UiDiffReportSchema.parse(JSON.parse(raw));
  return {
    content: [{ type: "text" as const, text: `Report loaded: run ${parsed.runId}, ${parsed.diffs.length} diffs.` }],
    structuredContent: toRecord({ report: parsed })
  };
}

export async function handleCaptureMobileScreen(
  input: { target: "adb" | "ios-simctl" },
  deps: ServerDeps
) {
  const imagePath = await deps.captureMobileScreen(input.target);
  return {
    content: [{ type: "text" as const, text: `Screenshot captured to ${imagePath}` }],
    structuredContent: toRecord({ imagePath })
  };
}
```

- [ ] **Step 3: Wire `createServer` to handlers**

Change `createServer` to accept dependencies and call the exported handlers:

```ts
export function createServer(deps: ServerDeps = defaultServerDeps): McpServer {
  const server = new McpServer({
    name: "ui-diff-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "compare_ui_images",
    {
      description: "Compares an expected mobile mockup image against an actual mobile screenshot using only deterministic methods (no visual models).",
      inputSchema: CompareUiImagesInputSchema,
      outputSchema: CompareUiImagesOutputSchema
    },
    async (input) => handleCompareUiImages(input, deps, "deterministic_only")
  );

  server.registerTool(
    "discover_ui_diffs",
    {
      description: "Runs full UI diff analysis, including visual model-based target discovery and classification. Compares expected mockup against actual screenshot.",
      inputSchema: CompareUiImagesInputSchema,
      outputSchema: CompareUiImagesOutputSchema
    },
    async (input) => handleCompareUiImages(input, deps)
  );

  server.registerTool(
    "ui_diff_model_health",
    {
      description: "Checks health of all visual models used by the diff pipeline.",
      outputSchema: ModelHealthOutputSchema
    },
    async () => handleModelHealth(deps)
  );

  server.registerTool(
    "read_ui_diff_report",
    {
      description: "Reads and returns a previously generated UI diff report JSON file.",
      inputSchema: { reportPath: z.string().min(1) },
      outputSchema: ReadUiDiffReportOutputSchema
    },
    async (input) => handleReadUiDiffReport(input, deps)
  );

  server.registerTool(
    "capture_mobile_screen",
    {
      description: "Captures a screenshot from a connected mobile device using adb or ios-simctl.",
      inputSchema: { target: z.enum(["adb", "ios-simctl"]) },
      outputSchema: CaptureScreenOutputSchema
    },
    async (input) => handleCaptureMobileScreen(input, deps)
  );

  return server;
}
```

- [ ] **Step 4: Add handler unit tests**

Create `tests/unit/server-handlers.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  handleCaptureMobileScreen,
  handleCompareUiImages,
  handleModelHealth,
  handleReadUiDiffReport,
  type ServerDeps
} from "../../src/server.js";
import type { RunOutput } from "../../src/pipeline/run-ui-diff.js";
import type { UiDiffReport } from "../../src/schemas/core.js";

function runOutput(overrides: Partial<RunOutput> = {}): RunOutput {
  return {
    runId: "run-test",
    status: "complete",
    diffCount: 1,
    reportPath: "C:/project/.ui-diff/runs/run-test/artifacts/report.json",
    artifactRoot: "C:/project/.ui-diff/runs/run-test/artifacts",
    runArtifacts: ["pixel-diff.png", "diff-overlay.png"],
    summary: "Found 1 visual difference.",
    warnings: [],
    ...overrides
  };
}

function report(): UiDiffReport {
  return {
    schemaVersion: "0.1",
    runId: "run-test",
    createdAt: new Date().toISOString(),
    status: "complete",
    visualClassificationStatus: "not_run",
    expectedImagePath: "C:/project/expected.png",
    actualImagePath: "C:/project/actual.png",
    artifactRoot: "C:/project/.ui-diff/runs/run-test/artifacts",
    elements: { expected: [], actual: [] },
    pairs: [],
    diffs: [],
    modelHealth: [],
    runArtifacts: [],
    warnings: []
  };
}

function deps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    runUiDiff: vi.fn().mockResolvedValue(runOutput()),
    captureMobileScreen: vi.fn().mockResolvedValue("C:/tmp/screen.png"),
    probeRequiredModels: vi.fn().mockResolvedValue([
      { role: "auditor", provider: "openrouter", model: "qwen/qwen3-vl-30b-a3b-instruct", status: "not_checked", checkedAt: new Date().toISOString(), detail: "No API key provided" },
      { role: "reviewer", provider: "openrouter", model: "google/gemini-2.5-flash-lite", status: "not_checked", checkedAt: new Date().toISOString(), detail: "No API key provided" }
    ]),
    getRequiredModels: vi.fn().mockReturnValue([
      { role: "auditor", provider: "openrouter", model: "qwen/qwen3-vl-30b-a3b-instruct", probeTtlMs: 1, required: true },
      { role: "reviewer", provider: "openrouter", model: "google/gemini-2.5-flash-lite", probeTtlMs: 1, required: true }
    ]),
    readFile: vi.fn().mockResolvedValue(JSON.stringify(report())),
    ...overrides
  };
}

describe("server tool handlers", () => {
  it("compare handler forces deterministic mode", async () => {
    const d = deps();
    const result = await handleCompareUiImages({
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      projectRoot: "C:/project",
      mode: "full"
    }, d, "deterministic_only");
    expect(d.runUiDiff).toHaveBeenCalledWith({
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      projectRoot: "C:/project",
      mode: "deterministic_only"
    });
    expect(result.structuredContent).toMatchObject({ status: "complete", diffCount: 1 });
  });

  it("discover handler preserves full mode", async () => {
    const d = deps();
    await handleCompareUiImages({
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      projectRoot: "C:/project",
      mode: "full"
    }, d);
    expect(d.runUiDiff).toHaveBeenCalledWith({
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      projectRoot: "C:/project",
      mode: "full"
    });
  });

  it("model health handler returns structured health", async () => {
    const result = await handleModelHealth(deps());
    const structured = result.structuredContent as { results: Array<{ status: string }> };
    expect(structured.results).toHaveLength(2);
    expect(structured.results.every(r => r.status === "not_checked")).toBe(true);
    expect(result.content[0]?.text).toContain("0/2 passing");
  });

  it("read report handler rejects paths outside .ui-diff/runs", async () => {
    await expect(handleReadUiDiffReport({ reportPath: "C:/tmp/report.json" }, deps())).rejects.toThrow(/within a .ui-diff\/runs/);
  });

  it("read report handler parses valid report json", async () => {
    const reportPath = path.join("C:", "project", ".ui-diff", "runs", "run-test", "artifacts", "report.json");
    const result = await handleReadUiDiffReport({ reportPath }, deps());
    expect(result.structuredContent).toMatchObject({ report: { runId: "run-test" } });
  });

  it("capture handler returns structured image path", async () => {
    const d = deps();
    const result = await handleCaptureMobileScreen({ target: "adb" }, d);
    expect(d.captureMobileScreen).toHaveBeenCalledWith("adb");
    expect(result.structuredContent).toEqual({ imagePath: "C:/tmp/screen.png" });
  });
});
```

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm run test -- tests/unit/server-handlers.test.ts tests/unit/server.test.ts
npm run test:coverage
```

Expected: tests pass and `src/server.ts` coverage is at least 70% statements.

Commit and push:

```bash
git add src/server.ts tests/unit/server-handlers.test.ts
git commit -m "test: cover mcp tool handlers"
git push
```

## Task 3: Add Committed MCP SDK Integration Tests

**Files:**
- Create: `tests/integration/mcp-tools.integration.test.ts`
- Modify: `package.json`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Add npm scripts**

Modify `package.json` scripts. Keep integration tests outside plain `npm test` because they spawn the built production artifact:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run --exclude \"tests/live/**/*.test.ts\" --exclude \"tests/integration/**/*.test.ts\"",
    "test:integration": "npm run build && vitest run tests/integration/**/*.test.ts",
    "test:watch": "vitest --exclude \"tests/live/**/*.test.ts\" --exclude \"tests/integration/**/*.test.ts\"",
    "test:coverage": "vitest run --coverage --exclude \"tests/live/**/*.test.ts\" --exclude \"tests/integration/**/*.test.ts\"",
    "test:live": "vitest run tests/live/**/*.test.ts --testTimeout 180000",
    "verify": "npm run typecheck && npm test && npm run build && npm run test:integration",
    "verify:live": "npm run build && npm run test:live",
    "start": "node dist/src/index.js"
  }
}
```

- [ ] **Step 2: Keep live and child-process integration tests out of coverage**

Modify `vitest.config.ts` coverage section:

```ts
coverage: {
  provider: "v8",
  reporter: ["text", "lcov"],
  include: ["src/**/*.ts"],
  exclude: ["src/index.ts", "tests/live/**/*.test.ts", "tests/integration/**/*.test.ts"],
  thresholds: {
    statements: 80,
    branches: 63,
    functions: 80,
    lines: 80
  }
}
```

- [ ] **Step 3: Write MCP integration tests**

Create `tests/integration/mcp-tools.integration.test.ts`:

```ts
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
        mode: "full"
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
```

- [ ] **Step 4: Run the integration tests**

Run:

```bash
npm run test:integration
```

Expected: all MCP integration tests pass.

- [ ] **Step 5: Run verification and coverage**

Run:

```bash
npm run verify
npm run test:coverage
```

Expected: all tests pass and coverage thresholds still pass. The `src/server.ts` coverage target is owned by Task 2 because child-process stdio tests do not contribute V8 coverage to the parent Vitest process.

- [ ] **Step 6: Commit**

Run:

```bash
git add package.json vitest.config.ts tests/integration/mcp-tools.integration.test.ts
git commit -m "test: cover mcp tool surface through sdk client"
git push
```

## Task 4: Make Mobile Capture Testable Without Devices

**Files:**
- Modify: `src/capture/mobile-capture.ts`
- Create: `tests/unit/mobile-capture.test.ts`
- Modify: `tests/unit/tools.test.ts`

- [ ] **Step 1: Refactor capture to inject command runner**

Replace `src/capture/mobile-capture.ts` with:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

export type CaptureTarget = "adb" | "ios-simctl";

export interface CommandRunner {
  (file: string, args: string[], options: { timeout: number; encoding?: "buffer" }): Promise<unknown>;
}

export interface CaptureOptions {
  runner?: CommandRunner;
  makeOutputPath?: () => string;
}

const defaultRunner: CommandRunner = (file, args, options) => execFileAsync(file, args, options);

function defaultOutputPath(): string {
  return path.join(os.tmpdir(), `ui-diff-capture-${crypto.randomBytes(4).toString("hex")}.png`);
}

export async function captureMobileScreen(
  target: CaptureTarget,
  opts: CaptureOptions = {}
): Promise<string> {
  const runner = opts.runner ?? defaultRunner;
  const outPath = opts.makeOutputPath?.() ?? defaultOutputPath();

  if (target === "adb") {
    try {
      await runner("adb", ["exec-out", "screencap", "-p"], {
        encoding: "buffer",
        timeout: 30000
      });
      await runner("adb", ["shell", "screencap", "-p", "/sdcard/screen.png"], { timeout: 30000 });
      await runner("adb", ["pull", "/sdcard/screen.png", outPath], { timeout: 30000 });
      return outPath;
    } catch (err) {
      throw new Error(`adb capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (target === "ios-simctl") {
    try {
      await runner("xcrun", ["simctl", "io", "booted", "screenshot", outPath], { timeout: 30000 });
      return outPath;
    } catch (err) {
      throw new Error(`ios-simctl capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`Unsupported capture target: ${target}`);
}
```

- [ ] **Step 2: Add capture tests**

Create `tests/unit/mobile-capture.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { captureMobileScreen, type CommandRunner } from "../../src/capture/mobile-capture.js";

function runnerOk(): ReturnType<typeof vi.fn<CommandRunner>> {
  return vi.fn<CommandRunner>().mockResolvedValue(undefined);
}

describe("captureMobileScreen", () => {
  it("runs adb capture commands with argument arrays and returns output path", async () => {
    const runner = runnerOk();
    const out = await captureMobileScreen("adb", {
      runner,
      makeOutputPath: () => "C:/tmp/ui-diff-capture.png"
    });

    expect(out).toBe("C:/tmp/ui-diff-capture.png");
    expect(runner).toHaveBeenNthCalledWith(
      1,
      "adb",
      ["exec-out", "screencap", "-p"],
      { encoding: "buffer", timeout: 30000 }
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "adb",
      ["shell", "screencap", "-p", "/sdcard/screen.png"],
      { timeout: 30000 }
    );
    expect(runner).toHaveBeenNthCalledWith(
      3,
      "adb",
      ["pull", "/sdcard/screen.png", "C:/tmp/ui-diff-capture.png"],
      { timeout: 30000 }
    );
  });

  it("wraps adb command failures", async () => {
    const runner = vi.fn<CommandRunner>().mockRejectedValue(new Error("adb missing"));
    await expect(captureMobileScreen("adb", { runner })).rejects.toThrow(/adb capture failed: adb missing/);
  });

  it("runs ios simulator screenshot command with argument array", async () => {
    const runner = runnerOk();
    const out = await captureMobileScreen("ios-simctl", {
      runner,
      makeOutputPath: () => "C:/tmp/ios.png"
    });

    expect(out).toBe("C:/tmp/ios.png");
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "io", "booted", "screenshot", "C:/tmp/ios.png"],
      { timeout: 30000 }
    );
  });

  it("wraps ios simulator command failures", async () => {
    const runner = vi.fn<CommandRunner>().mockRejectedValue(new Error("no booted simulator"));
    await expect(captureMobileScreen("ios-simctl", { runner })).rejects.toThrow(/ios-simctl capture failed: no booted simulator/);
  });

  it("rejects unknown target kinds", async () => {
    await expect(captureMobileScreen("unknown" as "adb")).rejects.toThrow(/Unsupported capture target/);
  });
});
```

- [ ] **Step 3: Remove duplicate weak capture test**

Modify `tests/unit/tools.test.ts` so it only contains the server construction test:

```ts
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/server.js";

describe("MCP Tool Surface", () => {
  it("createServer returns a truthy MCP server", () => {
    const server = createServer();
    expect(server).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run unit tests and coverage**

Run:

```bash
npm run test -- tests/unit/mobile-capture.test.ts tests/unit/tools.test.ts
npm run test:coverage
```

Expected: tests pass and `src/capture/mobile-capture.ts` coverage is at least 90% statements.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/capture/mobile-capture.ts tests/unit/mobile-capture.test.ts tests/unit/tools.test.ts
git commit -m "test: cover mobile capture command paths"
git push
```

## Task 5: Add Live OpenRouter and LocateAnything Release Gates

**Files:**
- Create: `tests/live/openrouter.live.test.ts`
- Create: `tests/live/locateanything.live.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Add live OpenRouter probe test**

Create `tests/live/openrouter.live.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { getRequiredModels } from "../../src/models/model-registry.js";
import { probeRequiredModels } from "../../src/models/probes.js";

const liveEnabled = process.env["RUN_UI_DIFF_LIVE"] === "1";

describe.skipIf(!liveEnabled)("live OpenRouter model probes", () => {
  test("required auditor and reviewer models pass real image+JSON probes", async () => {
    const apiKey = process.env["OPENROUTER_API_KEY"];
    expect(apiKey, "OPENROUTER_API_KEY must be set when RUN_UI_DIFF_LIVE=1").toBeTruthy();

    const results = await probeRequiredModels(getRequiredModels(), apiKey!);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status, `${result.role} ${result.model}: ${result.detail ?? ""}`).toBe("pass");
    }
  }, 120000);
});
```

- [ ] **Step 2: Add live LocateAnything sidecar contract test**

Create `tests/live/locateanything.live.test.ts`:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { locateUiElements } from "../../src/locator/locateanything-client.js";
import { writeTwoButtonFixture } from "../../src/testing/fixture-images.js";

const liveEnabled = process.env["RUN_UI_DIFF_LIVE"] === "1";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-live-locator-"));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!liveEnabled)("live LocateAnything sidecar", () => {
  test("returns valid in-bounds UI element boxes for a generated fixture", async () => {
    const endpoint = process.env["LOCATEANYTHING_SIDECAR_URL"];
    expect(endpoint, "LOCATEANYTHING_SIDECAR_URL must be set when RUN_UI_DIFF_LIVE=1").toBeTruthy();

    const { expected } = await writeTwoButtonFixture(tmpDir, "expected.png", "actual.png");
    const response = await locateUiElements({
      endpoint: endpoint!,
      request: {
        imagePath: expected,
        queries: [
          { id: "text", prompt: "Detect all text in box format." },
          { id: "button", prompt: "Locate all buttons and tappable controls." },
          { id: "card", prompt: "Locate all cards and panels." }
        ],
        generationMode: "hybrid",
        maxBoxesPerQuery: 50
      },
      timeoutMs: 120000
    });

    expect(response.model).toContain("LocateAnything");
    expect(response.image.width).toBe(200);
    expect(response.image.height).toBe(400);
    expect(response.elements.length).toBeGreaterThan(0);
    for (const element of response.elements) {
      expect(element.box.x).toBeGreaterThanOrEqual(0);
      expect(element.box.y).toBeGreaterThanOrEqual(0);
      expect(element.box.x + element.box.width).toBeLessThanOrEqual(response.image.width);
      expect(element.box.y + element.box.height).toBeLessThanOrEqual(response.image.height);
      expect(element.rawBox1000).toHaveLength(4);
    }
  }, 180000);
});
```

- [ ] **Step 3: Document live gate variables**

Add this section to `README.md`:

````md
## Live Release Gates

The default `npm run verify` command is deterministic and does not call external APIs.
Before production use, run the live gates with real credentials and a real LocateAnything sidecar:

```powershell
$env:RUN_UI_DIFF_LIVE="1"
$env:OPENROUTER_API_KEY="<real-openrouter-key>"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
npm run verify:live
```

`verify:live` must pass before declaring the MCP production-ready. It calls OpenRouter and the LocateAnything sidecar directly; rate limits, missing keys, and unavailable sidecars are release blockers for that run.
````

- [ ] **Step 4: Run default verification**

Run:

```bash
npm run verify
npm run test:coverage
```

Expected: live tests are skipped by default and coverage thresholds pass.

- [ ] **Step 5: Run live verification if credentials are available**

If `OPENROUTER_API_KEY` and `LOCATEANYTHING_SIDECAR_URL` are available, run:

```bash
npm run verify:live
```

Expected when env vars are set and services are healthy: live tests pass.

Expected when env vars are not set: do not run this command; record "not run: missing live env" in `docs/implementation-status.md`.

- [ ] **Step 6: Commit**

Run:

```bash
git add README.md tests/live/openrouter.live.test.ts tests/live/locateanything.live.test.ts
git commit -m "test: add live model and locator release gates"
git push
```

## Task 6: Add Live Full MCP Release Gate

**Files:**
- Create: `tests/live/mcp-full.live.test.ts`
- Modify: `docs/release/production-readiness-checklist.md`

- [ ] **Step 1: Add live full MCP test**

Create `tests/live/mcp-full.live.test.ts`:

```ts
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
    }, { timeout: 180000, maxTotalTimeout: 240000 });

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
```

- [ ] **Step 2: Create release checklist**

Create `docs/release/production-readiness-checklist.md`:

````md
# Production Readiness Checklist

Run this checklist before calling `ui-diff-mcp` production-ready.

## Deterministic Gates

```powershell
npm run verify
npm run test:coverage
npm audit
```

Required result:

- Typecheck passes.
- Unit and integration tests pass.
- Coverage thresholds pass.
- `npm audit` reports no critical vulnerability.

## Live Gates

```powershell
$env:RUN_UI_DIFF_LIVE="1"
$env:OPENROUTER_API_KEY="<real-openrouter-key>"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
npm run verify:live
```

Required result:

- OpenRouter auditor and reviewer probes pass.
- LocateAnything sidecar returns valid in-bounds boxes.
- `discover_ui_diffs` completes through the MCP stdio server.
- The report has `status: "complete"` and `visualClassificationStatus: "complete"`.
- Required model health entries are `pass`.
- The report includes normalized images, pixel diff, overlay, report JSON, and artifact index.

## Optional Calorix Gate

```powershell
$env:RUN_CALORIX_UI_DIFF_LIVE="1"
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\absolute\path\to\mockup.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\absolute\path\to\screenshot.png"
npm run verify:calorix-live
```

Required result:

- Calorix image pair runs through `discover_ui_diffs`.
- Report path is recorded in the release note.
- Result is not `failed`.
- If visual classification is incomplete, the release note records the exact missing provider or sidecar reason.

## Sign-Off Record

Append a dated note to `docs/implementation-status.md` with:

- Commit SHA.
- Deterministic gate output summary.
- Live gate output summary.
- Calorix gate output summary or reason it was not run.
- Any remaining P2 risks.
````

- [ ] **Step 3: Run default verification**

Run:

```bash
npm run verify
npm run test:coverage
```

Expected: all deterministic gates pass.

- [ ] **Step 4: Run live full gate if env is available**

Run only when live env is configured:

```bash
npm run verify:live
```

Expected: full live MCP test passes. If it fails due rate limit or provider outage, record exact provider status in `docs/implementation-status.md`.

- [ ] **Step 5: Commit**

Run:

```bash
git add tests/live/mcp-full.live.test.ts docs/release/production-readiness-checklist.md
git commit -m "test: add live full mcp release gate"
git push
```

## Task 7: Add Optional Calorix Live Smoke Gate

**Files:**
- Create: `tests/live/calorix-smoke.live.test.ts`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add Calorix live script**

Modify `package.json` scripts:

```json
{
  "scripts": {
    "verify:calorix-live": "npm run build && vitest run tests/live/calorix-smoke.live.test.ts --testTimeout 240000"
  }
}
```

Keep all existing scripts unchanged.

- [ ] **Step 2: Add Calorix live test**

Create `tests/live/calorix-smoke.live.test.ts`:

```ts
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
      }, { timeout: 180000, maxTotalTimeout: 240000 });

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
```

- [ ] **Step 3: Document Calorix live smoke**

Add this to the README live gate section:

````md
### Optional Calorix Live Smoke

Use a real Calorix mockup/screenshot pair when available:

```powershell
$env:RUN_CALORIX_UI_DIFF_LIVE="1"
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\absolute\path\to\mockup.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\absolute\path\to\screenshot.png"
$env:OPENROUTER_API_KEY="<real-openrouter-key>"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
npm run verify:calorix-live
```
````

- [ ] **Step 4: Run default verification**

Run:

```bash
npm run verify
npm run test:coverage
```

Expected: deterministic tests pass; Calorix live test is skipped unless enabled.

- [ ] **Step 5: Commit**

Run:

```bash
git add package.json README.md tests/live/calorix-smoke.live.test.ts
git commit -m "test: add optional calorix live smoke gate"
git push
```

## Task 8: Raise Coverage Gates and Update Tracking

**Files:**
- Modify: `vitest.config.ts`
- Modify: `docs/implementation-status.md`

- [ ] **Step 1: Raise coverage thresholds after new tests pass**

Modify `vitest.config.ts` thresholds:

```ts
thresholds: {
  statements: 85,
  branches: 68,
  functions: 85,
  lines: 85
}
```

Only apply these exact values after `npm run test:coverage` reports at least these percentages.

- [ ] **Step 2: Update implementation status**

Modify `docs/implementation-status.md` Current State:

```md
- Status: production-readiness test plan implemented; live release gates added.
- Current task: none.
- Next task: run live gates with real OpenRouter key, real LocateAnything sidecar, and Calorix image pair before production sign-off.
- Last verification: `npm run verify` and `npm run test:coverage` — passed after production-readiness tests.
- Open blockers: live release gates require configured external services before final production sign-off.
```

After committing the implementation tasks, run:

```bash
git rev-parse --short HEAD
```

Append a progress-log row using the exact hash printed by that command:

```md
| 2026-06-13 | `actual-hash-from-git-rev-parse` | Production-readiness tests | `npm run verify`; `npm run test:coverage` | Added MCP SDK integration tests, capture tests, live OpenRouter/LocateAnything/full MCP gates, and Calorix live smoke gate. |
```

Do not leave the literal string `actual-hash-from-git-rev-parse` in the status file.

- [ ] **Step 3: Run final deterministic gates**

Run:

```bash
npm run verify
npm run test:coverage
git diff --check
git status --short
```

Expected:

- `npm run verify` passes.
- `npm run test:coverage` passes raised thresholds.
- `git diff --check` is clean.
- Only intended docs/config changes are unstaged before commit.

- [ ] **Step 4: Commit and push**

Run:

```bash
git add vitest.config.ts docs/implementation-status.md
git commit -m "docs: track production readiness test gates"
git push
```

## Acceptance Checks

- `npm run verify` passes without credentials or sidecar.
- `npm run test:coverage` passes with thresholds at or above 85 statements, 68 branches, 85 functions, 85 lines.
- `src/server.ts` committed coverage is at least 70% statements.
- `src/capture/mobile-capture.ts` committed coverage is at least 90% statements.
- MCP SDK integration tests call all production MCP tools through stdio.
- MCP SDK integration tests verify structured content for `compare_ui_images`, `read_ui_diff_report`, and `ui_diff_model_health`.
- MCP SDK integration tests verify validation/error behavior for invalid tool input and report path rejection.
- Capture tests prove adb and ios-simctl use explicit command/argument arrays and wrap command failures.
- `npm run verify:live` exists and runs real OpenRouter and real LocateAnything sidecar tests when `RUN_UI_DIFF_LIVE=1`.
- Live tests fail loudly when enabled but required env vars are missing.
- Live tests are skipped by default and excluded from coverage.
- `npm run verify:calorix-live` exists and runs a real Calorix image pair when `RUN_CALORIX_UI_DIFF_LIVE=1`.
- README documents Claude/Codex setup, deterministic verification, live release gates, and Calorix live smoke.
- Production readiness checklist records exact sign-off commands and evidence requirements.
- No manual target maps, ROI maps, ignore masks, anchor dumps, causality explanations, app-edit recommendations, or MCP-edit recommendations are introduced.
- Every repository change is committed and pushed.

## Gemini Review

Gemini 3 Pro Preview review attempt 1:

- `AGREEMENT_STATUS: blocked`
- Tool/model: `gemini-3-pro-preview` through `mcp__gemini_cli.brainstorm`
- Result: Gemini CLI returned `QUOTA_EXHAUSTED`.
- Reported reset: about 4h20m after the attempt on 2026-06-13.
- Required follow-up before executing this plan: retry `gemini-3-pro-preview` review and append its blocker-focused response here. If Gemini returns any `MUST_FIX`, revise this plan and repeat review until `AGREEMENT_STATUS: agree`.
