import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/pipeline/run-store.js", () => ({
  createRunId: vi.fn(() => "run-shared-test"),
  putRun: vi.fn().mockResolvedValue(undefined),
  getRun: vi.fn().mockResolvedValue(undefined)
}));

import {
  handleCaptureMobileScreen,
  handleCompareUiImages,
  handleGetUiDiffRunStatus,
  handleModelHealth,
  handleReadUiDiffReport,
  handleStartUiDiffRun,
  type ServerDeps
} from "../../src/server.js";
import { putRun, getRun } from "../../src/pipeline/run-store.js";
import type { RunOutput } from "../../src/pipeline/run-ui-diff.js";
import type { UiDiffReport } from "../../src/schemas/core.js";

function runOutput(overrides: Partial<RunOutput> = {}): RunOutput {
  return {
    runId: "run-test",
    status: "complete",
    diffCount: 1,
    unresolvedRegionCount: 0,
    reportPath: "C:/project/.ui-diff/runs/run-test/artifacts/report.json",
    artifactRoot: "C:/project/.ui-diff/runs/run-test/artifacts",
    runArtifacts: [
      { role: "pixel_diff" as const, path: "pixel-diff.png" },
      { role: "directional_overlay" as const, path: "diff-overlay.png" }
    ],
    summary: "Found 1 visual difference.",
    warnings: [],
    visualClassificationStatus: "not_run",
    locatorCoverageStatus: "not_run",
    auditLimited: false,
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
    locatorCoverageStatus: "not_run" as const,
    expectedImagePath: "C:/project/expected.png",
    actualImagePath: "C:/project/actual.png",
    artifactRoot: "C:/project/.ui-diff/runs/run-test/artifacts",
    elements: { expected: [], actual: [] },
    pairs: [],
    diffs: [],
    unresolvedRegions: [],
    modelHealth: [],
    runArtifacts: [],
    warnings: [],
    stages: []
  };
}

