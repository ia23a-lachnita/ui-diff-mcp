import type { DiffRecord } from "../schemas/core.js";

export function deduplicateDiffs(diffs: DiffRecord[]): DiffRecord[] {
  const seen = new Map<string, DiffRecord>();
  for (const diff of diffs) {
    const key = `${diff.criterion}:${diff.pairId ?? diff.location.x}:${diff.location.y}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, diff);
    } else {
      const severityOrder = { low: 0, medium: 1, high: 2 };
      if (severityOrder[diff.severity] > severityOrder[existing.severity]) {
        seen.set(key, diff);
      }
    }
  }
  return [...seen.values()];
}

export function filterAcceptedDiffs(diffs: DiffRecord[]): DiffRecord[] {
  return diffs.filter(d => d.reviewerStatus !== "rejected");
}

export function reviewAndMergeFindings(rawDiffs: DiffRecord[]): DiffRecord[] {
  const filtered = filterAcceptedDiffs(rawDiffs);
  return deduplicateDiffs(filtered);
}
