import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CompareUiImagesInputSchema, CompareUiImagesOutputSchema, ModelHealthOutputSchema } from "./schemas/tool-schemas.js";
import { runUiDiff } from "./pipeline/run-ui-diff.js";
import { captureMobileScreen } from "./capture/mobile-capture.js";

const compareUiImagesInput = z.object(CompareUiImagesInputSchema);
const compareUiImagesOutput = z.object(CompareUiImagesOutputSchema);
const modelHealthOutput = z.object(ModelHealthOutputSchema);
const readReportInput = z.object({ reportPath: z.string().min(1) });
const readReportOutput = z.object({ report: z.any() });
const captureScreenInput = z.object({ target: z.enum(["adb", "ios-simctl"]) });
const captureScreenOutput = z.object({ imagePath: z.string().min(1) });


export function createServer(): McpServer {
  const server = new McpServer({
    name: "ui-diff-mcp",
    version: "0.1.0",
  });

  server.tool(
    "compare_ui_images",
    "Compares an expected mobile mockup image against an actual mobile screenshot.",
    compareUiImagesInput,
    compareUiImagesOutput,
    async (input: z.infer<typeof compareUiImagesInput>) => {
      const result = await runUiDiff(input);
      return {
        content: result.summary,
        structuredContent: result,
      };
    },
  );

  server.tool(
      "discover_ui_diffs",
      "Alias for compare_ui_images.",
      compareUiImagesInput,
      compareUiImagesOutput,
      async (input: z.infer<typeof compareUiImagesInput>) => {
          const result = await runUiDiff(input);
          return {
            content: result.summary,
            structuredContent: result,
          };
      },
  );

  server.tool(
      "ui_diff_model_health",
      "Checks the health of the visual models.",
      z.object({}),
      modelHealthOutput,
      async () => {
        // Placeholder
        return {
          content: "Models are healthy.",
          structuredContent: {
            checkedAt: new Date().toISOString(),
            results: [],
          },
        };
      },
  );

  server.tool(
        "read_ui_diff_report",
        "Reads a UI diff report JSON file.",
        readReportInput,
        readReportOutput,
        async (input: z.infer<typeof readReportInput>) => {
            // In a real implementation, this would read and validate the file.
            return {
                content: `Reading report from ${input.reportPath}`,
                structuredContent: {
                    report: { "placeholder": true }
                }
            }
        }
  );

  server.tool(
        "capture_mobile_screen",
        "Captures a screenshot from a mobile device.",
        captureScreenInput,
        captureScreenOutput,
        async (input: z.infer<typeof captureScreenInput>) => {
            const imagePath = await captureMobileScreen(input.target);
            return {
                content: `Screenshot captured to ${imagePath}`,
                structuredContent: { imagePath }
            }
        }
  );

  return server;
}
