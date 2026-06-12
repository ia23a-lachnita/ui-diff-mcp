import { describe, expect, it } from "vitest";
import { createServer } from "../../src/server.js";
import { captureMobileScreen } from "../../src/capture/mobile-capture.js";

describe("MCP Tool Surface", () => {
  it("createServer returns a truthy MCP server", () => {
    const server = createServer();
    expect(server).toBeTruthy();
  });
});

describe("capture_mobile_screen", () => {
  it("rejects unknown target kinds", async () => {
    await expect(
      captureMobileScreen("unknown" as "adb")
    ).rejects.toThrow(/Unsupported capture target/);
  });
});
