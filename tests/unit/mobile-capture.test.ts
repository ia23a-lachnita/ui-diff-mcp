import { describe, expect, it, vi } from "vitest";
import { captureMobileScreen, type CommandRunner } from "../../src/capture/mobile-capture.js";

function runnerOk(): ReturnType<typeof vi.fn<CommandRunner>> {
  return vi.fn<CommandRunner>().mockResolvedValue(undefined);
}

describe("captureMobileScreen", () => {
  it("runs adb capture commands with argument arrays and returns output path", async () => {
    const runner = runnerOk();
    const out = await captureMobileScreen("adb", {
      runner,
      makeOutputPath: () => "C:/tmp/ui-diff-capture.png"
    });

    expect(out).toBe("C:/tmp/ui-diff-capture.png");
    expect(runner).toHaveBeenNthCalledWith(
      1,
      "adb",
      ["exec-out", "screencap", "-p"],
      { encoding: "buffer", timeout: 30000 }
    );
    expect(runner).toHaveBeenNthCalledWith(
      2,
      "adb",
      ["shell", "screencap", "-p", "/sdcard/screen.png"],
      { timeout: 30000 }
    );
    expect(runner).toHaveBeenNthCalledWith(
      3,
      "adb",
      ["pull", "/sdcard/screen.png", "C:/tmp/ui-diff-capture.png"],
      { timeout: 30000 }
    );
  });

  it("wraps adb command failures", async () => {
    const runner = vi.fn<CommandRunner>().mockRejectedValue(new Error("adb missing"));
    await expect(captureMobileScreen("adb", { runner })).rejects.toThrow(/adb capture failed: adb missing/);
  });

  it("runs ios simulator screenshot command with argument array", async () => {
    const runner = runnerOk();
    const out = await captureMobileScreen("ios-simctl", {
      runner,
      makeOutputPath: () => "C:/tmp/ios.png"
    });

    expect(out).toBe("C:/tmp/ios.png");
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(
      "xcrun",
      ["simctl", "io", "booted", "screenshot", "C:/tmp/ios.png"],
      { timeout: 30000 }
    );
  });

  it("wraps ios simulator command failures", async () => {
    const runner = vi.fn<CommandRunner>().mockRejectedValue(new Error("no booted simulator"));
    await expect(captureMobileScreen("ios-simctl", { runner })).rejects.toThrow(/ios-simctl capture failed: no booted simulator/);
  });

  it("rejects unknown target kinds", async () => {
    await expect(captureMobileScreen("unknown" as "adb")).rejects.toThrow(/Unsupported capture target/);
  });
});
