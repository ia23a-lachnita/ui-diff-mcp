import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureMobileScreen, type CommandRunner } from "../../src/capture/mobile-capture.js";

let tmpDir: string;

async function makeValidPngBuffer(r = 180, g = 180, b = 180): Promise<Buffer> {
  return sharp({ create: { width: 10, height: 20, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();
}

async function makeBlankPngBuffer(): Promise<Buffer> {
  return sharp({ create: { width: 10, height: 20, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .png()
    .toBuffer();
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-capture-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("captureMobileScreen (adb)", () => {
  it("uses exec-out, writes buffer to file, returns CaptureResult with ok status", async () => {
    const pngBuf = await makeValidPngBuffer();
    const outPath = path.join(tmpDir, "screen.png");

    const runner = vi.fn<CommandRunner>().mockResolvedValue({ stdout: pngBuf });
    const result = await captureMobileScreen("adb", { runner, makeOutputPath: () => outPath });

    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(
      "adb",
      ["exec-out", "screencap", "-p"],
      { encoding: "buffer", timeout: 30000 }
    );
    expect(result.path).toBe(outPath);
    expect(result.validationStatus).toBe("ok");
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.blankPixelRatio).toBeLessThan(0.5);
  });

  it("rejects blank (all-black) screenshot", async () => {
    const blankBuf = await makeBlankPngBuffer();
    const outPath = path.join(tmpDir, "blank.png");

    const runner = vi.fn<CommandRunner>().mockResolvedValue({ stdout: blankBuf });
    const result = await captureMobileScreen("adb", { runner, makeOutputPath: () => outPath });

    expect(result.validationStatus).toBe("blank");
    expect(result.blankPixelRatio).toBeGreaterThan(0.98);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/blankPixelRatio/);
  });

  it("throws when exec-out returns empty buffer", async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue({ stdout: Buffer.alloc(0) });
    await expect(captureMobileScreen("adb", { runner })).rejects.toThrow(/adb capture failed/);
  });

  it("throws when exec-out result has no stdout", async () => {
    const runner = vi.fn<CommandRunner>().mockResolvedValue({});
    await expect(captureMobileScreen("adb", { runner })).rejects.toThrow(/adb capture failed/);
  });

  it("wraps adb command failures", async () => {
    const runner = vi.fn<CommandRunner>().mockRejectedValue(new Error("adb missing"));
    await expect(captureMobileScreen("adb", { runner })).rejects.toThrow(/adb capture failed: adb missing/);
  });
});

describe("captureMobileScreen (ios-simctl)", () => {
  it("runs xcrun simctl screenshot and returns CaptureResult", async () => {
    const pngBuf = await makeValidPngBuffer(100, 150, 200);
    const outPath = path.join(tmpDir, "ios.png");

    const runner = vi.fn<CommandRunner>().mockImplementation(async (_file, _args, _opts) => {
      await fs.writeFile(outPath, pngBuf);
      return undefined;
    });

    const result = await captureMobileScreen("ios-simctl", { runner, makeOutputPath: () => outPath });

    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "io", "booted", "screenshot", outPath],
      { timeout: 30000 }
    );
    expect(result.path).toBe(outPath);
    expect(result.validationStatus).toBe("ok");
  });

  it("wraps ios simulator command failures", async () => {
    const runner = vi.fn<CommandRunner>().mockRejectedValue(new Error("no booted simulator"));
    await expect(captureMobileScreen("ios-simctl", { runner })).rejects.toThrow(/ios-simctl capture failed: no booted simulator/);
  });
});

describe("captureMobileScreen (unknown target)", () => {
  it("rejects unknown target kinds", async () => {
    await expect(captureMobileScreen("unknown" as "adb")).rejects.toThrow(/Unsupported capture target/);
  });
});
