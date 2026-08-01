import { describe, expect, it, vi } from "vitest";
import { createServer, handleCompareUiImages, type ServerDeps } from "../../src/server.js";
import type { RunOutput } from "../../src/pipeline/run-ui-diff.js";

function makeRunOutput(overrides: Partial<RunOutput> = {}): RunOutput {
  return {
    runId: "run-1",
    status: "complete",
    diffCount: 0,
    unresolvedRegionCount: 0,
    reportPath: "/tmp/.ui-diff/runs/run-1/artifacts/report.json",
    artifactRoot: "/tmp/.ui-diff/runs/run-1/artifacts",
    runArtifacts: [],
    summary: "No visual differences found.",
    warnings: [],
    visualClassificationStatus: "not_run",
    locatorCoverageStatus: "not_run",
    auditLimited: false,
    ...overrides
  };
}

function makeDeps(result: RunOutput): ServerDeps {
  return {
    runUiDiff: vi.fn().mockResolvedValue(result),
    captureMobileScreen: vi.fn(),
    probeRequiredModels: vi.fn().mockResolvedValue([]),
    getRequiredModels: vi.fn().mockReturnValue([]),
    readFile: vi.fn()
  };
}

describe("MCP Tool Surface", () => {
  it("createServer returns a truthy MCP server", () => {
    const server = createServer();
    expect(server).toBeTruthy();
  });
});

describe("handleCompareUiImages compact output", () => {
  it("includes visualClassificationStatus in structured content", async () => {
    const result = makeRunOutput({ visualClassificationStatus: "complete" });
    const deps = makeDeps(result);
    const output = await handleCompareUiImages(
      { expectedImagePath: "e.png", actualImagePath: "a.png" },
      deps
    );
    expect((output.structuredContent as Record<string, unknown>)["visualClassificationStatus"]).toBe("complete");
  });

  it("includes auditLimited in structured content", async () => {
    const result = makeRunOutput({ auditLimited: true, auditScope: { auditedPairs: 2, totalPairs: 8, auditLimited: true, scopeAuditCalls: 0, scopeFailedAudits: 0, scopeUnresolvedAudits: 0 } });
    const deps = makeDeps(result);
    const output = await handleCompareUiImages(
      { expectedImagePath: "e.png", actualImagePath: "a.png" },
      deps
    );
    const sc = output.structuredContent as Record<string, unknown>;
    expect(sc["auditLimited"]).toBe(true);
  });

  it("bounded smoke shows incomplete visualClassificationStatus alongside complete run status", async () => {
    const result = makeRunOutput({
      status: "complete",
      visualClassificationStatus: "incomplete",
      auditLimited: true,
      auditScope: { auditedPairs: 3, totalPairs: 15, auditLimited: true, limitReason: "max pairs limit", scopeAuditCalls: 0, scopeFailedAudits: 0, scopeUnresolvedAudits: 0 }
    });
    const deps = makeDeps(result);
    const output = await handleCompareUiImages(
      { expectedImagePath: "e.png", actualImagePath: "a.png" },
      deps
    );
    const sc = output.structuredContent as Record<string, unknown>;
    // status can be "complete" while classification is still incomplete on bounded runs
    expect(sc["status"]).toBe("complete");
    expect(sc["visualClassificationStatus"]).toBe("incomplete");
    expect(sc["auditLimited"]).toBe(true);
  });

  it("non-limited run shows auditLimited false", async () => {
    const result = makeRunOutput({ auditLimited: false });
    const deps = makeDeps(result);
    const output = await handleCompareUiImages(
      { expectedImagePath: "e.png", actualImagePath: "a.png" },
      deps
    );
    expect((output.structuredContent as Record<string, unknown>)["auditLimited"]).toBe(false);
  });
});
