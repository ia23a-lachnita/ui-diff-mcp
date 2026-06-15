import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CompareUiImagesInputSchema,
  CompareUiImagesOutputSchema,
  ModelHealthOutputSchema,
  ReadUiDiffReportOutputSchema,
  CaptureScreenOutputSchema,
  StartUiDiffRunInputSchema,
  StartUiDiffRunOutputSchema,
  GetUiDiffRunStatusInputSchema,
  GetUiDiffRunStatusOutputSchema
} from "./schemas/tool-schemas.js";
import { putRun, getRun } from "./pipeline/run-store.js";
import { runUiDiff, type RunInput, type RunOutput } from "./pipeline/run-ui-diff.js";
import { captureMobileScreen } from "./capture/mobile-capture.js";
import { probeRequiredModels, type ProbeResult } from "./models/probes.js";
import { getRequiredModels, type ModelEntry } from "./models/model-registry.js";
import { UiDiffReportSchema } from "./schemas/core.js";

function toRecord(v: unknown): Record<string, unknown> {
  return v as Record<string, unknown>;
}

function buildRunInput(input: {
  expectedImagePath: string;
  actualImagePath: string;
  projectRoot?: string | undefined;
  runLabel?: string | undefined;
  mode?: string | undefined;
}) {
  return {
    expectedImagePath: input.expectedImagePath,
    actualImagePath: input.actualImagePath,
    mode: input.mode ?? "free",
    ...(input.projectRoot !== undefined ? { projectRoot: input.projectRoot } : {}),
    ...(input.runLabel !== undefined ? { runLabel: input.runLabel } : {})
  };
}

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

const DEFAULT_FOREGROUND_BUDGET_MS = 45000;

export async function handleCompareUiImages(
  input: {
    expectedImagePath: string;
    actualImagePath: string;
    projectRoot?: string | undefined;
    runLabel?: string | undefined;
    mode?: string | undefined;
  },
  deps: ServerDeps,
  forcedMode?: "deterministic_only"
) {
  const runInput = forcedMode === "deterministic_only"
    ? buildRunInput({ ...input, mode: "deterministic_only" })
    : buildRunInput(input);

  const budgetMs = parseInt(process.env["UI_DIFF_FOREGROUND_BUDGET_MS"] ?? String(DEFAULT_FOREGROUND_BUDGET_MS), 10);

  let settled = false;
  const runPromise = deps.runUiDiff(runInput).then(r => { settled = true; return r; });
  const timeoutPromise = new Promise<null>(resolve => setTimeout(() => resolve(null), budgetMs));

  const raceResult = await Promise.race([runPromise, timeoutPromise]);

  if (raceResult !== null) {
    return {
      content: [{ type: "text" as const, text: raceResult.summary }],
      structuredContent: toRecord(raceResult)
    };
  }

  // Budget exceeded — try to surface the latest checkpoint report
  void settled;
  const projectRoot = input.projectRoot ?? process.cwd();
  const runsDir = path.join(projectRoot, ".ui-diff", "runs");
  let incompleteReportPath: string | undefined;
  try {
    const entries = await fs.readdir(runsDir);
    const sorted = entries.sort().reverse();
    for (const entry of sorted) {
      const candidate = path.join(runsDir, entry, "artifacts", "report.json");
      try { await fs.access(candidate); incompleteReportPath = candidate; break; } catch { /* skip */ }
    }
  } catch { /* no runs dir yet */ }

  const pendingPath = incompleteReportPath ?? path.join(projectRoot, ".ui-diff", "runs", "pending", "report.json");
  const incompleteResult = {
    runId: "timeout",
    status: "incomplete",
    diffCount: 0,
    reportPath: pendingPath,
    artifactRoot: path.dirname(pendingPath),
    runArtifacts: [],
    summary: `Run exceeded foreground budget of ${budgetMs}ms. Use start_ui_diff_run for long-running audits.`,
    warnings: [`Foreground budget of ${budgetMs}ms exceeded.`],
    visualClassificationStatus: "incomplete",
    locatorCoverageStatus: "not_run",
    auditLimited: false
  };
  return {
    content: [{ type: "text" as const, text: incompleteResult.summary }],
    structuredContent: toRecord(incompleteResult)
  };
}

export async function handleStartUiDiffRun(
  input: {
    expectedImagePath: string;
    actualImagePath: string;
    projectRoot?: string | undefined;
    mode?: string | undefined;
  },
  deps: ServerDeps
) {
  const projectRoot = input.projectRoot ?? process.cwd();
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runInput = buildRunInput({ ...input, projectRoot });

  const state = { runId, status: "queued" as const, projectRoot, startedAt: new Date().toISOString() };
  await putRun(state);

  void (async () => {
    await putRun({ ...state, status: "running" });
    try {
      const result = await deps.runUiDiff(runInput);
      await putRun({
        ...state,
        status: result.status === "complete" ? "complete" : "incomplete",
        reportPath: result.reportPath,
        artifactRoot: result.artifactRoot,
        completedAt: new Date().toISOString()
      });
    } catch (err) {
      await putRun({
        ...state,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date().toISOString()
      });
    }
  })();

  return {
    content: [{ type: "text" as const, text: `Run ${runId} started. Poll get_ui_diff_run_status or read_ui_diff_report.` }],
    structuredContent: toRecord({ runId, status: "queued", message: `Run started. Poll get_ui_diff_run_status with runId "${runId}".` })
  };
}

export async function handleGetUiDiffRunStatus(
  input: { projectRoot: string; runId: string }
) {
  const found = await getRun(input.projectRoot, input.runId);
  if (!found) {
    return {
      content: [{ type: "text" as const, text: `Run ${input.runId} not found.` }],
      structuredContent: toRecord({ runId: input.runId, status: "not_found" })
    };
  }
  const out: Record<string, unknown> = {
    runId: found.runId,
    status: found.status,
    startedAt: found.startedAt
  };
  if (found.reportPath !== undefined) out["reportPath"] = found.reportPath;
  if (found.artifactRoot !== undefined) out["artifactRoot"] = found.artifactRoot;
  if (found.completedAt !== undefined) out["completedAt"] = found.completedAt;
  if (found.error !== undefined) out["error"] = found.error;
  return {
    content: [{ type: "text" as const, text: `Run ${found.runId}: ${found.status}.` }],
    structuredContent: out
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

  server.registerTool(
    "start_ui_diff_run",
    {
      description: "Starts a UI diff run in the background without holding the MCP request open. Returns a runId to poll with get_ui_diff_run_status. Use this for large or slow audits like Calorix full scans.",
      inputSchema: StartUiDiffRunInputSchema,
      outputSchema: StartUiDiffRunOutputSchema
    },
    async (input) => handleStartUiDiffRun(input, deps)
  );

  server.registerTool(
    "get_ui_diff_run_status",
    {
      description: "Returns the status of a background UI diff run started by start_ui_diff_run.",
      inputSchema: GetUiDiffRunStatusInputSchema,
      outputSchema: GetUiDiffRunStatusOutputSchema
    },
    async (input) => handleGetUiDiffRunStatus(input)
  );

  return server;
}
