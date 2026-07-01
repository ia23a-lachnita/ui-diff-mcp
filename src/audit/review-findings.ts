import type { DeterministicMeasurement, DiffRecord } from "../schemas/core.js";

const CROP_BOUNDARY_PHRASES = /\b(left half|right half|cut off|cut short|cropped)\b/i;
const CROP_QUALIFIED_PHRASES = /\b(crop|position|projected)\b/i;

export function hasUnsupportedCropBoundaryClaim(diff: DiffRecord): boolean {
  const searchable = [diff.title, ...diff.evidence].join(" ");
  if (!CROP_BOUNDARY_PHRASES.test(searchable)) return false;
  return !CROP_QUALIFIED_PHRASES.test(searchable);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedUnit(unit: string | undefined): string {
  const lower = (unit ?? "").toLowerCase();
  if (lower === "percent") return "%";
  if (lower.startsWith("degree") || lower === "°") return "degree";
  return lower;
}

export function hasUnsupportedQuantitativeClaim(
  diff: Pick<DiffRecord, "title" | "evidence">,
  measurements: DeterministicMeasurement[] = [],
  visibleTexts: string[] = []
): boolean {
  let searchable = [diff.title, ...diff.evidence].join(" ");
  searchable = searchable.replace(/(["'`]).*?\1/g, " ");
  for (const visibleText of visibleTexts.filter(Boolean).sort((a, b) => b.length - a.length)) {
    searchable = searchable.replace(new RegExp(escapeRegExp(visibleText), "gi"), " ");
  }
  const supported = measurements.flatMap(measurement => {
    if (typeof measurement.value !== "number") return [];
    return [{ value: Math.abs(measurement.value), unit: normalizedUnit(measurement.unit) }];
  });
  const unitClaim = /(-?\d+(?:\.\d+)?)\s*(px|dp|pt|degrees?|°|%|percent)(?![\w])/gi;
  for (const match of searchable.matchAll(unitClaim)) {
    const value = Math.abs(Number(match[1]));
    const unit = normalizedUnit(match[2]);
    if (!supported.some(item => item.value === value && item.unit === unit)) return true;
  }
  const unqualifiedLayoutNumber = /\b(shifted|moved|offset|gap|spacing|margin|padding|font\s*size|width|height|radius|angle)\b[^.\n]{0,30}?(-?\d+(?:\.\d+)?)(?!\s*(?:px|dp|pt|degrees?|°|%|percent))/i;
  const layoutMatch = searchable.match(unqualifiedLayoutNumber);
  if (!layoutMatch) return false;
  const value = Math.abs(Number(layoutMatch[2]));
  return !supported.some(item => item.value === value);
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
  return diffs.filter(d =>
    d.reviewerStatus === "accepted" ||
    (
      d.reviewerStatus === "not_reviewed" &&
      (
        d.classificationSource === "deterministic_projected_mismatch" ||
        d.classificationSource === "deterministic_geometry" ||
        d.classificationSource === "deterministic_presence"
      )
    )
  );
}

export function reviewAndMergeFindings(rawDiffs: DiffRecord[]): DiffRecord[] {
  const guarded = rawDiffs.map(d =>
    hasUnsupportedCropBoundaryClaim(d) || hasUnsupportedQuantitativeClaim(d, d.measurements)
      ? { ...d, reviewerStatus: "rejected" as const }
      : d
  );
  const filtered = filterAcceptedDiffs(guarded);
  return deduplicateDiffs(filtered);
}
