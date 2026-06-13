import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CompareUiImagesInputSchema,
  CompareUiImagesOutputSchema,
  ModelHealthOutputSchema,
  ReadUiDiffReportOutputSchema,
  CaptureScreenOutputSchema
} from "./schemas/tool-schemas.js";
import { runUiDiff } from "./pipeline/run-ui-diff.js";
import { captureMobileScreen } from "./capture/mobile-capture.js";
import { probeRequiredModels } from "./models/probes.js";
import { getRequiredModels } from "./models/model-registry.js";
import { UiDiffReportSchema } from "./schemas/core.js";

function toRecord(v: unknown): Record<string, unknown> {
  return v as Record<string, unknown>;
}

function buildRunInput(input: {
  expectedImagePath: string;
  actualImagePath: string;
  projectRoot?: string | undefined;
  runLabel?: string | undefined;
  mode?: "full" | "deterministic_only" | "free_only" | undefined;
}) {
  return {
    expectedImagePath: input.expectedImagePath,
    actualImagePath: input.actualImagePath,
    mode: input.mode ?? "full",
    ...(input.projectRoot !== undefined ? { projectRoot: input.projectRoot } : {}),
    ...(input.runLabel !== undefined ? { runLabel: input.runLabel } : {})
  };
}

export function createServer(): McpServer {
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
    async (input) => {
      const result = await runUiDiff(buildRunInput({ ...input, mode: "deterministic_only" }));
      return {
        content: [{ type: "text" as const, text: result.summary }],
        structuredContent: toRecord(result)
      };
    }
  );

  server.registerTool(
    "discover_ui_diffs",
    {
      description: "Runs full UI diff analysis, including visual model-based target discovery and classification. Compares expected mockup against actual screenshot.",
      inputSchema: CompareUiImagesInputSchema,
      outputSchema: CompareUiImagesOutputSchema
    },
    async (input) => {
      const result = await runUiDiff(buildRunInput(input));
      return {
        content: [{ type: "text" as const, text: result.summary }],
        structuredContent: toRecord(result)
      };
    }
  );

  server.registerTool(
    "ui_diff_model_health",
    {
      description: "Checks health of all visual models used by the diff pipeline.",
      outputSchema: ModelHealthOutputSchema
    },
    async () => {
      const apiKey = process.env["OPENROUTER_API_KEY"] ?? "";
      const results = await probeRequiredModels(getRequiredModels(), apiKey);
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
  );

  server.registerTool(
    "read_ui_diff_report",
    {
      description: "Reads and returns a previously generated UI diff report JSON file.",
      inputSchema: { reportPath: z.string().min(1) },
      outputSchema: ReadUiDiffReportOutputSchema
    },
    async (input) => {
      if (!input.reportPath.endsWith(".json")) {
        throw new Error("reportPath must be a .json file");
      }
      const resolved = path.resolve(input.reportPath);
      const needle = path.sep + ".ui-diff" + path.sep + "runs" + path.sep;
      if (!resolved.includes(needle)) {
        throw new Error("reportPath must be within a .ui-diff/runs/ directory");
      }
      const raw = await fs.readFile(resolved, "utf8");
      const parsed = UiDiffReportSchema.parse(JSON.parse(raw));
      return {
        content: [{ type: "text" as const, text: `Report loaded: run ${parsed.runId}, ${parsed.diffs.length} diffs.` }],
        structuredContent: toRecord({ report: parsed })
      };
    }
  );

  server.registerTool(
    "capture_mobile_screen",
    {
      description: "Captures a screenshot from a connected mobile device using adb or ios-simctl.",
      inputSchema: { target: z.enum(["adb", "ios-simctl"]) },
      outputSchema: CaptureScreenOutputSchema
    },
    async (input) => {
      const imagePath = await captureMobileScreen(input.target);
      return {
        content: [{ type: "text" as const, text: `Screenshot captured to ${imagePath}` }],
        structuredContent: toRecord({ imagePath })
      };
    }
  );

  return server;
}
