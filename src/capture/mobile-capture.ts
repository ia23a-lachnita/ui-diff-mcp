import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

export type CaptureTarget = "adb" | "ios-simctl";

export interface CommandRunner {
  (file: string, args: string[], options: { timeout: number; encoding?: "buffer" }): Promise<unknown>;
}

export interface CaptureOptions {
  runner?: CommandRunner;
  makeOutputPath?: () => string;
}

const defaultRunner: CommandRunner = (file, args, options) => execFileAsync(file, args, options);

function defaultOutputPath(): string {
  return path.join(os.tmpdir(), `ui-diff-capture-${crypto.randomBytes(4).toString("hex")}.png`);
}

export async function captureMobileScreen(
  target: CaptureTarget,
  opts: CaptureOptions = {}
): Promise<string> {
  const runner = opts.runner ?? defaultRunner;
  const outPath = opts.makeOutputPath?.() ?? defaultOutputPath();

  if (target === "adb") {
    try {
      await runner("adb", ["exec-out", "screencap", "-p"], {
        encoding: "buffer",
        timeout: 30000
      });
      await runner("adb", ["shell", "screencap", "-p", "/sdcard/screen.png"], { timeout: 30000 });
      await runner("adb", ["pull", "/sdcard/screen.png", outPath], { timeout: 30000 });
      return outPath;
    } catch (err) {
      throw new Error(`adb capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (target === "ios-simctl") {
    try {
      await runner("xcrun", ["simctl", "io", "booted", "screenshot", outPath], { timeout: 30000 });
      return outPath;
    } catch (err) {
      throw new Error(`ios-simctl capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`Unsupported capture target: ${target}`);
}
