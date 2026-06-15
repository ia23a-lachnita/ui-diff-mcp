import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../");

export interface SidecarHandle {
  /** True if the sidecar was already running when ensureSidecarRunning was called. */
  alreadyRunning: boolean;
  /** Kills the sidecar process if we started it; no-op if it was already running. */
  close(): void;
}

async function pollHealth(url: string, deadlineMs: number): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
      if (resp.ok) {
        const body = await resp.json() as { ready?: boolean };
        if (body.ready === true) return true;
      }
    } catch {
      // sidecar not up yet — keep polling
    }
  }
  return false;
}

/**
 * Ensures the LocateAnything sidecar is running at the given URL.
 * If it is already healthy, returns immediately.
 * If not, spawns it via uvicorn (requires LOCATEANYTHING_EAGLE_EMBODIED_DIR to be set)
 * and polls until ready or the startup timeout elapses.
 *
 * Call close() on the returned handle in afterAll to kill it (no-op if already running).
 */
export async function ensureSidecarRunning(
  url = "http://127.0.0.1:39731",
  startupTimeoutMs = 120000
): Promise<SidecarHandle> {
  // Fast check — already running?
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const body = await resp.json() as { ready?: boolean };
      if (body.ready === true) {
        return { alreadyRunning: true, close() {} };
      }
    }
  } catch {
    // not running — will start below
  }

  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parsed.port || "39731";

  const proc: ChildProcess = spawn(
    "python",
    ["-m", "uvicorn", "sidecars.locateanything.server:app", "--host", host, "--port", port],
    { cwd: PROJECT_ROOT, env: process.env, stdio: "inherit", detached: false }
  );

  const ready = await pollHealth(url, Date.now() + startupTimeoutMs);
  if (!ready) {
    proc.kill();
    throw new Error(
      `LocateAnything sidecar at ${url} did not become ready within ${startupTimeoutMs / 1000}s. ` +
      `Ensure LOCATEANYTHING_EAGLE_EMBODIED_DIR is set and the model is available.`
    );
  }

  return {
    alreadyRunning: false,
    close() { proc.kill(); }
  };
}
