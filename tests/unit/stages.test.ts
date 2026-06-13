import { describe, expect, it } from "vitest";
import { runStage } from "../../src/pipeline/stages.js";

describe("runStage", () => {
  it("returns stage result with timing and data", async () => {
    const result = await runStage("test-stage", async () => ({ value: 42 }));
    expect(result.name).toBe("test-stage");
    expect(result.data).toEqual({ value: 42 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.startedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();
    expect(result.warnings).toEqual([]);
  });

  it("forwards provided warnings array", async () => {
    const result = await runStage("w", async () => null, ["warn-a"]);
    expect(result.warnings).toEqual(["warn-a"]);
  });

  it("propagates rejections from fn", async () => {
    await expect(
      runStage("fail", async () => { throw new Error("boom"); })
    ).rejects.toThrow("boom");
  });
});
