import { describe, expect, it } from "vitest";
import { collectReleaseIntegrityIssues } from "../helpers/release-integrity.js";
import type { DiffRecord } from "../../src/schemas/core.js";

function diff(id: string, overrides: Partial<DiffRecord> = {}): DiffRecord {
  return {
    id,
    criterion: "geometry",
    severity: "medium",
    title: "Panel is shifted",
    location: { x: 10, y: 20, width: 80, height: 40 },
    evidence: ["Expected and actual panel positions differ."],
    measurements: [],
    artifactPaths: [],
    reviewerStatus: "accepted",
    classificationSource: "vlm_reviewed",
    ...overrides
  };
}

function input(overrides: Partial<Parameters<typeof collectReleaseIntegrityIssues>[0]> = {}): Parameters<typeof collectReleaseIntegrityIssues>[0] {
  return {
    auditLimited: false,
    diffs: [diff("diff-1")],
    unresolvedRegions: [],
    recoveryStatusCounts: {},
    finalDiffCount: 1,
    finalGroupCount: 1,
    groups: [{ id: "group-001", diffIds: ["diff-1"] }],
    ...overrides
  };
}

describe("collectReleaseIntegrityIssues", () => {
  it("accepts an uncapped report with one valid group and supported claim", () => {
    expect(collectReleaseIntegrityIssues(input())).toEqual([]);
  });

  it("blocks deferred broad fragments and unresolved regions in uncapped runs", () => {
    const issues = collectReleaseIntegrityIssues(input({
      unresolvedRegions: [{ id: "region-1" }],
      recoveryStatusCounts: { deferred_broad_evidence_fragment: 1 }
    }));

    expect(issues).toEqual(expect.arrayContaining([
      "unresolved_regions:1",
      "uncapped_deferred_broad_evidence_fragment:1"
    ]));
  });

  it("rejects missing, duplicate, dangling, and self group references", () => {
    const issues = collectReleaseIntegrityIssues(input({
      diffs: [diff("diff-1"), diff("diff-2")],
      finalDiffCount: 2,
      finalGroupCount: 3,
      groups: [
        { id: "group-001", diffIds: ["diff-1"] },
        { id: "group-002", diffIds: ["diff-1", "missing"] }
      ]
    }));

    expect(issues).toEqual(expect.arrayContaining([
      "final_group_count_exceeds_final_diff_count:3>2",
      "final_group_count_mismatch:3!=2",
      "duplicate_group_diff_reference:diff-1",
      "dangling_group_diff_reference:missing",
      "missing_group_diff_reference:diff-2"
    ]));
  });

  it("requires new release reports to persist finalGroupCount", () => {
    const issues = collectReleaseIntegrityIssues(input({ finalGroupCount: undefined }));

    expect(issues).toContain("missing_final_group_count");
  });

  it("rejects final records that list themselves as children", () => {
    const issues = collectReleaseIntegrityIssues(input({
      diffs: [diff("diff-1", { childFindingIds: ["diff-1"] })]
    }));

    expect(issues).toContain("self_child_reference:diff-1");
  });

  it("rejects accepted output with unsupported exact color claims", () => {
    const issues = collectReleaseIntegrityIssues(input({
      diffs: [diff("diff-1", {
        title: "Panel is #1A1A1A",
        evidence: ["The actual panel is exactly #1A1A1A."]
      })]
    }));

    expect(issues).toContain("unsupported_accepted_claim:diff-1:unsupported_exact_color");
  });
});