function deps(overrides: Partial<ServerDeps> = {}): ServerDeps {
  return {
    runUiDiff: vi.fn().mockResolvedValue(runOutput()),
    captureMobileScreen: vi.fn().mockResolvedValue({
      path: "C:/tmp/screen.png",
      width: 1080,
      height: 1920,
      blankPixelRatio: 0.01,
      validationStatus: "ok",
      warnings: []
    }),
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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "server-handler-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

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

  it("compare handler forwards diffScope separately from provider mode", async () => {
    const d = deps();
    await handleCompareUiImages({
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      projectRoot: "C:/project",
      mode: "free",
      diffScope: { kind: "target", query: "scan button" }
    }, d);
    expect(d.runUiDiff).toHaveBeenCalledWith({
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      projectRoot: "C:/project",
      mode: "free",
      diffScope: { kind: "target", query: "scan button" }
    });
  });

  it("start_ui_diff_run forwards diffScope to the background run", async () => {
    const d = deps();
    await handleStartUiDiffRun({
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      projectRoot: tmpDir,
      mode: "deterministic_only",
      diffScope: { kind: "regions", regions: ["top", "nav"] }
    }, d);
    await vi.waitFor(() => expect(d.runUiDiff).toHaveBeenCalled());
    expect(vi.mocked(d.runUiDiff).mock.calls[0]?.[0]).toMatchObject({
      diffScope: { kind: "regions", regions: ["top", "nav"] }
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

  it("read report handler hydrates referenced report parts before returning", async () => {
    const reportPath = path.join("C:", "project", ".ui-diff", "runs", "run-test", "artifacts", "report.json");
    const compact = {
      ...report(),
      diffs: [],
      reportParts: [{ role: "diffs", path: "parts/diffs.json" }]
    };
    const d = deps({
      readFile: vi.fn(async (filePath: string | Buffer | URL) => {
        const p = String(filePath);
        if (p.endsWith("report.json")) return JSON.stringify(compact);
        if (p.endsWith(path.join("parts", "diffs.json"))) {
          return JSON.stringify({
            diffs: [{
              id: "diff-from-part",
              criterion: "geometry",
              severity: "medium",
              title: "Hydrated diff",
              location: { x: 1, y: 2, width: 3, height: 4 },
              evidence: ["Loaded from report part."],
              reviewerStatus: "accepted"
            }]
          });
        }
        throw new Error(`unexpected path ${p}`);
      }) as unknown as typeof fs.readFile
    });

    const result = await handleReadUiDiffReport({ reportPath }, d);
    const out = result.structuredContent as { report: { diffs: Array<{ id: string }> } };
    expect(out.report.diffs).toEqual([{ id: "diff-from-part", criterion: "geometry", severity: "medium", title: "Hydrated diff", location: { x: 1, y: 2, width: 3, height: 4 }, evidence: ["Loaded from report part."], measurements: [], artifactPaths: [], childFindingIds: [], targetIds: [], reviewerStatus: "accepted" }]);
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
    expect(result.structuredContent).toEqual({
      imagePath: "C:/tmp/screen.png",
      capture: {
        width: 1080,
        height: 1920,
        blankPixelRatio: 0.01,
        validationStatus: "ok",
        warnings: []
      }
    });
  });

  it("capture handler throws when validationStatus is not ok", async () => {
    const d = deps({
      captureMobileScreen: vi.fn().mockResolvedValue({
        path: "C:/tmp/screen.png",
        width: 1080,
        height: 1920,
        blankPixelRatio: 0.99,
        validationStatus: "blank",
        warnings: ["Image appears blank (99.0% blank pixels)"]
      })
    });
    await expect(handleCaptureMobileScreen({ target: "adb" }, d)).rejects.toThrow("blank");
  });

  it("start_ui_diff_run returns queued status and a runId", async () => {
    const d = deps();
    const result = await handleStartUiDiffRun({
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      projectRoot: tmpDir,
      mode: "deterministic_only"
    }, d);
    const structured = result.structuredContent as { runId: string; status: string };
    expect(structured.status).toBe("queued");
    expect(structured.runId).toMatch(/^run-/);
    await vi.waitFor(() => expect(d.runUiDiff).toHaveBeenCalled());
    expect(vi.mocked(d.runUiDiff).mock.calls[0]?.[0].runId).toBe(structured.runId);
  });

  it("resumes an interrupted run with the same run ID", async () => {
    vi.mocked(getRun).mockResolvedValueOnce({
      runId: "run-resume",
      status: "interrupted",
      projectRoot: tmpDir,
      startedAt: new Date().toISOString(),
      checkpointPath: path.join(tmpDir, "report.json")
    });
    const d = deps();
    const result = await handleStartUiDiffRun({
      expectedImagePath: "expected.png",
      actualImagePath: "actual.png",
      projectRoot: tmpDir,
      mode: "deterministic_only",
      resumeRunId: "run-resume"
    }, d);
    expect((result.structuredContent as { runId: string }).runId).toBe("run-resume");
    await vi.waitFor(() => expect(d.runUiDiff).toHaveBeenCalled());
    expect(vi.mocked(d.runUiDiff).mock.calls[0]?.[0]).toMatchObject({ runId: "run-resume", resumeRunId: "run-resume" });
  });

  it("get_ui_diff_run_status returns state from getRun including label", async () => {
    const runId = "run-label-test";
    vi.mocked(getRun).mockResolvedValueOnce({
      runId,
      status: "complete",
      projectRoot: tmpDir,
      startedAt: new Date().toISOString(),
      label: "smoke-label"
    });
    const statusResult = await handleGetUiDiffRunStatus({ projectRoot: tmpDir, runId });
    const statusOut = statusResult.structuredContent as { label?: string; status: string };
    expect(statusOut.status).toBe("complete");
    expect(statusOut.label).toBe("smoke-label");
  });

  it("get_ui_diff_run_status returns not_found for unknown runId", async () => {
    const result = await handleGetUiDiffRunStatus({ projectRoot: tmpDir, runId: "nonexistent-run" });
    const structured = result.structuredContent as { status: string };
    expect(structured.status).toBe("not_found");
  });
});
