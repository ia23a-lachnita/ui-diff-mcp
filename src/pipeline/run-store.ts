import fs from "node:fs/promises";
import path from "node:path";

export interface RunHandleState {
  runId: string;
  status: "queued" | "running" | "complete" | "incomplete" | "failed";
  reportPath?: string;
  artifactRoot?: string;
  projectRoot: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
  label?: string;
}

const runs = new Map<string, RunHandleState>();

export async function putRun(state: RunHandleState): Promise<void> {
  runs.set(state.runId, state);
  const stateDir = path.join(state.projectRoot, ".ui-diff", "generated", "run-state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    path.join(stateDir, `${state.runId}.json`),
    JSON.stringify(state, null, 2),
    "utf8"
  );
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
    return JSON.parse(await fs.readFile(statePath, "utf8")) as RunHandleState;
  } catch {
    return undefined;
  }
}
