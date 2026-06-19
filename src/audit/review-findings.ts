import type { DiffRecord } from "../schemas/core.js";

const CROP_BOUNDARY_PHRASES = /\b(left half|right half|cut off|cut short|cropped)\b/i;
const CROP_QUALIFIED_PHRASES = /\b(crop|position|projected)\b/i;

export function hasUnsupportedCropBoundaryClaim(diff: DiffRecord): boolean {
  const searchable = [diff.title, ...diff.evidence].join(" ");
  if (!CROP_BOUNDARY_PHRASES.test(searchable)) return false;
  return !CROP_QUALIFIED_PHRASES.test(searchable);
}

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
  const guarded = rawDiffs.map(d =>
    hasUnsupportedCropBoundaryClaim(d) ? { ...d, reviewerStatus: "rejected" as const } : d
  );
  const filtered = filterAcceptedDiffs(guarded);
  return deduplicateDiffs(filtered);
}
