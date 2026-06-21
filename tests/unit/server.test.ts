import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createServer } from "../../src/server.js";
import { CompareUiImagesOutputSchema } from "../../src/schemas/tool-schemas.js";

describe("createServer", () => {
  it("creates an MCP server instance", () => {
    const server = createServer();
    expect(server).toBeTruthy();
  });

  it("declares unresolvedRegionCount in compare tool output", () => {
    const outputSchema = z.object(CompareUiImagesOutputSchema);
    const parsed = outputSchema.parse({
      runId: "run-1",
      status: "incomplete",
      diffCount: 1,
      unresolvedRegionCount: 2,
      reportPath: "report.json",
      artifactRoot: "artifacts",
      runArtifacts: [],
      summary: "Found 1 visual difference.",
      warnings: [],
      visualClassificationStatus: "incomplete",
      locatorCoverageStatus: "complete",
      auditLimited: false
    });

    expect(parsed.unresolvedRegionCount).toBe(2);
  });
});
