import { validateClaim } from "../../src/audit/review-findings.js";
import type { DiffRecord } from "../../src/schemas/core.js";

export interface ReleaseIntegrityInput {
  auditLimited: boolean;
  diffs: DiffRecord[];
  unresolvedRegions: Array<{ id: string }>;
  recoveryStatusCounts: Record<string, number>;
  finalDiffCount: number;
  finalGroupCount: number | undefined;
  groups: Array<{ id: string; diffIds: string[] }>;
}

export function collectReleaseIntegrityIssues(input: ReleaseIntegrityInput): string[] {
  const issues: string[] = [];
  if (input.unresolvedRegions.length > 0) {
    issues.push(`unresolved_regions:${input.unresolvedRegions.length}`);
  }

  const deferredBroadFragments = input.recoveryStatusCounts["deferred_broad_evidence_fragment"] ?? 0;
  if (!input.auditLimited && deferredBroadFragments > 0) {
    issues.push(`uncapped_deferred_broad_evidence_fragment:${deferredBroadFragments}`);
  }

  if (input.finalGroupCount === undefined) {
    issues.push("missing_final_group_count");
  } else {
    if (input.finalGroupCount > input.finalDiffCount) {
      issues.push(`final_group_count_exceeds_final_diff_count:${input.finalGroupCount}>${input.finalDiffCount}`);
    }
    if (input.finalGroupCount !== input.groups.length) {
      issues.push(`final_group_count_mismatch:${input.finalGroupCount}!=${input.groups.length}`);
    }
  }

  const diffIds = new Set(input.diffs.map(diff => diff.id));
  const referenceCounts = new Map<string, number>();
  for (const group of input.groups) {
    for (const diffId of group.diffIds) {
      referenceCounts.set(diffId, (referenceCounts.get(diffId) ?? 0) + 1);
      if (!diffIds.has(diffId)) issues.push(`dangling_group_diff_reference:${diffId}`);
    }
  }
  for (const diff of input.diffs) {
    const count = referenceCounts.get(diff.id) ?? 0;
    if (count === 0) issues.push(`missing_group_diff_reference:${diff.id}`);
    if (count > 1) issues.push(`duplicate_group_diff_reference:${diff.id}`);
    if ((diff.childFindingIds ?? []).includes(diff.id)) issues.push(`self_child_reference:${diff.id}`);

    if (diff.reviewerStatus === "accepted") {
      const validation = validateClaim(diff);
      if (!validation.valid) {
        issues.push(`unsupported_accepted_claim:${diff.id}:${validation.diagnostics?.code ?? "unknown"}`);
      }
    }
  }

  return [...new Set(issues)].sort((a, b) => a.localeCompare(b));
}
