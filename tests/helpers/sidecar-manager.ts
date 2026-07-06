import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "../../../");
export const DEFAULT_LOCATEANYTHING_PYTHON =
  "C:\\Users\\xursc\\projects\\.venvs\\ui-diff-mcp-locateanything\\Scripts\\python.exe";

export interface SidecarHandle {
  /** True if the sidecar was already running when ensureSidecarRunning was called. */
  alreadyRunning: boolean;
  /** Kills the sidecar process if we started it; no-op if it was already running. */
  close(): void;
}

export function resolveSidecarPythonPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["LOCATEANYTHING_PYTHON"];
  if (configured && configured.trim().length > 0) return configured;
  if (fs.existsSync(DEFAULT_LOCATEANYTHING_PYTHON)) return DEFAULT_LOCATEANYTHING_PYTHON;
  return "python";
}

export async function pollHealth(
  url: string,
  deadlineMs: number,
  options: { intervalMs?: number; requestTimeoutMs?: number } = {}
): Promise<boolean> {
  const intervalMs = options.intervalMs ?? 3000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 4000;
  while (Date.now() < deadlineMs) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(requestTimeoutMs) });
      if (resp.ok) {
        const body = await resp.json() as { ready?: boolean; error?: string | null };
        if (body.ready === true) return true;
        if (body.error) {
          throw new Error(`LocateAnything sidecar failed to load: ${body.error}`);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("LocateAnything sidecar failed to load:")) {
        throw error;
      }
      // sidecar not up yet — keep polling
    }
  }
  return false;
}

async function warmupSidecar(url: string): Promise<void> {
  const tinyPng = await sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 200, g: 200, b: 200 } }
  }).png().toBuffer();
  const body = JSON.stringify({
    imagePath: "warmup",
    imageBase64: tinyPng.toString("base64"),
    imageMimeType: "image/png",
    queries: [{ id: "warmup", prompt: "Locate any visible element." }],
    maxBoxesPerQuery: 1
  });
  const resp = await fetch(`${url}/v1/locate-ui-elements`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(120000)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Sidecar warmup request failed: ${resp.status} ${text.slice(0, 200)}`);
  }
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
  const warmup = process.env["UI_DIFF_SIDECAR_WARMUP"] === "1";

  // Fast check — already running?
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const body = await resp.json() as { ready?: boolean };
      if (body.ready === true) {
        if (warmup) await warmupSidecar(url);
        return { alreadyRunning: true, close() {} };
      }
    }
  } catch {
    // not running — will start below
  }

  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parsed.port || "39731";

  const pythonPath = resolveSidecarPythonPath();
  const childEnv = { ...process.env, LOCATEANYTHING_PYTHON: pythonPath };
  const proc: ChildProcess = spawn(
    pythonPath,
    ["-m", "uvicorn", "sidecars.locateanything.server:app", "--host", host, "--port", port],
    { cwd: PROJECT_ROOT, env: childEnv, stdio: "inherit", detached: false }
  );

  const ready = await pollHealth(url, Date.now() + startupTimeoutMs);
  if (!ready) {
    proc.kill();
    throw new Error(
      `LocateAnything sidecar at ${url} did not become ready within ${startupTimeoutMs / 1000}s. ` +
      `Ensure LOCATEANYTHING_EAGLE_EMBODIED_DIR is set and the model is available.`
    );
  }

  if (warmup) await warmupSidecar(url);

  return {
    alreadyRunning: false,
    close() { proc.kill(); }
  };
}
