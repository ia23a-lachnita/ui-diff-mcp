import { describe, it, expect } from "vitest";
import { createServer } from "../../src/server.js";

describe("MCP Tool Surface", () => {
  const server = createServer();

  it("should have a compare_ui_images tool", () => {
    expect(server.getTool("compare_ui_images")).toBeDefined();
  });

  it("should have a discover_ui_diffs tool", () => {
    expect(server.getTool("discover_ui_diffs")).toBeDefined();
  });

  it("should have a ui_diff_model_health tool", () => {
    expect(server.getTool("ui_diff_model_health")).toBeDefined();
  });

  it("should have a read_ui_diff_report tool", () => {
    expect(server.getTool("read_ui_diff_report")).toBeDefined();
  });

  it("should have a capture_mobile_screen tool", () => {
    expect(server.getTool("capture_mobile_screen")).toBeDefined();
  });
});
