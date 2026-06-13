import { describe, expect, it } from "vitest";
import { selectAuditPairsForRun } from "../../src/pipeline/run-ui-diff.js";
import type { ElementPair } from "../../src/schemas/core.js";

function pair(id: string): ElementPair {
  return { id, status: "matched", score: 1, reasons: [] };
}

describe("selectAuditPairsForRun", () => {
  it("keeps all pairs when no budget is configured", () => {
    const result = selectAuditPairsForRun([pair("a"), pair("b")], {});

    expect(result.pairs.map(p => p.id)).toEqual(["a", "b"]);
    expect(result.limited).toBe(false);
  });

  it("limits pairs and records a warning when a positive budget is configured", () => {
    const result = selectAuditPairsForRun(
      [pair("a"), pair("b"), pair("c")],
      { UI_DIFF_MAX_AUDIT_PAIRS: "2" }
    );

    expect(result.pairs.map(p => p.id)).toEqual(["a", "b"]);
    expect(result.limited).toBe(true);
    expect(result.warning).toContain("2 of 3");
  });
});
