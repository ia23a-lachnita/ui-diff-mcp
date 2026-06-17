import { describe, expect, it } from "vitest";
import { resolveDualLocatorMode } from "../../src/pipeline/run-ui-diff.js";

describe("resolveDualLocatorMode", () => {
  it("returns disabled with no warning when no env vars set (projection default)", () => {
    const result = resolveDualLocatorMode({});
    expect(result.enabled).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("returns disabled with warning when only UI_DIFF_DUAL_LOCATOR=1 is set (old flag alone is rejected)", () => {
    const result = resolveDualLocatorMode({ UI_DIFF_DUAL_LOCATOR: "1" });
    expect(result.enabled).toBe(false);
    expect(result.warning).toMatch(/UI_DIFF_ALLOW_DUAL_LOCATOR/);
    expect(result.warning).toMatch(/projection/);
  });

  it("returns disabled with warning when guard set but reason missing", () => {
    const result = resolveDualLocatorMode({ UI_DIFF_DUAL_LOCATOR: "1", UI_DIFF_ALLOW_DUAL_LOCATOR: "1" });
    expect(result.enabled).toBe(false);
    expect(result.warning).toMatch(/UI_DIFF_DUAL_LOCATOR_REASON/);
  });

  it("returns disabled with warning when reason set but guard missing", () => {
    const result = resolveDualLocatorMode({ UI_DIFF_DUAL_LOCATOR: "1", UI_DIFF_DUAL_LOCATOR_REASON: "debugging" });
    expect(result.enabled).toBe(false);
    expect(result.warning).toMatch(/UI_DIFF_ALLOW_DUAL_LOCATOR/);
  });

  it("returns enabled with reason in warning when all three flags are set", () => {
    const result = resolveDualLocatorMode({
      UI_DIFF_DUAL_LOCATOR: "1",
      UI_DIFF_ALLOW_DUAL_LOCATOR: "1",
      UI_DIFF_DUAL_LOCATOR_REASON: "debugging lane coverage discrepancy"
    });
    expect(result.enabled).toBe(true);
    expect(result.warning).toMatch(/debugging lane coverage discrepancy/);
  });
});
