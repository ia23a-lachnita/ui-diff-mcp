import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { captureMobileScreen, type CaptureResult } from "../../src/capture/mobile-capture.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_CALORIX_PROJECT_ROOT = "C:/Users/xursc/projects/calorix";
export const DEFAULT_CALORIX_EXPECTED_IMAGE = "docs/mockups/image/dark/single/Today.png";
export const CALORIX_DEBUG_APK_RELATIVE = "build/app/outputs/flutter-apk/app-debug.apk";

const SOURCE_ROOTS = ["lib", "assets", "android/app/src", "android/app/build.gradle.kts"] as const;
const SOURCE_FILES = ["pubspec.yaml", "pubspec.lock"] as const;
const SOURCE_EXTENSIONS = new Set([
  ".dart",
  ".yaml",
  ".yml",
  ".json",
  ".xml",
  ".gradle",
  ".kts",
  ".kt",
  ".java",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ttf",
  ".otf"
]);
const IGNORED_DIRS = new Set([".dart_tool", ".git", ".ui-diff", "build", "coverage", "node_modules"]);

export interface ProcessResult {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

export interface CalorixCommandRunner {
  (file: string, args: string[], options: { cwd?: string; timeout: number; encoding?: BufferEncoding | "buffer"; shell?: boolean }): Promise<ProcessResult | unknown>;
}

export interface CalorixDeviceOptions {
  projectRoot?: string;
  runner?: CalorixCommandRunner;
  now?: () => number;
  capture?: (target: "adb", opts: { makeOutputPath: () => string }) => Promise<CaptureResult>;
  sleepMs?: (ms: number) => Promise<void>;
}

export interface CalorixPreparedActual {
  actualImagePath: string;
  capture: CaptureResult;
  source: "env_override" | "auto_capture";
}

const defaultRunner: CalorixCommandRunner = (file, args, options) => execFileAsync(file, args, options);
let memoizedActual: CalorixPreparedActual | undefined;

export function resetCalorixActualImageMemoForTests(): void {
  memoizedActual = undefined;
}

export function getCalorixProjectRoot(): string {
  return process.env["UI_DIFF_LIVE_PROJECT_ROOT"] ?? DEFAULT_CALORIX_PROJECT_ROOT;
}

export function getCalorixExpectedImagePath(projectRoot = getCalorixProjectRoot()): string {
  return process.env["UI_DIFF_LIVE_EXPECTED_IMAGE"] ?? path.join(projectRoot, DEFAULT_CALORIX_EXPECTED_IMAGE);
}

function toText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

async function walkLatestMtime(root: string): Promise<number> {
  let latest = 0;
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return latest;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await walkLatestMtime(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const stat = await fs.stat(fullPath);
    latest = Math.max(latest, stat.mtimeMs);
  }
  return latest;
}

export async function findLatestCalorixSourceMtime(projectRoot = getCalorixProjectRoot()): Promise<number> {
  let latest = 0;
  for (const file of SOURCE_FILES) {
    const fullPath = path.join(projectRoot, file);
    try {
      latest = Math.max(latest, (await fs.stat(fullPath)).mtimeMs);
    } catch {
      // Optional in tests/partial checkouts.
    }
  }
  for (const root of SOURCE_ROOTS) {
    latest = Math.max(latest, await walkLatestMtime(path.join(projectRoot, root)));
  }
  return latest;
}

export async function isDebugApkUpToDate(projectRoot = getCalorixProjectRoot()): Promise<boolean> {
  const apkPath = path.join(projectRoot, CALORIX_DEBUG_APK_RELATIVE);
  let apkMtime = 0;
  try {
    apkMtime = (await fs.stat(apkPath)).mtimeMs;
  } catch {
    return false;
  }
  return apkMtime >= await findLatestCalorixSourceMtime(projectRoot);
}

export async function discoverCalorixAndroidPackage(projectRoot = getCalorixProjectRoot()): Promise<string> {
  if (process.env["UI_DIFF_CALORIX_ANDROID_PACKAGE"]) return process.env["UI_DIFF_CALORIX_ANDROID_PACKAGE"]!;
  const gradlePath = path.join(projectRoot, "android", "app", "build.gradle.kts");
  try {
    const gradle = await fs.readFile(gradlePath, "utf8");
    const match = gradle.match(/applicationId\s*=\s*"([^"]+)"/);
    if (match?.[1]) return match[1];
  } catch {
    // Fall through to default.
  }
  return "com.calorix.calorix";
}

function flutterCommandCandidates(): string[] {
  if (os.platform() === "win32") return ["fvm.cmd", "fvm.bat", "fvm", "flutter.cmd", "flutter.bat", "flutter"];
  return ["fvm", "flutter"];
}

