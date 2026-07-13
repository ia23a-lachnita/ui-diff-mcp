import type { DeterministicMeasurement, DiffRecord, UiArtifact } from "../schemas/core.js";

const CROP_BOUNDARY_PHRASES = /\b(left half|right half|cut off|cut short|cropped)\b/i;
const CROP_QUALIFIED_PHRASES = /\b(crop|position|projected)\b/i;
const ABSENCE_PHRASES = /\b(absent|missing|does\s+not\s+exist|doesn't\s+exist|no\s+(?:visible\s+)?content|no\s+element|not\s+(?:visible|present)|gone|no\s+longer\s+(?:present|visible))\b/i;
const GLOBAL_BLANK_IMAGE_PHRASES = /\b(?:actual|expected)?\s*(?:screenshot|image|screen|page)\b[^.!?;\n]{0,80}\b(?:blank|empty)\b/i;
const GLOBAL_BLACK_IMAGE_PHRASES = /\b(?:actual|expected)?\s*(?:screenshot|image|screen|page)\b[^.!?;\n]{0,80}\b(?:(?:entirely|completely|totally|solid)\s+black|all[-\s]?black)\b/i;
const ABSENCE_QUALIFIER = /\b(?:crop|projected\s+expected\s+position|expected\s+position|within\s+(?:the\s+)?supplied\s+crop)\b/i;

export function hasUnsupportedCropBoundaryClaim(diff: Pick<DiffRecord, "title" | "evidence">): boolean {
  const searchable = [diff.title, ...diff.evidence].join(" ");
  if (!CROP_BOUNDARY_PHRASES.test(searchable)) return false;
  return !CROP_QUALIFIED_PHRASES.test(searchable);
}

function splitStatements(value: string): string[] {
  return value.split(/[.!?;\n]+/).map(statement => statement.trim()).filter(Boolean);
}

function isOrdinaryBlackElementStatement(statement: string): boolean {
  if (!/\bblack\b/i.test(statement)) return false;
  if (/\b(?:button|text|background|icon|label|header|image|element|border|ring)\b/i.test(statement) &&
    !/\b(entirely|completely|totally|solid|all[-\s]?black)\b/i.test(statement)) {
    return true;
  }
  return false;
}

function hasUnsupportedAbsenceClaim(diff: Pick<DiffRecord, "title" | "evidence">): boolean {
  const statements = [diff.title, ...diff.evidence].flatMap(splitStatements);
  return statements.some(statement => {
    if (isOrdinaryBlackElementStatement(statement)) return false;
    const isGlobalBlankImage = GLOBAL_BLANK_IMAGE_PHRASES.test(statement);
    const isGlobalBlackImage = GLOBAL_BLACK_IMAGE_PHRASES.test(statement) && !isOrdinaryBlackElementStatement(statement);
    const isAbsence = isGlobalBlankImage || isGlobalBlackImage || ABSENCE_PHRASES.test(statement);
    return isAbsence && !ABSENCE_QUALIFIER.test(statement);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedUnit(unit: string | undefined): string {
  const lower = (unit ?? "").toLowerCase();
  if (lower === "%" || lower === "percent") return "%";
  if (["px²", "px^2", "square pixels", "pixels squared"].includes(lower)) return "px²";
  if (["pixel-count", "pixel count", "pixel", "pixels"].includes(lower)) return "pixels";
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
  const unitClaim = /(-?\d+(?:\.\d+)?)\s*(px²|px\^2|square\s+pixels|pixels\s+squared|pixel[-\s]?count|pixels?|px|dp|pt|degrees?|°|%|percent)(?![\w])/gi;
  for (const match of searchable.matchAll(unitClaim)) {
    const value = Math.abs(Number(match[1]));
    const unit = normalizedUnit(match[2]);
    if (!supported.some(item => item.value === value && item.unit === unit)) return true;
  }
  const pixelCountClaim = /\bpixel[-\s]?count\b\s*(?:is|of|=|:)?\s*(-?\d+(?:\.\d+)?)/gi;
  for (const match of searchable.matchAll(pixelCountClaim)) {
    const value = Math.abs(Number(match[1]));
    if (!supported.some(item => item.value === value && item.unit === "pixels")) return true;
  }
  const unqualifiedLayoutNumber = /\b(shifted|moved|offset|gap|spacing|margin|padding|font\s*size|width|height|radius|angle)\b[^.\n]{0,30}?(-?\d+(?:\.\d+)?)(?!\s*(?:px|dp|pt|degrees?|°|%|percent))/i;
  const layoutMatch = searchable.match(unqualifiedLayoutNumber);
  if (!layoutMatch) return false;
  const value = Math.abs(Number(layoutMatch[2]));
  return !supported.some(item => item.value === value);
}

function hasInvalidPaletteMeasurement(measurement: DeterministicMeasurement): boolean {
  if (!/^color_dominant_.+_palette$/i.test(measurement.name)) return false;
  if (typeof measurement.value !== "string") return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(measurement.value);
  } catch {
    return true;
  }
  if (!Array.isArray(parsed)) return true;
  return parsed.some(entry => {
    if (!entry || typeof entry !== "object") return true;
    const value = entry as Record<string, unknown>;
    return ["r", "g", "b"].some(channel =>
      typeof value[channel] !== "number" || !Number.isInteger(value[channel]) || value[channel] < 0 || value[channel] > 255
    ) || typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 0;
  });
}

export interface ClaimValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateClaim(
  diff: Pick<DiffRecord, "title" | "evidence" | "measurements">,
  visibleTexts: string[] = []
): ClaimValidationResult {
  if (hasUnsupportedAbsenceClaim(diff)) {
    return { valid: false, reason: "Unsupported global absence or blank claim without crop-grounded evidence" };
  }
  if (hasUnsupportedCropBoundaryClaim(diff)) {
    return { valid: false, reason: "Unsupported crop-boundary claim without crop or position qualification" };
  }
  if (hasUnsupportedQuantitativeClaim(diff, diff.measurements, visibleTexts)) {
    return { valid: false, reason: "Unsupported quantitative claim" };
  }
  const invalidPalette = diff.measurements.find(hasInvalidPaletteMeasurement);
  if (invalidPalette) {
    return { valid: false, reason: `Invalid ${invalidPalette.name} measurement` };
  }
  return { valid: true };
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
    !validateClaim(d).valid
      ? { ...d, reviewerStatus: "rejected" as const }
      : d
  );
  const filtered = filterAcceptedDiffs(guarded);
  return deduplicateDiffs(filtered);
}

const SCOPE_AUDIT_ROLES = ["expected_normalized", "actual_comparison_space", "directional_overlay", "pixel_diff_mask"] as const;
const TARGET_AUDIT_ROLES = ["expected_crop", "actual_crop", "local_directional_overlay", "local_pixel_diff_mask", "context_crop"] as const;
const RECOVERY_ROLES = ["recovery_expected_crop", "recovery_actual_crop", "recovery_directional_overlay", "recovery_pixel_diff_mask"] as const;

export function requiredAcceptedArtifactRoles(diff: Pick<DiffRecord, "classificationSource" | "scopeKind">): readonly UiArtifact["role"][] {
  if (diff.classificationSource === "target_recovery") return RECOVERY_ROLES;
  if (diff.classificationSource === "vlm_reviewed" && (diff.scopeKind === "screen" || diff.scopeKind === "region")) return SCOPE_AUDIT_ROLES;
  return TARGET_AUDIT_ROLES;
}
