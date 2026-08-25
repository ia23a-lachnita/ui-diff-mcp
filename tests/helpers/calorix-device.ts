import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { captureMobileScreen, type CaptureResult, resolveAdbConfig, buildAdbArgs, type AdbConfig } from "../../src/capture/mobile-capture.js";
import type { InputProvenanceRequest } from "../../src/schemas/core.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIFF_PROJECT_ROOT = path.resolve(__dirname, "..", "..");
export const DEFAULT_CALORIX_PROJECT_ROOT = path.resolve(UI_DIFF_PROJECT_ROOT, "..", "calorix");
export const DEFAULT_CALORIX_EXPECTED_IMAGE = "docs/design-handoff/placeholder-app/reference-images/today--dark.png";
export const CALORIX_REFERENCE_IMAGES_MANIFEST = "docs/design-handoff/placeholder-app/reference-images-manifest.json";
export const CANONICAL_CALORIX_TODAY_DARK_SHA256 = "73ba85f25489c8d45beab57dd1b317138870ce8360fe0f4399ab0737a5e505f1";
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

export interface CalorixScreenshotReadiness {
  ok: boolean;
  pixelBuffer: Buffer;
  variance: number;
  entropy: number;
  edgeRatio: number;
  nonBackgroundRatio: number;
  changedRatio: number;
  topBrightRatio: number;
  lowerWhiteRatio: number;
  lowerCyanRatio: number;
  lowerDetailRatio: number;
  recentAccentRatio: number;
  recentAccentWidthRatio: number;
  recentAccentHeightRatio: number;
  reason: string;
}

export interface CalorixDeviceOptions {
  projectRoot?: string;
  runner?: CalorixCommandRunner;
  now?: () => number;
  capture?: (target: "adb", opts: { makeOutputPath: () => string; adbExecutable?: string; adbSerial?: string }) => Promise<CaptureResult>;
  sleepMs?: (ms: number) => Promise<void>;
  validateImage?: (filePath: string, firstPixelBuffer: Buffer | undefined) => Promise<CalorixScreenshotReadiness>;
  adbExecutable?: string;
  adbSerial?: string;
}

export interface CalorixPreparedActual {
  actualImagePath: string;
  capture: CaptureResult;
  source: "env_override" | "auto_capture";
}

export interface ValidatedCalorixExpectedImage {
  expectedImagePath: string;
  source: "canonical_default" | "env_override";
  expectedManifestPath?: string;
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

export async function getValidatedCalorixExpectedImage(projectRoot = getCalorixProjectRoot()): Promise<ValidatedCalorixExpectedImage> {
  const expectedPath = path.resolve(getCalorixExpectedImagePath(projectRoot));
  const canonicalPath = path.resolve(projectRoot, DEFAULT_CALORIX_EXPECTED_IMAGE);
  const expectedSource = process.env["UI_DIFF_LIVE_EXPECTED_IMAGE"] ? "env_override" as const : "canonical_default" as const;
  let imageBytes: Buffer;

  try {
    imageBytes = await fs.readFile(expectedPath);
  } catch {
    throw new Error(`Calorix expected image is missing or unreadable at "${expectedPath}". Remediation: restore the canonical reference or set UI_DIFF_LIVE_EXPECTED_IMAGE to a readable expected screenshot.`);
  }

  if (expectedPath !== canonicalPath) {
    return { expectedImagePath: expectedPath, source: expectedSource };
  }

  const manifestPath = path.resolve(projectRoot, CALORIX_REFERENCE_IMAGES_MANIFEST);
  let manifest: { reference_images?: Array<{ filename?: string; sha256?: string }> };
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { reference_images?: Array<{ filename?: string; sha256?: string }> };
  } catch {
    throw new Error(`Calorix reference manifest is missing, unreadable, or invalid at "${manifestPath}". Remediation: restore reference-images-manifest.json with the canonical today--dark.png entry.`);
  }

