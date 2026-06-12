import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

export async function captureMobileScreen(
  target: "adb" | "ios-simctl"
): Promise<string> {
  const outPath = path.join(os.tmpdir(), `ui-diff-capture-${crypto.randomBytes(4).toString("hex")}.png`);

  if (target === "adb") {
    try {
      await execFileAsync("adb", ["exec-out", "screencap", "-p"], {
        encoding: "buffer",
        timeout: 30000
      });
      await execFileAsync("adb", ["shell", "screencap", "-p", "/sdcard/screen.png"], { timeout: 30000 });
      await execFileAsync("adb", ["pull", "/sdcard/screen.png", outPath], { timeout: 30000 });
      return outPath;
    } catch (err) {
      throw new Error(`adb capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (target === "ios-simctl") {
    try {
      await execFileAsync("xcrun", ["simctl", "io", "booted", "screenshot", outPath], { timeout: 30000 });
      return outPath;
    } catch (err) {
      throw new Error(`ios-simctl capture failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`Unsupported capture target: ${target}`);
}
