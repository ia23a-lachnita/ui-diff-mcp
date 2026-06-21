import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRunMemoryForTests, createRunId, putRun, getRun, type RunHandleState } from "../../src/pipeline/run-store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-store-test-"));
});

afterEach(async () => {
  clearRunMemoryForTests();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeState(overrides: Partial<RunHandleState> = {}): RunHandleState {
  return {
    runId: `run-test-${Date.now()}`,
    status: "queued",
    projectRoot: tmpDir,
    startedAt: new Date().toISOString(),
    ...overrides
  };
}

describe("run-store", () => {
  it("creates validated stable run IDs", () => {
    expect(createRunId()).toMatch(/^run-[0-9]+-[a-f0-9]{6}$/);
  });
  it("putRun stores state in memory and getRun returns it", async () => {
    const state = makeState();
    await putRun(state);
    const found = await getRun(tmpDir, state.runId);
    expect(found).toBeDefined();
    expect(found?.runId).toBe(state.runId);
    expect(found?.status).toBe("queued");
  });

  it("putRun writes a JSON file under .ui-diff/generated/run-state/", async () => {
    const state = makeState();
    await putRun(state);
    const filePath = path.join(tmpDir, ".ui-diff", "generated", "run-state", `${state.runId}.json`);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as RunHandleState;
    expect(parsed.runId).toBe(state.runId);
    await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow();
  });

  it("getRun returns undefined for unknown runId", async () => {
    const found = await getRun(tmpDir, "nonexistent-run-id");
    expect(found).toBeUndefined();
  });

  it("getRun reads from disk when not in memory", async () => {
    const state = makeState({ runId: "run-disk-only" });
    const stateDir = path.join(tmpDir, ".ui-diff", "generated", "run-state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, `${state.runId}.json`), JSON.stringify(state), "utf8");
    const found = await getRun(tmpDir, state.runId);
    expect(found?.runId).toBe("run-disk-only");
    expect(found?.status).toBe("queued");
  });

  it("loads orphaned running state as interrupted", async () => {
    const state = makeState({ runId: "run-interrupted", status: "running", checkpointPath: path.join(tmpDir, "report.json") });
    await putRun(state);
    clearRunMemoryForTests();
    const found = await getRun(tmpDir, state.runId);
    expect(found).toMatchObject({ status: "interrupted", checkpointPath: state.checkpointPath });
  });

  it("putRun updates existing run state", async () => {
    const state = makeState();
    await putRun(state);
    const updated = { ...state, status: "running" as const };
    await putRun(updated);
    const found = await getRun(tmpDir, state.runId);
    expect(found?.status).toBe("running");
  });

  it("putRun persists optional label field", async () => {
    const state = makeState({ label: "my-test-label" });
    await putRun(state);
    const found = await getRun(tmpDir, state.runId);
    expect(found?.label).toBe("my-test-label");
  });

  it("putRun persists reportPath and artifactRoot", async () => {
    const state = makeState({
      status: "complete",
      reportPath: path.join(tmpDir, "report.json"),
      artifactRoot: tmpDir,
      completedAt: new Date().toISOString()
    });
    await putRun(state);
    const found = await getRun(tmpDir, state.runId);
    expect(found?.reportPath).toBe(state.reportPath);
    expect(found?.artifactRoot).toBe(state.artifactRoot);
    expect(found?.completedAt).toBe(state.completedAt);
  });
});
