import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
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
  validateCalorixTodayScreenshotForReadiness,
  type CalorixCommandRunner
} from "../helpers/calorix-device.js";
import type { CaptureResult } from "../../src/capture/mobile-capture.js";

function readiness(ok: boolean, overrides: Partial<Awaited<ReturnType<typeof validateCalorixTodayScreenshotForReadiness>>> = {}) {
  return {
    ok,
    pixelBuffer: Buffer.from(ok ? "today" : "not-ready"),
    variance: ok ? 1000 : 50,
    entropy: ok ? 1.5 : 0.2,
    edgeRatio: ok ? 0.02 : 0.001,
    nonBackgroundRatio: ok ? 0.1 : 0.01,
    changedRatio: 0,
    topBrightRatio: ok ? 0.05 : 0,
    lowerWhiteRatio: 0,
    lowerCyanRatio: 0,
    lowerDetailRatio: ok ? 0.1 : 0,
    recentAccentRatio: 0,
    recentAccentWidthRatio: 0,
    recentAccentHeightRatio: 0,
    reason: ok ? "test ready" : "not ready",
    ...overrides
  };
}

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
    calls.push({ file, args, ...(options.shell !== undefined ? { shell: options.shell } : {}) });
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
      now: () => Date.UTC(2026, 6, 4, 12, 0, 0),
      validateImage: async () => {
        return readiness(true);
      }
    });

    expect(result.source).toBe("auto_capture");
    expect(result.actualImagePath).toContain(`${path.sep}.ui-diff${path.sep}captures${path.sep}`);
    expect(calls.map(call => call.args.join(" "))).toEqual([
      "shell input keyevent KEYCODE_WAKEUP",
      "shell wm dismiss-keyguard",
      "shell settings put secure immersive_mode_confirmations confirmed",
      "shell input keyevent BACK",
      "shell am start -a android.intent.action.VIEW -d calorix://debug/reseed"
    ]);
  });

  it("retries capture until Today screen heuristics pass", async () => {
    const root = await makeProject();
    const calls: Array<{ file: string; args: string[]; shell?: boolean }> = [];
    const runner = runnerWithPackages(["com.calorix.calorix"], calls);

    let captureCount = 0;
    const capture = vi.fn(async (_target: "adb", opts: { makeOutputPath: () => string }): Promise<CaptureResult> => {
      captureCount++;
      const out = opts.makeOutputPath();
      await fs.writeFile(out, `attempt-${captureCount}`);
      return { path: out, width: 1080, height: 2400, blankPixelRatio: 0.1, validationStatus: "ok", warnings: [] };
    });

    let validateCount = 0;
    const validateImage = vi.fn(async (filePath: string, firstPixelBuffer: Buffer | undefined) => {
      validateCount++;
      if (validateCount === 1) {
        return readiness(false, { reason: "not_ready immersive_overlay" });
      } else if (validateCount === 2) {
        return readiness(false, { reason: "spinner" });
      } else {
        return readiness(true, { changedRatio: 0.2, reason: "today" });
      }
    });

    const result = await reseedAndCaptureCalorixToday({
      projectRoot: root,
      runner,
      capture,
      sleepMs: async () => {},
      now: () => Date.UTC(2026, 6, 4, 12, 0, 0),
      validateImage
    });

    expect(result.source).toBe("auto_capture");
    expect(captureCount).toBe(3);
    expect(validateCount).toBe(3);
    expect(calls.some(call => call.args.join(" ") === "shell input tap 540 2064")).toBe(true);

    const finalContent = await fs.readFile(result.actualImagePath, "utf8");
    expect(finalContent).toBe("attempt-3");

    const capturesDir = path.join(root, ".ui-diff", "captures");
    const files = await fs.readdir(capturesDir);
    expect(files).toContain("today-2026-07-04T12-00-00-000Z-attempt-1.png");
    expect(files).toContain("today-2026-07-04T12-00-00-000Z-attempt-2.png");
  });

  it("throws error after max attempts if heuristics never pass", async () => {
    const root = await makeProject();
    const runner = runnerWithPackages(["com.calorix.calorix"]);

    const capture = vi.fn(async (_target: "adb", opts: { makeOutputPath: () => string }): Promise<CaptureResult> => {
      const out = opts.makeOutputPath();
      await fs.writeFile(out, "stub");
      return { path: out, width: 1080, height: 2400, blankPixelRatio: 0.1, validationStatus: "ok", warnings: [] };
    });

    const validateImage = vi.fn(async () => {
      return readiness(false, { reason: "spinner" });
    });

    vi.stubEnv("UI_DIFF_CALORIX_CAPTURE_READY_TIMEOUT_MS", "3000");
    vi.stubEnv("UI_DIFF_CALORIX_CAPTURE_RETRY_MS", "1000");

    await expect(
      reseedAndCaptureCalorixToday({
        projectRoot: root,
        runner,
        capture,
        sleepMs: async () => {},
        now: () => Date.UTC(2026, 6, 4, 12, 0, 0),
        validateImage
      })
    ).rejects.toThrow("Calorix capture retry timeout");
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it("classifies detailed dark and light screens as ready while rejecting sparse and partial spinner screens", async () => {
    const root = await makeProject();
    const spinnerPath = path.join(root, "spinner.png");
    const partialSpinnerPath = path.join(root, "partial-spinner.png");
    const darkPath = path.join(root, "dark-today-like.png");
    const lightPath = path.join(root, "light-today-like.png");
    const immersiveOverlayPath = path.join(root, "immersive-overlay.png");

    await sharp({
      create: {
        width: 360,
        height: 800,
        channels: 4,
        background: { r: 14, g: 17, b: 23, alpha: 1 }
      }
    })
      .composite([
        { input: Buffer.from(`<svg width="360" height="800"><circle cx="180" cy="400" r="18" fill="none" stroke="#19D3D9" stroke-width="4" stroke-dasharray="28 20"/></svg>`), top: 0, left: 0 }
      ])
      .png()
      .toFile(spinnerPath);

    await sharp(Buffer.from(`<svg width="360" height="800">
      <rect width="360" height="800" fill="#0E1117"/>
      <text x="24" y="72" fill="#F4F6F8" font-size="28">Today</text>
      <rect x="20" y="112" width="320" height="210" rx="24" fill="#161B22" stroke="#2B3340"/>
      <circle cx="180" cy="210" r="64" fill="none" stroke="#19D3D9" stroke-width="18"/>
      <text x="132" y="218" fill="#F4F6F8" font-size="26">1420</text>
      <text x="20" y="370" fill="#F4F6F8" font-size="20">Recent scans</text>
      <circle cx="180" cy="600" r="18" fill="none" stroke="#3B5BFF" stroke-width="4" stroke-dasharray="28 20"/>
      <rect x="0" y="704" width="360" height="96" fill="#11161D" stroke="#28303A"/>
    </svg>`))
      .png()
      .toFile(partialSpinnerPath);

    const uiSvg = `<svg width="360" height="800">
      <rect width="360" height="800" fill="#0E1117"/>
      <text x="24" y="72" fill="#F4F6F8" font-size="28">Today</text>
      <rect x="20" y="112" width="320" height="210" rx="24" fill="#161B22" stroke="#2B3340"/>
      <circle cx="180" cy="210" r="64" fill="none" stroke="#19D3D9" stroke-width="18"/>
      <text x="132" y="218" fill="#F4F6F8" font-size="26">1420</text>
      <rect x="20" y="350" width="320" height="112" rx="18" fill="#161B22" stroke="#2B3340"/>
      <rect x="38" y="372" width="72" height="72" rx="16" fill="#A46C3F"/>
      <text x="126" y="398" fill="#F4F6F8" font-size="18">Chicken Rice Bowl</text>
      <text x="126" y="430" fill="#8B95A1" font-size="16">620 kcal</text>
      <rect x="20" y="482" width="320" height="112" rx="18" fill="#161B22" stroke="#2B3340"/>
      <rect x="38" y="504" width="72" height="72" rx="16" fill="#EAD8B5"/>
      <text x="126" y="530" fill="#F4F6F8" font-size="18">Protein Yogurt</text>
      <text x="126" y="562" fill="#8B95A1" font-size="16">180 kcal</text>
      <rect x="0" y="704" width="360" height="96" fill="#11161D" stroke="#28303A"/>
    </svg>`;
    await sharp(Buffer.from(uiSvg)).png().toFile(darkPath);
    await sharp(Buffer.from(uiSvg.replaceAll("#0E1117", "#F6F8FA").replaceAll("#161B22", "#FFFFFF").replaceAll("#F4F6F8", "#101820"))).png().toFile(lightPath);
    await sharp(Buffer.from(`<svg width="360" height="800">
      <rect width="360" height="800" fill="#050608"/>
      <text x="32" y="520" fill="#FFFFFF" font-size="24">This app is using the full screen.</text>
      <text x="32" y="552" fill="#FFFFFF" font-size="24">Swipe gestures for navigation</text>
      <text x="32" y="584" fill="#FFFFFF" font-size="24">will show the status bar.</text>
      <rect x="120" y="640" width="120" height="56" rx="10" fill="none" stroke="#FFFFFF" stroke-width="2"/>
      <text x="160" y="676" fill="#FFFFFF" font-size="22">OK</text>
    </svg>`)).png().toFile(immersiveOverlayPath);

    const spinner = await validateCalorixTodayScreenshotForReadiness(spinnerPath, undefined);
    const partialSpinner = await validateCalorixTodayScreenshotForReadiness(partialSpinnerPath, undefined);
    const dark = await validateCalorixTodayScreenshotForReadiness(darkPath, undefined);
    const light = await validateCalorixTodayScreenshotForReadiness(lightPath, undefined);
    const immersiveOverlay = await validateCalorixTodayScreenshotForReadiness(immersiveOverlayPath, undefined);

    expect(spinner.ok).toBe(false);
    expect(partialSpinner.ok).toBe(false);
    expect(partialSpinner.reason).toContain("partial_loading");
    expect(dark.ok).toBe(true);
    expect(light.ok).toBe(true);
    expect(immersiveOverlay.ok).toBe(false);
    expect(immersiveOverlay.reason).toContain("immersive_overlay");
  });

  it("matches the known local spinner and Today screenshots when those artifacts exist", async () => {
    const spinnerPath = "C:/Users/xursc/projects/calorix/.ui-diff/captures/today-2026-07-04T19-09-08-413Z.png";
    const todayPath = "C:/Users/xursc/projects/calorix/.ui-diff/captures/manual-current-check.png";
    const immersiveOverlayPath = "C:/Users/xursc/projects/calorix/.ui-diff/captures/today-2026-07-04T19-39-03-893Z.png";
    const partialSpinnerPath = "C:/Users/xursc/projects/calorix/.ui-diff/captures/today-2026-07-05T10-12-13-143Z.png";
    const loadedRecentPath = "C:/Users/xursc/projects/calorix/.ui-diff/captures/today-2026-07-05T10-50-10-416Z-attempt-60.png";
    try {
      await fs.access(spinnerPath);
      await fs.access(todayPath);
      await fs.access(immersiveOverlayPath);
      await fs.access(partialSpinnerPath);
      await fs.access(loadedRecentPath);
    } catch {
      return;
    }

    const spinner = await validateCalorixTodayScreenshotForReadiness(spinnerPath, undefined);
    const today = await validateCalorixTodayScreenshotForReadiness(todayPath, undefined);
    const immersiveOverlay = await validateCalorixTodayScreenshotForReadiness(immersiveOverlayPath, undefined);
    const partialSpinner = await validateCalorixTodayScreenshotForReadiness(partialSpinnerPath, undefined);
    const loadedRecent = await validateCalorixTodayScreenshotForReadiness(loadedRecentPath, undefined);

    expect(spinner.ok).toBe(false);
    expect(today.ok).toBe(true);
    expect(loadedRecent.ok).toBe(true);
    expect(immersiveOverlay.ok).toBe(false);
    expect(immersiveOverlay.reason).toContain("immersive_overlay");
    expect(partialSpinner.ok).toBe(false);
    expect(partialSpinner.reason).toContain("partial_loading");
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

    const first = await resolveCalorixActualImage({
      projectRoot: root,
      runner,
      capture,
      sleepMs: async () => {},
      now: () => Date.UTC(2026, 6, 4, 12, 0, 0),
      validateImage: async () => {
        return readiness(true);
      }
    });
    const second = await resolveCalorixActualImage({
      projectRoot: root,
      runner,
      capture,
      sleepMs: async () => {},
      now: () => Date.UTC(2026, 6, 4, 12, 1, 0),
      validateImage: async () => {
        return readiness(true);
      }
    });

    expect(second.actualImagePath).toBe(first.actualImagePath);
    expect(second.source).toBe("auto_capture");
    expect(process.env["UI_DIFF_LIVE_ACTUAL_IMAGE"]).toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