function isShellWrappedExecutable(file: string): boolean {
  return os.platform() === "win32" && /\.(?:cmd|bat)$/i.test(file);
}

async function runFirstAvailableFlutterBuild(runner: CalorixCommandRunner, projectRoot: string): Promise<void> {
  const errors: string[] = [];
  for (const candidate of flutterCommandCandidates()) {
    const usesFvm = /^fvm(?:\.cmd|\.bat)?$/i.test(candidate);
    const args = usesFvm ? ["flutter", "build", "apk", "--debug"] : ["build", "apk", "--debug"];
    try {
      await runner(candidate, args, {
        cwd: projectRoot,
        timeout: 600000,
        shell: isShellWrappedExecutable(candidate)
      });
      return;
    } catch (err) {
      errors.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Failed to build Calorix debug APK: ${errors.join("; ")}`);
}

async function isPackageInstalled(runner: CalorixCommandRunner, packageName: string): Promise<boolean> {
  const result = await runner("adb", ["shell", "pm", "list", "packages", packageName], { timeout: 30000, encoding: "utf8" });
  const stdout = toText((result as ProcessResult | undefined)?.stdout);
  return stdout.split(/\r?\n/).some(line => line.trim() === `package:${packageName}`);
}

export async function ensureCalorixDebugAppFresh(opts: CalorixDeviceOptions = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? getCalorixProjectRoot();
  const runner = opts.runner ?? defaultRunner;
  const packageName = await discoverCalorixAndroidPackage(projectRoot);
  const apkPath = path.join(projectRoot, CALORIX_DEBUG_APK_RELATIVE);
  const forceBuild = process.env["UI_DIFF_FORCE_CALORIX_BUILD"] === "1";
  const apkFresh = !forceBuild && await isDebugApkUpToDate(projectRoot);
  if (!apkFresh) await runFirstAvailableFlutterBuild(runner, projectRoot);
  const installed = await isPackageInstalled(runner, packageName);
  if (!apkFresh || !installed) {
    await runner("adb", ["install", "-r", apkPath], { timeout: 180000, encoding: "utf8" });
  }
}

export async function reseedAndCaptureCalorixToday(opts: CalorixDeviceOptions = {}): Promise<CalorixPreparedActual> {
  const projectRoot = opts.projectRoot ?? getCalorixProjectRoot();
  const runner = opts.runner ?? defaultRunner;
  const now = opts.now ?? Date.now;
  const sleepMs = opts.sleepMs ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  await runner("adb", ["shell", "input", "keyevent", "KEYCODE_WAKEUP"], { timeout: 30000, encoding: "utf8" });
  await runner("adb", ["shell", "wm", "dismiss-keyguard"], { timeout: 30000, encoding: "utf8" });
  await runner("adb", ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "calorix://debug/reseed"], { timeout: 30000, encoding: "utf8" });
  await sleepMs(5000);
  const captureDir = path.join(projectRoot, ".ui-diff", "captures");
  await fs.mkdir(captureDir, { recursive: true });
  const outputPath = path.join(captureDir, `today-${new Date(now()).toISOString().replace(/[:.]/g, "-")}.png`);
  const capture = await (opts.capture ?? captureMobileScreen)("adb", { makeOutputPath: () => outputPath });
  if (capture.validationStatus !== "ok") {
    throw new Error(`Calorix capture validation failed (${capture.validationStatus}): ${capture.warnings.join("; ") || "no detail"}`);
  }
  return { actualImagePath: capture.path, capture, source: "auto_capture" };
}

export async function resolveCalorixActualImage(opts: CalorixDeviceOptions = {}): Promise<CalorixPreparedActual> {
  const explicit = process.env["UI_DIFF_LIVE_ACTUAL_IMAGE"];
  if (memoizedActual && (!explicit || path.resolve(explicit) === path.resolve(memoizedActual.actualImagePath))) {
    return memoizedActual;
  }
  if (explicit) {
    return {
      actualImagePath: explicit,
      capture: { path: explicit, width: 0, height: 0, blankPixelRatio: 0, validationStatus: "ok", warnings: ["Explicit UI_DIFF_LIVE_ACTUAL_IMAGE override; freshness not guaranteed."] },
      source: "env_override"
    };
  }
  if (memoizedActual) return memoizedActual;
  await ensureCalorixDebugAppFresh(opts);
  memoizedActual = await reseedAndCaptureCalorixToday(opts);
  process.env["UI_DIFF_LIVE_ACTUAL_IMAGE"] = memoizedActual.actualImagePath;
  return memoizedActual;
}
