import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALORIX_DEBUG_APK_RELATIVE,
  discoverCalorixAndroidPackage,
  ensureCalorixDebugAppFresh,
  getCalorixExpectedImagePath,
  isDebugApkUpToDate,
  reseedAndCaptureCalorixToday,
  resetCalorixActualImageMemoForTests,
  resolveCalorixActualImage,
  type CalorixCommandRunner
} from "../helpers/calorix-device.js";
import type { CaptureResult } from "../../src/capture/mobile-capture.js";

async function makeProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-calorix-"));
  await fs.mkdir(path.join(root, "lib"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.mkdir(path.join(root, "android", "app", "src"), { recursive: true });
  await fs.mkdir(path.dirname(path.join(root, CALORIX_DEBUG_APK_RELATIVE)), { recursive: true });
  await fs.writeFile(path.join(root, "pubspec.yaml"), "name: calorix\n");
  await fs.writeFile(path.join(root, "pubspec.lock"), "{}\n");
  await fs.writeFile(path.join(root, "lib", "main.dart"), "void main() {}\n");
  await fs.writeFile(path.join(root, "android", "app", "build.gradle.kts"), 'defaultConfig { applicationId = "com.calorix.calorix" }\n');
  return root;
}

function runnerWithPackages(packages: string[], calls: Array<{ file: string; args: string[]; shell?: boolean }> = []): CalorixCommandRunner {
  return async (file, args, options) => {
    calls.push({ file, args, shell: options.shell });
    if (args.join(" ") === "shell pm list packages com.calorix.calorix") {
      return { stdout: packages.map(item => `package:${item}`).join("\n") };
    }
    return { stdout: "" };
  };
}

describe("calorix-device helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetCalorixActualImageMemoForTests();
  });

  it("defaults the expected image to the Calorix mockup path", async () => {
    const root = await makeProject();

    expect(getCalorixExpectedImagePath(root)).toBe(path.join(root, "docs/mockups/image/dark/single/Today.png"));
  });

  it("checks the real Flutter debug APK path against source mtimes", async () => {
    const root = await makeProject();
    const apk = path.join(root, CALORIX_DEBUG_APK_RELATIVE);
    await fs.writeFile(apk, "apk");
    const old = new Date(Date.now() - 60_000);
    const fresh = new Date(Date.now() + 60_000);
    await fs.utimes(apk, old, old);
    expect(await isDebugApkUpToDate(root)).toBe(false);

    await fs.utimes(apk, fresh, fresh);
    expect(await isDebugApkUpToDate(root)).toBe(true);
  });

  it("discovers the exact Android applicationId from build.gradle.kts", async () => {
    const root = await makeProject();

    expect(await discoverCalorixAndroidPackage(root)).toBe("com.calorix.calorix");
  });

  it("installs when exact package is absent even if substring package is present", async () => {
    const root = await makeProject();
    const apk = path.join(root, CALORIX_DEBUG_APK_RELATIVE);
    await fs.writeFile(apk, "apk");
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(apk, future, future);
    const calls: Array<{ file: string; args: string[]; shell?: boolean }> = [];
    const runner = runnerWithPackages(["com.calorix.calorix.debug"], calls);

    await ensureCalorixDebugAppFresh({ projectRoot: root, runner });

    expect(calls.some(call => call.file === "adb" && call.args[0] === "install")).toBe(true);
  });

  it("skips build and install when APK is fresh and exact package is installed", async () => {
    const root = await makeProject();
    const apk = path.join(root, CALORIX_DEBUG_APK_RELATIVE);
    await fs.writeFile(apk, "apk");
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(apk, future, future);
    const calls: Array<{ file: string; args: string[]; shell?: boolean }> = [];
    const runner = runnerWithPackages(["com.calorix.calorix"], calls);

    await ensureCalorixDebugAppFresh({ projectRoot: root, runner });

    expect(calls.some(call => call.file.startsWith("fvm") || call.file.startsWith("flutter"))).toBe(false);
    expect(calls.some(call => call.file === "adb" && call.args[0] === "install")).toBe(false);
  });

  it("captures to .ui-diff/captures after wake, unlock, and reseed", async () => {
    const root = await makeProject();
    const calls: Array<{ file: string; args: string[]; shell?: boolean }> = [];
    const runner = runnerWithPackages(["com.calorix.calorix"], calls);
    const capture = vi.fn(async (_target: "adb", opts: { makeOutputPath: () => string }): Promise<CaptureResult> => {
      const out = opts.makeOutputPath();
      await fs.writeFile(out, "png");
      return { path: out, width: 1080, height: 2400, blankPixelRatio: 0.1, validationStatus: "ok", warnings: [] };
    });

    const result = await reseedAndCaptureCalorixToday({
      projectRoot: root,
      runner,
      capture,
      sleepMs: async () => {},
      now: () => Date.UTC(2026, 6, 4, 12, 0, 0)
    });

    expect(result.source).toBe("auto_capture");
    expect(result.actualImagePath).toContain(`${path.sep}.ui-diff${path.sep}captures${path.sep}`);
    expect(calls.map(call => call.args.join(" "))).toEqual([
      "shell input keyevent KEYCODE_WAKEUP",
      "shell wm dismiss-keyguard",
      "shell am start -a android.intent.action.VIEW -d calorix://debug/reseed"
    ]);
  });

  it("uses explicit actual image override without auto capture", async () => {
    vi.stubEnv("UI_DIFF_LIVE_ACTUAL_IMAGE", "C:/screens/actual.png");
    const capture = vi.fn();

    const result = await resolveCalorixActualImage({ capture });

    expect(result.source).toBe("env_override");
    expect(result.actualImagePath).toBe("C:/screens/actual.png");
    expect(capture).not.toHaveBeenCalled();
  });

  it("memoizes an auto-captured image for later live tests", async () => {
    const root = await makeProject();
    const apk = path.join(root, CALORIX_DEBUG_APK_RELATIVE);
    await fs.writeFile(apk, "apk");
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(apk, future, future);
    const runner = runnerWithPackages(["com.calorix.calorix"]);
    const capture = vi.fn(async (_target: "adb", opts: { makeOutputPath: () => string }): Promise<CaptureResult> => {
      const out = opts.makeOutputPath();
      await fs.writeFile(out, "png");
      return { path: out, width: 1080, height: 2400, blankPixelRatio: 0.1, validationStatus: "ok", warnings: [] };
    });

    const first = await resolveCalorixActualImage({ projectRoot: root, runner, capture, sleepMs: async () => {}, now: () => Date.UTC(2026, 6, 4, 12, 0, 0) });
    const second = await resolveCalorixActualImage({ projectRoot: root, runner, capture, sleepMs: async () => {}, now: () => Date.UTC(2026, 6, 4, 12, 1, 0) });

    expect(second.actualImagePath).toBe(first.actualImagePath);
    expect(second.source).toBe("auto_capture");
    expect(process.env["UI_DIFF_LIVE_ACTUAL_IMAGE"]).toBe(first.actualImagePath);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
