import { describe, expect, it } from "vitest";
import {
  validateDeterministicAccounting,
  assertDeterministicAccounting
} from "../helpers/deterministic-accounting.js";
import type { DeterministicAccountingInput } from "../helpers/deterministic-accounting.js";

describe("validateDeterministicAccounting", () => {
  it("accepts zero groups with zero pairs", () => {
    const issues = validateDeterministicAccounting({
      groupCount: 0,
      groupedPairs: 0,
      deterministicProjectedDiffs: 5
    });
    expect(issues).toEqual([]);
  });

  it("rejects zero groups with nonzero pairs", () => {
    const issues = validateDeterministicAccounting({
      groupCount: 0,
      groupedPairs: 3,
      deterministicProjectedDiffs: 5
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("zero_groups_nonzero_pairs");
  });

  it("rejects positive groups with fewer than 2 grouped pairs", () => {
    const issues = validateDeterministicAccounting({
      groupCount: 1,
      groupedPairs: 1,
      deterministicProjectedDiffs: 5
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("positive_groups_insufficient_pairs");
  });

  it("accepts positive groups with 2 grouped pairs", () => {
    const issues = validateDeterministicAccounting({
      groupCount: 1,
      groupedPairs: 2,
      deterministicProjectedDiffs: 5
    });
    expect(issues).toEqual([]);
  });

  it("rejects groupedPairs exceeding deterministicProjectedDiffs", () => {
    const issues = validateDeterministicAccounting({
      groupCount: 1,
      groupedPairs: 6,
      deterministicProjectedDiffs: 5
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe("grouped_pairs_exceeds_deterministic_diffs");
  });

  it("reports multiple independent violations simultaneously", () => {
    const issues = validateDeterministicAccounting({
      groupCount: 0,
      groupedPairs: 10,
      deterministicProjectedDiffs: 5
    });
    expect(issues.map(i => i.code)).toEqual(
      expect.arrayContaining([
        "grouped_pairs_exceeds_deterministic_diffs",
        "zero_groups_nonzero_pairs"
      ])
    );
  });

  it("accepts multiple groups with matching pair counts", () => {
    const issues = validateDeterministicAccounting({
      groupCount: 3,
      groupedPairs: 8,
      deterministicProjectedDiffs: 12
    });
    expect(issues).toEqual([]);
  });
});

describe("assertDeterministicAccounting", () => {
  it("returns silently on valid input", () => {
    expect(() => assertDeterministicAccounting({
      groupCount: 0,
      groupedPairs: 0,
      deterministicProjectedDiffs: 5
    })).not.toThrow();
  });

  it("throws with descriptive message on violation", () => {
    expect(() => assertDeterministicAccounting({
      groupCount: 0,
      groupedPairs: 3,
      deterministicProjectedDiffs: 5
    })).toThrow(/zero_groups_nonzero_pairs/);
  });
});
