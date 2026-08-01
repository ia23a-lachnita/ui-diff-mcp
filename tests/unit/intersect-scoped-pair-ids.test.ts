import { describe, expect, it } from "vitest";
import { intersectScopedPairIds } from "../../src/pipeline/run-ui-diff.js";

describe("intersectScopedPairIds", () => {
  it("returns empty set when no IDs match scope", () => {
    const scoped = new Set(["a", "b"]);
    const skipIds = new Set(["x", "y"]);
    expect(intersectScopedPairIds(scoped, skipIds)).toEqual(new Set());
  });

  it("returns only scoped IDs from a single set", () => {
    const scoped = new Set(["a", "b", "c"]);
    const skipIds = new Set(["b", "c", "d"]);
    expect(intersectScopedPairIds(scoped, skipIds)).toEqual(new Set(["b", "c"]));
  });

  it("unions across multiple input sets", () => {
    const scoped = new Set(["a", "b", "c"]);
    const presenceIds = new Set(["a"]);
    const skipIds = new Set(["b", "d"]);
    expect(intersectScopedPairIds(scoped, presenceIds, skipIds)).toEqual(new Set(["a", "b"]));
  });

  it("excludes out-of-scope projected skip IDs", () => {
    const scoped = new Set(["pair-1", "pair-2"]);
    const presenceIds = new Set<string>();
    const projectedSkipIds = new Set(["pair-1", "pair-3"]);
    // pair-3 is out of scope and must not appear in the result
    expect(intersectScopedPairIds(scoped, presenceIds, projectedSkipIds)).toEqual(new Set(["pair-1"]));
  });

  it("handles array inputs", () => {
    const scoped = new Set(["a", "b"]);
    expect(intersectScopedPairIds(scoped, ["a", "c"], ["b", "d"])).toEqual(new Set(["a", "b"]));
  });

  it("returns empty set for empty scoped set", () => {
    const scoped = new Set<string>();
    const skipIds = new Set(["a", "b"]);
    expect(intersectScopedPairIds(scoped, skipIds)).toEqual(new Set());
  });
});
