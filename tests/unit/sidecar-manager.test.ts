import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCATEANYTHING_PYTHON,
  pollHealth,
  resolveSidecarPythonPath
} from "../helpers/sidecar-manager.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sidecar-manager", () => {
  it("uses LOCATEANYTHING_PYTHON when explicitly configured", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(resolveSidecarPythonPath({ LOCATEANYTHING_PYTHON: "C:\\custom\\python.exe" })).toBe("C:\\custom\\python.exe");
  });

  it("uses the known LocateAnything venv before plain python", () => {
    vi.spyOn(fs, "existsSync").mockImplementation(candidate => candidate === DEFAULT_LOCATEANYTHING_PYTHON);

    expect(resolveSidecarPythonPath({})).toBe(DEFAULT_LOCATEANYTHING_PYTHON);
  });

  it("falls back to plain python when no configured interpreter exists", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(resolveSidecarPythonPath({})).toBe("python");
  });

  it("fails fast when health reports a model load error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ready: false, error: "ModuleNotFoundError: No module named 'torch'" })
    }));

    await expect(pollHealth("http://127.0.0.1:39731", Date.now() + 10_000, { intervalMs: 0 }))
      .rejects.toThrow("ModuleNotFoundError");
  });
});
