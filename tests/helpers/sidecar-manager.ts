import sharp from "sharp";

const BROKER_HEALTH_STATUS_OK = 200;
const PINNED_MODEL = "nvidia/LocateAnything-3B";
const PINNED_IN_TOKEN_LIMIT = 4096;
const DEFAULT_BROKER_STARTUP_TIMEOUT_MS = 600000;
const MAX_BROKER_STARTUP_TIMEOUT_MS = 600000;
const BROKER_STARTUP_TIMEOUT_ENV_VAR = "LOCATEANYTHING_BROKER_STARTUP_TIMEOUT_MS";

export interface SidecarHandle {
  /** Always true under the broker-only topology: this handle never owns a local process. */
  alreadyRunning: boolean;
  /** No-op: the broker lifecycle is managed remotely, never by this process. */
  close(): void;
}

/**
 * Thrown for broker health responses that will never resolve by waiting longer: a wrong
 * model/token contract, an error field, a model-load failure, or a malformed response shape.
 * Distinguishing these from transient network/status conditions lets pollHealth fail fast
 * instead of burning the whole startup budget retrying an unrecoverable mismatch.
 */
class BrokerContractError extends Error {}

interface BrokerHealthBody {
  model?: unknown;
  ready?: unknown;
  error?: unknown;
  inTokenLimit?: unknown;
}

type HealthEvaluation = { kind: "healthy" } | { kind: "transient"; detail: string };

function evaluateHealthBody(body: unknown): HealthEvaluation {
  const candidate = body as BrokerHealthBody;
  if (typeof candidate !== "object" || candidate === null || typeof candidate.ready !== "boolean") {
    throw new BrokerContractError(
      "LocateAnything broker health response has an unexpected shape (missing boolean 'ready' field)"
    );
  }
  if (candidate.ready === false) {
    if (candidate.error === null || candidate.error === undefined) {
      return { kind: "transient", detail: "broker reported ready:false (model still starting)" };
    }
    throw new BrokerContractError(`LocateAnything broker reported a model load error: ${String(candidate.error)}`);
  }
  if (candidate.error !== null) {
    throw new BrokerContractError(
      `LocateAnything broker reported ready:true but the error field is not exactly null (contract requires error:null): ${String(candidate.error)}`
    );
  }
  if (candidate.model !== PINNED_MODEL) {
    throw new BrokerContractError(
      `LocateAnything broker reported model "${String(candidate.model)}" but the pinned contract requires model "${PINNED_MODEL}"`
    );
  }
  if (candidate.inTokenLimit !== PINNED_IN_TOKEN_LIMIT) {
    throw new BrokerContractError(
      `LocateAnything broker reported inTokenLimit ${String(candidate.inTokenLimit)} but the pinned contract requires inTokenLimit ${PINNED_IN_TOKEN_LIMIT}`
    );
  }
  return { kind: "healthy" };
}

async function attemptHealthCheck(url: string, timeoutMs: number): Promise<HealthEvaluation> {
  const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(Math.max(timeoutMs, 0)) });
  if (resp.status !== BROKER_HEALTH_STATUS_OK) {
    return {
      kind: "transient",
      detail: `broker responded with HTTP ${resp.status} (expected ${BROKER_HEALTH_STATUS_OK})`
    };
  }
  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    throw new BrokerContractError("LocateAnything broker health response is not valid JSON");
  }
  return evaluateHealthBody(body);
}

/**
 * Polls the LocateAnything broker's /health endpoint until it reports the exact pinned
 * contract (HTTP 200, model "nvidia/LocateAnything-3B", ready:true, error:null,
 * inTokenLimit:4096), or throws a clear broker-unavailable error at the deadline.
 *
 * The broker's first response to a cold worker can legitimately hold for minutes, so by
 * default a held request is given the entire remaining deadline rather than a short abort.
 * Contract violations (wrong model, wrong token limit, an error field despite ready:true, a
 * model-load error, or a malformed response shape) fail immediately without retrying — no
 * amount of waiting fixes those.
 */
export async function pollHealth(
  url: string,
  deadlineMs: number,
  options: { intervalMs?: number; requestTimeoutMs?: number } = {}
): Promise<void> {
  const intervalMs = options.intervalMs ?? 3000;
  let lastDetail = "no response received from broker";
  let attempted = false;

  while (!attempted || Date.now() < deadlineMs) {
    attempted = true;
    const remaining = Math.max(deadlineMs - Date.now(), 0);
    const attemptTimeoutMs = options.requestTimeoutMs !== undefined
      ? Math.min(options.requestTimeoutMs, remaining > 0 ? remaining : options.requestTimeoutMs)
      : remaining;

    try {
      const outcome = await attemptHealthCheck(url, attemptTimeoutMs);
      if (outcome.kind === "healthy") return;
      lastDetail = outcome.detail;
    } catch (error) {
      if (error instanceof BrokerContractError) throw error;
      lastDetail = error instanceof Error ? error.message : String(error);
    }

    const sleepRemaining = deadlineMs - Date.now();
    if (sleepRemaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, sleepRemaining)));
  }

  throw new Error(`LocateAnything broker did not become ready within the startup budget. Last detail: ${lastDetail}`);
}

function resolveStartupTimeoutMs(explicit: number | undefined, env: NodeJS.ProcessEnv): number {
  if (explicit !== undefined) {
    if (!Number.isFinite(explicit) || !Number.isInteger(explicit) || explicit <= 0 || explicit > MAX_BROKER_STARTUP_TIMEOUT_MS) {
      throw new Error(
        `startupTimeoutMs must be a finite positive integer <= ${MAX_BROKER_STARTUP_TIMEOUT_MS}; received ${explicit}`
      );
    }
    return explicit;
  }

  const raw = env[BROKER_STARTUP_TIMEOUT_ENV_VAR];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_BROKER_STARTUP_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_BROKER_STARTUP_TIMEOUT_MS) {
    throw new Error(
      `${BROKER_STARTUP_TIMEOUT_ENV_VAR} must be a finite positive integer <= ${MAX_BROKER_STARTUP_TIMEOUT_MS}; received "${raw}"`
    );
  }
  return parsed;
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
 * Broker-only topology: LocateAnything always runs on a remote GPU host reachable through
 * this URL. This never spawns a local process or resolves a Python interpreter on the Pi —
 * it only waits for the broker's /health contract and returns a non-owning handle. Call
 * close() in afterAll for source compatibility; it is a no-op because this process never
 * owns the broker's lifecycle.
 */
export async function ensureSidecarRunning(
  url = "http://127.0.0.1:39731",
  startupTimeoutMs?: number
): Promise<SidecarHandle> {
  const resolvedTimeoutMs = resolveStartupTimeoutMs(startupTimeoutMs, process.env);
  const warmup = process.env["UI_DIFF_SIDECAR_WARMUP"] === "1";

  await pollHealth(url, Date.now() + resolvedTimeoutMs);

  if (warmup) await warmupSidecar(url);

  return { alreadyRunning: true, close() {} };
}
