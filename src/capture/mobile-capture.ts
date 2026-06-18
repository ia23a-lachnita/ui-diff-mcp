import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

export type CaptureTarget = "adb" | "ios-simctl";

export interface CommandRunner {
  (file: string, args: string[], options: { timeout: number; encoding?: "buffer" }): Promise<unknown>;
}

export interface CaptureOptions {
  runner?: CommandRunner;
  makeOutputPath?: () => string;
}

export interface CaptureResult {
  path: string;
  width: number;
  height: number;
  blankPixelRatio: number;
  validationStatus: "ok" | "blank" | "invalid_dimensions" | "parse_error";
  warnings: string[];
}

const defaultRunner: CommandRunner = (file, args, options) => execFileAsync(file, args, options);

function defaultOutputPath(): string {
  return path.join(os.tmpdir(), `ui-diff-capture-${crypto.randomBytes(4).toString("hex")}.png`);
}

async function validateCapture(filePath: string): Promise<CaptureResult> {
  const warnings: string[] = [];
  let width = 0;
  let height = 0;
  let blankPixelRatio = 0;

  let meta: sharp.Metadata;
  try {
    meta = await sharp(filePath).metadata();
  } catch (err) {
    return { path: filePath, width: 0, height: 0, blankPixelRatio: 0, validationStatus: "parse_error", warnings: [`PNG parse failed: ${err instanceof Error ? err.message : String(err)}`] };
  }

  width = meta.width ?? 0;
  height = meta.height ?? 0;

  if (width === 0 || height === 0) {
    return { path: filePath, width, height, blankPixelRatio: 0, validationStatus: "invalid_dimensions", warnings: [`Screenshot has zero dimensions: ${width}x${height}`] };
  }

  const { data } = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = Math.floor(data.length / 4);
  let nearBlack = 0;
  for (let i = 0; i < pixels; i++) {
    const r = data[i * 4] ?? 0;
    const g = data[i * 4 + 1] ?? 0;
    const b = data[i * 4 + 2] ?? 0;
    if (r < 4 && g < 4 && b < 4) nearBlack++;
  }
  blankPixelRatio = pixels > 0 ? nearBlack / pixels : 0;

  if (blankPixelRatio > 0.98) {
    warnings.push(`Screenshot appears blank: blankPixelRatio=${blankPixelRatio.toFixed(3)}`);
    return { path: filePath, width, height, blankPixelRatio, validationStatus: "blank", warnings };
  }

  return { path: filePath, width, height, blankPixelRatio, validationStatus: "ok", warnings };
}

export async function captureMobileScreen(
  target: CaptureTarget,
  opts: CaptureOptions = {}
): Promise<CaptureResult> {
  const runner = opts.runner ?? defaultRunner;
  const outPath = opts.makeOutputPath?.() ?? defaultOutputPath();

  if (target === "adb") {
    try {
      const result = await runner("adb", ["exec-out", "screencap", "-p"], {
        encoding: "buffer",
        timeout: 30000
      }) as { stdout?: Buffer } | undefined;
      const buf = result?.stdout;
      if (!buf || buf.length === 0) {
        throw new Error("adb exec-out returned empty buffer");
      }
      await fs.writeFile(outPath, buf);
      return validateCapture(outPath);
    } catch (err) {
      throw new Error(`adb capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (target === "ios-simctl") {
    try {
      await runner("xcrun", ["simctl", "io", "booted", "screenshot", outPath], { timeout: 30000 });
      return validateCapture(outPath);
    } catch (err) {
      throw new Error(`ios-simctl capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`Unsupported capture target: ${target}`);
}
