import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSidecarRunning, pollHealth } from "../helpers/sidecar-manager.js";

// Broker-only contract: the sidecar always lives behind the broker URL. If spawn is ever
// reached, that proves the forbidden local-launch fallback is still present, so any call
// through this mock throws a sentinel the tests can detect without ever really spawning.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(() => {
      throw new Error("SENTINEL_LOCAL_SPAWN_MUST_NOT_HAPPEN: broker-only sidecar must never spawn a local process");
    })
  };
});

const HEALTHY_BODY = { model: "nvidia/LocateAnything-3B", ready: true, error: null, inTokenLimit: 4096 };

function stubHealthFetch(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  })));
}

beforeEach(() => {
  vi.mocked(spawn).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sidecar-manager (broker-only)", () => {
  it("returns a non-owning no-op handle for the exact healthy broker contract", async () => {
    stubHealthFetch(200, HEALTHY_BODY);

    const handle = await ensureSidecarRunning("http://127.0.0.1:39731", 10);

    expect(handle.alreadyRunning).toBe(true);
    expect(() => handle.close()).not.toThrow();
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("fails closed without spawning a local process when the broker is completely unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:39731")));

    const err = await ensureSidecarRunning("http://127.0.0.1:39731", 10).catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/SENTINEL_LOCAL_SPAWN_MUST_NOT_HAPPEN/);
    expect((err as Error).message).toMatch(/broker/i);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("fails closed without spawning a local process when the broker reports ready:false with an error", async () => {
    stubHealthFetch(200, { model: "nvidia/LocateAnything-3B", ready: false, error: "model still loading", inTokenLimit: 4096 });

    const err = await ensureSidecarRunning("http://127.0.0.1:39731", 10).catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/SENTINEL_LOCAL_SPAWN_MUST_NOT_HAPPEN/);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("fails closed when the broker reports a different model than the pinned contract", async () => {
    stubHealthFetch(200, { model: "some-other-model", ready: true, error: null, inTokenLimit: 4096 });

    await expect(ensureSidecarRunning("http://127.0.0.1:39731", 10)).rejects.toThrow(/model/i);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("fails closed when the broker reports an inTokenLimit outside the pinned contract", async () => {
    stubHealthFetch(200, { model: "nvidia/LocateAnything-3B", ready: true, error: null, inTokenLimit: 2048 });

    await expect(ensureSidecarRunning("http://127.0.0.1:39731", 10)).rejects.toThrow(/inTokenLimit/i);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("fails closed when the broker responds with a non-200 status even if the body looks healthy", async () => {
    stubHealthFetch(202, HEALTHY_BODY);

    await expect(ensureSidecarRunning("http://127.0.0.1:39731", 10)).rejects.toThrow(/200/);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("fails closed when the broker health response is malformed JSON-shaped garbage", async () => {
    stubHealthFetch(200, { unexpected: "shape" });

    await expect(ensureSidecarRunning("http://127.0.0.1:39731", 10)).rejects.toThrow(/broker/i);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("fails closed with a clear broker error on a held response that never completes, rather than silently returning false", async () => {
    // Simulates the documented broker behavior where /health can hold a request for minutes:
    // the mock never resolves on its own, only reacting to the per-attempt abort signal, so
    // this exercises the held-connection path in milliseconds instead of really waiting.
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("This operation was aborted", "AbortError"));
        });
      })
    ));

    await expect(
      pollHealth("http://127.0.0.1:39731", Date.now() + 30, { intervalMs: 0, requestTimeoutMs: 10 })
    ).rejects.toThrow(/broker/i);
  });

  it("fails closed when the broker reports the pinned model, ready:true, and inTokenLimit:4096 but also carries an error field", async () => {
    stubHealthFetch(200, {
      model: "nvidia/LocateAnything-3B",
      ready: true,
      inTokenLimit: 4096,
      error: "worker fault"
    });

    const err = await ensureSidecarRunning("http://127.0.0.1:39731", 10).catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/SENTINEL_LOCAL_SPAWN_MUST_NOT_HAPPEN/);
    expect((err as Error).message).toMatch(/worker fault/);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("fails closed when the broker reports ready:true with the pinned model and inTokenLimit but omits the error field entirely", async () => {
    stubHealthFetch(200, {
      model: "nvidia/LocateAnything-3B",
      ready: true,
      inTokenLimit: 4096
    });

    const err = await ensureSidecarRunning("http://127.0.0.1:39731", 10).catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/SENTINEL_LOCAL_SPAWN_MUST_NOT_HAPPEN/);
    expect((err as Error).message).toMatch(/broker/i);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("fails closed before accepting an otherwise healthy fetch when LOCATEANYTHING_BROKER_STARTUP_TIMEOUT_MS is not a number and no explicit startupTimeoutMs is given", async () => {
    vi.stubEnv("LOCATEANYTHING_BROKER_STARTUP_TIMEOUT_MS", "not-a-number");
    stubHealthFetch(200, HEALTHY_BODY);

    const err = await ensureSidecarRunning("http://127.0.0.1:39731").catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/SENTINEL_LOCAL_SPAWN_MUST_NOT_HAPPEN/);
    expect((err as Error).message).toMatch(/LOCATEANYTHING_BROKER_STARTUP_TIMEOUT_MS/);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });

  it("fails fast when health reports a model load error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ready: false, error: "ModuleNotFoundError: No module named 'torch'" })
    }));

    await expect(pollHealth("http://127.0.0.1:39731", Date.now() + 10_000, { intervalMs: 0 }))
      .rejects.toThrow("ModuleNotFoundError");
  });
});