  const manifestEntry = manifest.reference_images?.find(entry => entry.filename === "today--dark.png");
  if (manifestEntry?.sha256?.toLowerCase() !== CANONICAL_CALORIX_TODAY_DARK_SHA256) {
    throw new Error(`Calorix reference manifest at "${manifestPath}" does not identify today--dark.png with canonical SHA-256 ${CANONICAL_CALORIX_TODAY_DARK_SHA256}. Remediation: restore the canonical Calorix reference manifest.`);
  }

  const actualHash = crypto.createHash("sha256").update(imageBytes).digest("hex");
  if (actualHash !== CANONICAL_CALORIX_TODAY_DARK_SHA256) {
    throw new Error(`Calorix expected image hash mismatch at "${expectedPath}": expected ${CANONICAL_CALORIX_TODAY_DARK_SHA256}, got ${actualHash}. Remediation: restore the canonical today--dark.png reference.`);
  }

  return {
    expectedImagePath: expectedPath,
    source: expectedSource,
    expectedManifestPath: manifestPath
  };
}

export async function getValidatedCalorixExpectedImagePath(projectRoot = getCalorixProjectRoot()): Promise<string> {
  return (await getValidatedCalorixExpectedImage(projectRoot)).expectedImagePath;
}

export function createCalorixInputProvenance(
  expected: ValidatedCalorixExpectedImage,
  actual: CalorixPreparedActual
): InputProvenanceRequest {
  return {
    acquisition: {
      expected: { source: expected.source, verification: "caller_attested" },
      actual: { source: actual.source, verification: "caller_attested" }
    },
    ...(expected.expectedManifestPath !== undefined ? { expectedManifestPath: expected.expectedManifestPath } : {})
  };
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

async function isPackageInstalled(runner: CalorixCommandRunner, packageName: string, adbConfig: AdbConfig): Promise<boolean> {
  const result = await runner(adbConfig.executable, buildAdbArgs(adbConfig, "shell", "pm", "list", "packages", packageName), { timeout: 30000, encoding: "utf8" });
  const stdout = toText((result as ProcessResult | undefined)?.stdout);
  return stdout.split(/\r?\n/).some(line => line.trim() === `package:${packageName}`);
}

export async function ensureCalorixDebugAppFresh(opts: CalorixDeviceOptions = {}): Promise<void> {
  const projectRoot = opts.projectRoot ?? getCalorixProjectRoot();
  const runner = opts.runner ?? defaultRunner;
  const adbConfig = resolveAdbConfig(opts);
  const packageName = await discoverCalorixAndroidPackage(projectRoot);
  const apkPath = path.join(projectRoot, CALORIX_DEBUG_APK_RELATIVE);
  const forceBuild = process.env["UI_DIFF_FORCE_CALORIX_BUILD"] === "1";
  const apkFresh = !forceBuild && await isDebugApkUpToDate(projectRoot);
  if (!apkFresh) await runFirstAvailableFlutterBuild(runner, projectRoot);
  const installed = await isPackageInstalled(runner, packageName, adbConfig);
  if (!apkFresh || !installed) {
    await runner(adbConfig.executable, buildAdbArgs(adbConfig, "install", "-r", apkPath), { timeout: 180000, encoding: "utf8" });
  }
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function pruneOldCaptureAttempts(captureDir: string, keep: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(captureDir);
  } catch {
    return;
  }
  const attemptFiles = entries.filter(entry => /^today-.+-attempt-\d+\.png$/i.test(entry));
  if (attemptFiles.length <= keep) return;
  const stats = await Promise.all(attemptFiles.map(async entry => {
    const fullPath = path.join(captureDir, entry);
    return { fullPath, mtimeMs: (await fs.stat(fullPath)).mtimeMs };
  }));
  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  await Promise.all(stats.slice(keep).map(entry => fs.unlink(entry.fullPath).catch(() => undefined)));
}

export async function validateCalorixTodayScreenshotForReadiness(
  filePath: string,
  firstPixelBuffer: Buffer | undefined
): Promise<CalorixScreenshotReadiness> {
  const { data, info } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const totalPixels = info.width * info.height;
  let luminanceSum = 0;
  let luminanceSquaredSum = 0;
  let edgePixels = 0;
  let nonBackgroundPixels = 0;
  let topBrightPixels = 0;
  let lowerWhitePixels = 0;
  let topPixels = 0;
  let lowerPixels = 0;
  let lowerContentPixels = 0;
  let lowerCyanPixels = 0;
  let lowerDetailPixels = 0;
  let recentContentPixels = 0;
  let recentAccentPixels = 0;
  let recentAccentMinX = Number.POSITIVE_INFINITY;
  let recentAccentMinY = Number.POSITIVE_INFINITY;
  let recentAccentMaxX = -1;
  let recentAccentMaxY = -1;
  const bins = new Array<number>(16).fill(0);

  function isLoadingCyan(r: number, g: number, b: number): boolean {
    return g > 150 && b > 150 && r < 120 && Math.max(g, b) - r > 80 && Math.abs(g - b) < 90;
  }

  function isLoadingAccent(r: number, g: number, b: number): boolean {
    return isLoadingCyan(r, g, b) || (b > 170 && r < 130 && b - r > 80 && b - g > 20);
  }

  function luminanceAt(x: number, y: number): number {
    const offset = (y * info.width + x) * 4;
    const r = data[offset] ?? 0;
    const g = data[offset + 1] ?? 0;
    const b = data[offset + 2] ?? 0;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * 4;
      const r = data[offset] ?? 0;
      const g = data[offset + 1] ?? 0;
      const b = data[offset + 2] ?? 0;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      luminanceSum += luma;
      luminanceSquaredSum += luma * luma;
      const binIndex = Math.min(15, Math.floor(luma / 16));
      bins[binIndex] = (bins[binIndex] ?? 0) + 1;
      if (Math.max(r, g, b) - Math.min(r, g, b) > 18 || Math.max(r, g, b) > 50) {
        nonBackgroundPixels++;
      }
      if (y < info.height * 0.25) {
        topPixels++;
        if (Math.max(r, g, b) > 180) topBrightPixels++;
      }
      if (y >= info.height * 0.55 && y < info.height * 0.85) {
        lowerPixels++;
        if (r > 200 && g > 200 && b > 200) lowerWhitePixels++;
      }
      if (y >= info.height * 0.45 && y < info.height * 0.8 && x >= info.width * 0.12 && x < info.width * 0.88) {
        lowerContentPixels++;
        const cyan = isLoadingCyan(r, g, b);
        if (cyan) lowerCyanPixels++;
        if (!cyan && (Math.max(r, g, b) - Math.min(r, g, b) > 18 || Math.max(r, g, b) > 70)) {
          lowerDetailPixels++;
        }
      }
      if (y >= info.height * 0.66 && y < info.height * 0.82 && x >= info.width * 0.25 && x < info.width * 0.75) {
        recentContentPixels++;
        if (isLoadingAccent(r, g, b)) {
          recentAccentPixels++;
          recentAccentMinX = Math.min(recentAccentMinX, x);
          recentAccentMinY = Math.min(recentAccentMinY, y);
          recentAccentMaxX = Math.max(recentAccentMaxX, x);
          recentAccentMaxY = Math.max(recentAccentMaxY, y);
        }
      }
      if (x > 0 && y > 0) {
        const gradient = Math.abs(luma - luminanceAt(x - 1, y)) + Math.abs(luma - luminanceAt(x, y - 1));
        if (gradient > 35) edgePixels++;
      }
    }
  }
  const mean = totalPixels > 0 ? luminanceSum / totalPixels : 0;
  const variance = totalPixels > 0 ? luminanceSquaredSum / totalPixels - mean * mean : 0;
  let entropy = 0;
  for (const count of bins) {
    if (count === 0 || totalPixels === 0) continue;
    const p = count / totalPixels;
    entropy -= p * Math.log2(p);
  }
  const edgeRatio = totalPixels > 0 ? edgePixels / totalPixels : 0;
  const nonBackgroundRatio = totalPixels > 0 ? nonBackgroundPixels / totalPixels : 0;
  const topBrightRatio = topPixels > 0 ? topBrightPixels / topPixels : 0;
  const lowerWhiteRatio = lowerPixels > 0 ? lowerWhitePixels / lowerPixels : 0;
  const lowerCyanRatio = lowerContentPixels > 0 ? lowerCyanPixels / lowerContentPixels : 0;
  const lowerDetailRatio = lowerContentPixels > 0 ? lowerDetailPixels / lowerContentPixels : 0;
  const recentAccentRatio = recentContentPixels > 0 ? recentAccentPixels / recentContentPixels : 0;
  const recentAccentWidthRatio = recentAccentPixels > 0 ? (recentAccentMaxX - recentAccentMinX + 1) / info.width : 0;
  const recentAccentHeightRatio = recentAccentPixels > 0 ? (recentAccentMaxY - recentAccentMinY + 1) / info.height : 0;
  const recentAccentCenterXRatio = recentAccentPixels > 0 ? ((recentAccentMinX + recentAccentMaxX) / 2) / info.width : 0;

  let statusSignatureRows = 0;
  const statusBandEnd = Math.max(1, Math.ceil(info.height * 0.04));
  for (let y = 0; y < statusBandEnd; y++) {
    let brightNeutralPixels = 0;
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * 4;
      const r = data[offset] ?? 0;
      const g = data[offset + 1] ?? 0;
      const b = data[offset + 2] ?? 0;
      if (Math.min(r, g, b) >= 150 && Math.max(r, g, b) - Math.min(r, g, b) <= 55) {
        brightNeutralPixels++;
      }
    }
    const rowRatio = brightNeutralPixels / info.width;
    if (rowRatio >= 0.02 && rowRatio <= 0.45) statusSignatureRows++;
  }
  const topSystemBarLikely = statusSignatureRows >= Math.max(2, Math.floor(info.height * 0.003));

  let gestureSignatureRows = 0;
  const gestureBandStart = Math.floor(info.height * 0.96);
  for (let y = gestureBandStart; y < info.height; y++) {
    let longestStart = 0;
    let longestLength = 0;
    let currentStart = 0;
    let currentLength = 0;
    for (let x = 0; x < info.width; x++) {
      const offset = (y * info.width + x) * 4;
      const r = data[offset] ?? 0;
      const g = data[offset + 1] ?? 0;
      const b = data[offset + 2] ?? 0;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const isNeutralPillPixel = luma >= 55 && luma <= 190 && Math.max(r, g, b) - Math.min(r, g, b) <= 24;
      if (isNeutralPillPixel) {
        if (currentLength === 0) currentStart = x;
        currentLength++;
        if (currentLength > longestLength) {
          longestStart = currentStart;
          longestLength = currentLength;
        }
      } else {
        currentLength = 0;
      }
    }
    const widthRatio = longestLength / info.width;
    const centerRatio = (longestStart + longestLength / 2) / info.width;
    if (widthRatio >= 0.18 && widthRatio <= 0.6 && centerRatio >= 0.42 && centerRatio <= 0.58) {
      gestureSignatureRows++;
    }
  }
  const bottomSystemBarLikely = gestureSignatureRows >= Math.max(2, Math.floor(info.height * 0.002));
  const systemBarsVisible = topSystemBarLikely || bottomSystemBarLikely;

  let changedRatio = 0;
  if (firstPixelBuffer) {
    let changedPixels = 0;
    const compareLength = Math.min(firstPixelBuffer.length, data.length);
    const comparePixels = Math.floor(compareLength / 4);
    for (let i = 0; i < comparePixels; i++) {
      const r1 = firstPixelBuffer[i * 4] ?? 0;
      const g1 = firstPixelBuffer[i * 4 + 1] ?? 0;
      const b1 = firstPixelBuffer[i * 4 + 2] ?? 0;
      const r2 = data[i * 4] ?? 0;
      const g2 = data[i * 4 + 1] ?? 0;
      const b2 = data[i * 4 + 2] ?? 0;
      if (Math.abs(r1 - r2) > 10 || Math.abs(g1 - g2) > 10 || Math.abs(b1 - b2) > 10) {
        changedPixels++;
      }
    }
    changedRatio = totalPixels > 0 ? changedPixels / totalPixels : 0;
  }

  const immersiveEducationOverlayLikely = topBrightRatio < 0.01 && lowerWhiteRatio > 0.02;
  const partialLoadingLikely = recentAccentRatio >= 0.0015
    && recentAccentWidthRatio >= 0.04
    && recentAccentHeightRatio >= 0.02
    && recentAccentCenterXRatio >= 0.35
    && recentAccentCenterXRatio <= 0.65;
  const detailOk = variance >= 300
    && entropy >= 0.6
    && edgeRatio >= 0.01
    && nonBackgroundRatio >= 0.03
    && !immersiveEducationOverlayLikely
    && !partialLoadingLikely
    && !systemBarsVisible;
  const reason = detailOk
    ? `ready: variance=${variance.toFixed(1)} entropy=${entropy.toFixed(3)} edgeRatio=${edgeRatio.toFixed(4)} nonBackgroundRatio=${nonBackgroundRatio.toFixed(4)} topBrightRatio=${topBrightRatio.toFixed(4)} lowerWhiteRatio=${lowerWhiteRatio.toFixed(4)} lowerCyanRatio=${lowerCyanRatio.toFixed(4)} lowerDetailRatio=${lowerDetailRatio.toFixed(4)} recentAccentRatio=${recentAccentRatio.toFixed(4)} recentAccentBox=${recentAccentWidthRatio.toFixed(4)}x${recentAccentHeightRatio.toFixed(4)} changedRatio=${changedRatio.toFixed(4)}`
    : `not_ready: variance=${variance.toFixed(1)} entropy=${entropy.toFixed(3)} edgeRatio=${edgeRatio.toFixed(4)} nonBackgroundRatio=${nonBackgroundRatio.toFixed(4)} topBrightRatio=${topBrightRatio.toFixed(4)} lowerWhiteRatio=${lowerWhiteRatio.toFixed(4)} lowerCyanRatio=${lowerCyanRatio.toFixed(4)} lowerDetailRatio=${lowerDetailRatio.toFixed(4)} recentAccentRatio=${recentAccentRatio.toFixed(4)} recentAccentBox=${recentAccentWidthRatio.toFixed(4)}x${recentAccentHeightRatio.toFixed(4)} changedRatio=${changedRatio.toFixed(4)}${immersiveEducationOverlayLikely ? " immersive_overlay" : ""}${partialLoadingLikely ? " partial_loading" : ""}${systemBarsVisible ? ` system_bars_visible(top=${topSystemBarLikely},bottom=${bottomSystemBarLikely})` : ""}`;

  return {
    ok: detailOk,
    pixelBuffer: data,
    variance,
    entropy,
    edgeRatio,
    nonBackgroundRatio,
    changedRatio,
    topBrightRatio,
    lowerWhiteRatio,
    lowerCyanRatio,
    lowerDetailRatio,
    recentAccentRatio,
    recentAccentWidthRatio,
    recentAccentHeightRatio,
    reason
  };
}

