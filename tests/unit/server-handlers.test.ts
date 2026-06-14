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
    runArtifacts: [
      { role: "pixel_diff" as const, path: "pixel-diff.png" },
      { role: "directional_overlay" as const, path: "diff-overlay.png" }
    ],
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

  it("compare handler omits projectRoot and forwards runLabel when given", async () => {
    const d = deps();
    await handleCompareUiImages({
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      runLabel: "smoke"
    }, d);
    expect(d.runUiDiff).toHaveBeenCalledWith({
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      mode: "free",
      runLabel: "smoke"
    });
  });

  it("read report handler rejects non-json paths", async () => {
    await expect(
      handleReadUiDiffReport({ reportPath: "C:/project/.ui-diff/runs/run-test/report.txt" }, deps())
    ).rejects.toThrow(/must be a .json file/);
  });

  it("model health handler counts passing models without detail", async () => {
    const d = deps({
      probeRequiredModels: vi.fn().mockResolvedValue([
        { role: "auditor", provider: "openrouter", model: "qwen/qwen3-vl-30b-a3b-instruct", status: "pass", checkedAt: new Date().toISOString() },
        { role: "reviewer", provider: "openrouter", model: "google/gemini-2.5-flash-lite", status: "pass", checkedAt: new Date().toISOString() }
      ])
    });
    const result = await handleModelHealth(d);
    const structured = result.structuredContent as { results: Array<{ status: string; detail?: string }> };
    expect(structured.results.every(r => r.status === "pass")).toBe(true);
    expect(structured.results.every(r => r.detail === undefined)).toBe(true);
    expect(result.content[0]?.text).toContain("2/2 passing");
  });

  it("capture handler returns structured image path", async () => {
    const d = deps();
    const result = await handleCaptureMobileScreen({ target: "adb" }, d);
    expect(d.captureMobileScreen).toHaveBeenCalledWith("adb");
    expect(result.structuredContent).toEqual({ imagePath: "C:/tmp/screen.png" });
  });
});
