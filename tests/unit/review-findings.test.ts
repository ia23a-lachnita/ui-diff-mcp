import { describe, expect, it } from "vitest";
import { deduplicateDiffs, filterAcceptedDiffs, reviewAndMergeFindings } from "../../src/audit/review-findings.js";
import type { DiffRecord } from "../../src/schemas/core.js";

function makeDiff(overrides: Partial<DiffRecord> = {}): DiffRecord {
  return {
    id: "diff-1",
    pairId: "pair-1",
    criterion: "geometry",
    severity: "low",
    title: "test diff",
    reviewerStatus: "accepted",
    location: { x: 10, y: 20, width: 100, height: 50 },
    evidence: ["some evidence"],
    measurements: [],
    artifactPaths: [],
    ...overrides
  };
}

describe("deduplicateDiffs", () => {
  it("keeps first occurrence when same key appears", () => {
    const a = makeDiff({ id: "a", severity: "low" });
    const b = makeDiff({ id: "b", severity: "low" });
    const result = deduplicateDiffs([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("a");
  });

  it("upgrades to higher severity when duplicate key has higher severity", () => {
    const a = makeDiff({ id: "a", severity: "low" });
    const b = makeDiff({ id: "b", severity: "high" });
    const result = deduplicateDiffs([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("high");
  });

  it("keeps unique diffs with different keys", () => {
    const a = makeDiff({ id: "a", location: { x: 10, y: 20, width: 100, height: 50 } });
    const b = makeDiff({ id: "b", location: { x: 99, y: 99, width: 10, height: 10 } });
    expect(deduplicateDiffs([a, b])).toHaveLength(2);
  });
});

describe("filterAcceptedDiffs", () => {
  it("removes rejected diffs", () => {
    const accepted = makeDiff({ id: "a", reviewerStatus: "accepted" });
    const rejected = makeDiff({ id: "b", reviewerStatus: "rejected" });
    expect(filterAcceptedDiffs([accepted, rejected])).toEqual([accepted]);
  });
});

describe("reviewAndMergeFindings", () => {
  it("filters rejected and deduplicates", () => {
    const a = makeDiff({ id: "a", severity: "low", reviewerStatus: "accepted" });
    const b = makeDiff({ id: "b", severity: "medium", reviewerStatus: "accepted" });
    const rejected = makeDiff({ id: "c", reviewerStatus: "rejected" });
    const result = reviewAndMergeFindings([a, b, rejected]);
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("medium");
  });
});