export async function reseedAndCaptureCalorixToday(opts: CalorixDeviceOptions = {}): Promise<CalorixPreparedActual> {
  const projectRoot = opts.projectRoot ?? getCalorixProjectRoot();
  const runner = opts.runner ?? defaultRunner;
  const now = opts.now ?? Date.now;
  const sleepMs = opts.sleepMs ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const validateImg = opts.validateImage ?? validateCalorixTodayScreenshotForReadiness;
  const adbConfig = resolveAdbConfig(opts);

  await runner(adbConfig.executable, buildAdbArgs(adbConfig, "shell", "input", "keyevent", "KEYCODE_WAKEUP"), { timeout: 30000, encoding: "utf8" });
  await runner(adbConfig.executable, buildAdbArgs(adbConfig, "shell", "wm", "dismiss-keyguard"), { timeout: 30000, encoding: "utf8" });
  await runner(adbConfig.executable, buildAdbArgs(adbConfig, "shell", "settings", "put", "secure", "immersive_mode_confirmations", "confirmed"), { timeout: 30000, encoding: "utf8" }).catch(() => undefined);
  await runner(adbConfig.executable, buildAdbArgs(adbConfig, "shell", "input", "keyevent", "BACK"), { timeout: 30000, encoding: "utf8" }).catch(() => undefined);
  await runner(adbConfig.executable, buildAdbArgs(adbConfig, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "calorix://debug/reseed"), { timeout: 30000, encoding: "utf8" });

  const captureDir = path.join(projectRoot, ".ui-diff", "captures");
  await fs.mkdir(captureDir, { recursive: true });

  const retryIntervalMs = numberFromEnv("UI_DIFF_CALORIX_CAPTURE_RETRY_MS", 1000);
  const readyTimeoutMs = numberFromEnv("UI_DIFF_CALORIX_CAPTURE_READY_TIMEOUT_MS", 60000);
  const maxAttempts = Math.max(1, Math.ceil(readyTimeoutMs / retryIntervalMs));
  await pruneOldCaptureAttempts(captureDir, numberFromEnv("UI_DIFF_CALORIX_CAPTURE_REJECT_KEEP", 30));
  let attempt = 0;
  let lastCapture: CaptureResult | undefined;
  let firstPixelBuffer: Buffer | undefined;
  let lastReadinessReason = "no capture attempted";

  while (attempt < maxAttempts) {
    attempt++;
    await sleepMs(retryIntervalMs);

    const outputPath = path.join(captureDir, `today-${new Date(now()).toISOString().replace(/[:.]/g, "-")}-attempt-${attempt}.png`);
    let capture: CaptureResult;
    try {
      const captureOpts: { makeOutputPath: () => string; adbExecutable?: string; adbSerial?: string } = { makeOutputPath: () => outputPath, adbExecutable: adbConfig.executable };
      if (adbConfig.serial !== undefined) captureOpts.adbSerial = adbConfig.serial;
      capture = await (opts.capture ?? captureMobileScreen)("adb", captureOpts);
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      continue;
    }

    lastCapture = capture;

    if (capture.validationStatus !== "ok") {
      continue;
    }

    let validationResult: CalorixScreenshotReadiness;
    try {
      validationResult = await validateImg(capture.path, firstPixelBuffer);
    } catch (err) {
      lastReadinessReason = err instanceof Error ? err.message : String(err);
      continue;
    }
    lastReadinessReason = validationResult.reason;

    if (!firstPixelBuffer) {
      firstPixelBuffer = validationResult.pixelBuffer;
      if (validationResult.ok) {
        const finalPath = path.join(captureDir, `today-${new Date(now()).toISOString().replace(/[:.]/g, "-")}.png`);
        await fs.rename(capture.path, finalPath);
        capture.path = finalPath;
        return { actualImagePath: finalPath, capture, source: "auto_capture" };
      }
      if (validationResult.reason.includes("immersive_overlay")) {
        await runner(adbConfig.executable, buildAdbArgs(adbConfig, "shell", "input", "tap", String(Math.round(capture.width / 2)), String(Math.round(capture.height * 0.86))), { timeout: 30000, encoding: "utf8" }).catch(() => undefined);
      }
      continue;
    }

    if (validationResult.ok) {
      const finalPath = path.join(captureDir, `today-${new Date(now()).toISOString().replace(/[:.]/g, "-")}.png`);
      await fs.rename(capture.path, finalPath);
      capture.path = finalPath;
      return { actualImagePath: finalPath, capture, source: "auto_capture" };
    }
    if (validationResult.reason.includes("immersive_overlay")) {
      await runner(adbConfig.executable, buildAdbArgs(adbConfig, "shell", "input", "tap", String(Math.round(capture.width / 2)), String(Math.round(capture.height * 0.86))), { timeout: 30000, encoding: "utf8" }).catch(() => undefined);
    }
  }

  if (lastCapture) {
    throw new Error(`Calorix capture retry timeout: Today screen failed to render after ${maxAttempts} attempts. Last validationStatus: ${lastCapture.validationStatus}. Last readiness: ${lastReadinessReason}`);
  }
  throw new Error(`Calorix capture retry timeout: Today screen failed to render after ${maxAttempts} attempts.`);
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
  return memoizedActual;
}
