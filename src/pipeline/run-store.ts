import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export interface RunHandleState {
  runId: string;
  status: "queued" | "running" | "interrupted" | "complete" | "incomplete" | "failed";
  reportPath?: string;
  artifactRoot?: string;
  projectRoot: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  label?: string;
  heartbeatAt?: string;
  checkpointPath?: string;
  progress?: { stage: string; pairIndex?: number; criterionIndex?: number };
}

const runs = new Map<string, RunHandleState>();

export function createRunId(): string {
  return `run-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

export function clearRunMemoryForTests(): void {
  runs.clear();
}

export async function putRun(state: RunHandleState): Promise<void> {
  runs.set(state.runId, state);
  const stateDir = path.join(state.projectRoot, ".ui-diff", "generated", "run-state");
  await fs.mkdir(stateDir, { recursive: true });
  const statePath = path.join(stateDir, `${state.runId}.json`);
  const tmpPath = `${statePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmpPath, statePath);
}

function isValidRunId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function getRun(projectRoot: string, runId: string): Promise<RunHandleState | undefined> {
  if (!isValidRunId(runId)) return undefined;
  const inMemory = runs.get(runId);
  if (inMemory) return inMemory;
  const statePath = path.join(projectRoot, ".ui-diff", "generated", "run-state", `${runId}.json`);
  try {
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as RunHandleState;
    return state.status === "running"
      ? { ...state, status: "interrupted", error: state.error ?? "Worker process ended before a terminal report was persisted." }
      : state;
  } catch {
    return undefined;
  }
}
