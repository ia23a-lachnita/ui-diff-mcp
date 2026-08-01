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
    structuralConsolidation: {
      status: "pass",
      candidateCount: 1,
      retainedCount: 1,
      suppressedCount: 0,
      broadExcludedCount: 0,
      violationCount: 0
    },
    ...overrides
  };
}

describe("collectReleaseIntegrityIssues", () => {
  it("accepts an uncapped report with one valid group and supported claim", () => {
    expect(collectReleaseIntegrityIssues(input())).toEqual([]);
  });

  it("accepts distinct sibling findings represented once in one presentation legend group", () => {
    const first = diff("sibling-a", {
      location: { x: 20, y: 40, width: 60, height: 50 },
      targetIds: ["sibling-a"],
      findingGroupId: "displacement-f42d88d2c4a1",
      findingGroupKind: "coherent_displacement"
    });
    const second = diff("sibling-b", {
      location: { x: 45, y: 40, width: 60, height: 50 },
      targetIds: ["sibling-b"],
      findingGroupId: "displacement-f42d88d2c4a1",
      findingGroupKind: "coherent_displacement"
    });
    const finalDiffs = [first, second];
    const legendGroups = [{ id: "group-001", diffIds: finalDiffs.map(item => item.id) }];
    expect(new Set(finalDiffs.map(item => item.findingGroupId)).size).toBe(1);
    expect(finalDiffs.every(item => item.findingGroupKind === "coherent_displacement")).toBe(true);
    const issues = collectReleaseIntegrityIssues(input({
      diffs: finalDiffs,
      finalDiffCount: 2,
      finalGroupCount: 1,
      groups: legendGroups,
      structuralConsolidation: {
        status: "pass",
        candidateCount: 2,
        retainedCount: 2,
        suppressedCount: 0,
        broadExcludedCount: 0,
        violationCount: 0
      }
    }));

    expect(issues).toEqual([]);
    expect(legendGroups).toHaveLength(1);
    expect(legendGroups[0]?.diffIds).toEqual(["sibling-a", "sibling-b"]);
    const references = finalDiffs.map(item => legendGroups.flatMap(group => group.diffIds).filter(id => id === item.id));
    expect(references).toEqual([["sibling-a"], ["sibling-b"]]);
  });

  it("rejects a missing or non-passing structural consolidation summary", () => {
    const { structuralConsolidation: _ignored, ...withoutStructural } = input();
    expect(collectReleaseIntegrityIssues(withoutStructural)).toContain("missing_structural_consolidation");
    expect(collectReleaseIntegrityIssues(input({
      structuralConsolidation: { ...input().structuralConsolidation!, status: "not_evaluated" }
    })).some(issue => issue === "structural_consolidation:not_evaluated")).toBe(true);
    expect(collectReleaseIntegrityIssues(input({
      structuralConsolidation: { ...input().structuralConsolidation!, status: "fail", violationCount: 1 }
    })).some(issue => issue === "structural_consolidation:fail")).toBe(true);
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
