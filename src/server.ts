import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CompareUiImagesInputSchema } from "./schemas/tool-schemas.js";
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

  server.tool(
    "compare_ui_images",
    "Compares an expected mobile mockup image against an actual mobile screenshot and reports visible UI differences.",
    CompareUiImagesInputSchema,
    async (input) => {
      const result = await runUiDiff(buildRunInput(input));
      return {
        content: [{ type: "text" as const, text: result.summary }],
        structuredContent: toRecord(result)
      };
    }
  );

  server.tool(
    "discover_ui_diffs",
    "Alias for compare_ui_images. Compares expected mockup against actual screenshot.",
    CompareUiImagesInputSchema,
    async (input) => {
      const result = await runUiDiff(buildRunInput(input));
      return {
        content: [{ type: "text" as const, text: result.summary }],
        structuredContent: toRecord(result)
      };
    }
  );

  server.tool(
    "ui_diff_model_health",
    "Checks health of all visual models used by the diff pipeline.",
    {},
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

  server.tool(
    "read_ui_diff_report",
    "Reads and returns a previously generated UI diff report JSON file.",
    { reportPath: z.string().min(1) },
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

  server.tool(
    "capture_mobile_screen",
    "Captures a screenshot from a connected mobile device using adb or ios-simctl.",
    { target: z.enum(["adb", "ios-simctl"]) },
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
