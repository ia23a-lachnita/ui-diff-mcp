import { describe, expect, it } from "vitest";
import { createServer } from "../../src/server.js";

describe("MCP Tool Surface", () => {
  it("createServer returns a truthy MCP server", () => {
    const server = createServer();
    expect(server).toBeTruthy();
  });
});
