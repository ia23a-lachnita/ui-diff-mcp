import type { ClaimDiagnostics, DeterministicMeasurement, DiffRecord, UiArtifact } from "../schemas/core.js";

const CROP_BOUNDARY_PHRASES = /\b(left half|right half|cut off|cut short|cropped)\b/i;
const CROP_QUALIFIED_PHRASES = /\b(crop|position|projected)\b/i;
const ABSENCE_PHRASES = /\b(absent|missing|does\s+not\s+exist|doesn't\s+exist|no\s+(?:visible\s+)?content|no\s+element|not\s+(?:visible|present)|gone|no\s+longer\s+(?:present|visible))\b/i;
const GLOBAL_BLANK_IMAGE_PHRASES = /\b(?:actual|expected)?\s*(?:screenshot|image|screen|page)\b[^.!?;\n]{0,80}\b(?:blank|empty)\b/i;
const GLOBAL_BLACK_IMAGE_PHRASES = /\b(?:actual|expected)?\s*(?:screenshot|image|screen|page)\b[^.!?;\n]{0,80}\b(?:(?:entirely|completely|totally|solid)\s+black|all[-\s]?black)\b/i;
const ABSENCE_QUALIFIER = /\b(?:crop|projected\s+expected\s+position|expected\s+position|within\s+(?:the\s+)?supplied\s+crop)\b/i;
const NEGATED_ABSENCE_PHRASE = /\b(?:not|isn't|is\s+not|doesn't|does\s+not|cannot|can't|no|without|never)\b[^.!?;\n]{0,60}\b(?:absent|missing|misplaced|gone|no\s+(?:visible\s+)?content|no\s+element|blank|empty|black)\b/i;

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

function isUnsupportedAbsenceStatement(statement: string): boolean {
  if (NEGATED_ABSENCE_PHRASE.test(statement)) return false;
  if (isOrdinaryBlackElementStatement(statement)) return false;
  const isGlobalBlankImage = GLOBAL_BLANK_IMAGE_PHRASES.test(statement);
  const isGlobalBlackImage = GLOBAL_BLACK_IMAGE_PHRASES.test(statement) && !isOrdinaryBlackElementStatement(statement);
  const isAbsence = isGlobalBlankImage || isGlobalBlackImage || ABSENCE_PHRASES.test(statement);
  return isAbsence && !ABSENCE_QUALIFIER.test(statement);
}

function unsupportedStatementExcerpt(
  diff: Pick<DiffRecord, "title" | "evidence">,
  predicate: (statement: string) => boolean,
  phrasePattern: RegExp
): string | undefined {
  const searchable = [diff.title, ...diff.evidence].join(" ");
  let searchStart = 0;
  for (const statement of splitStatements(searchable)) {
    const statementStart = searchable.indexOf(statement, searchStart);
    searchStart = statementStart >= 0 ? statementStart + statement.length : searchStart;
    if (!predicate(statement) || statementStart < 0) continue;
    const phrase = statement.match(phrasePattern);
    const phraseIndex = phrase?.index ?? 0;
    return extractContext(searchable, statementStart + phraseIndex, phrase?.[0]?.length ?? statement.length);
  }
  return undefined;
}

function hasUnsupportedAbsenceClaim(diff: Pick<DiffRecord, "title" | "evidence">): boolean {
  const statements = [diff.title, ...diff.evidence].flatMap(splitStatements);
  return statements.some(isUnsupportedAbsenceStatement);
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

function extractContext(text: string, matchIndex: number | undefined, matchLength: number): string {
  if (matchIndex === undefined) return truncateToLimit(text, MAX_EXCERPT_LENGTH);
  const availableContext = Math.max(0, MAX_EXCERPT_LENGTH - matchLength);
  const preferredStart = Math.max(0, matchIndex - Math.floor(availableContext / 2));
  const start = Math.min(preferredStart, Math.max(0, text.length - MAX_EXCERPT_LENGTH));
  return text.slice(start, start + MAX_EXCERPT_LENGTH);
}

export function hasUnsupportedQuantitativeClaim(
  diff: Pick<DiffRecord, "title" | "evidence">,
  measurements: DeterministicMeasurement[] = [],
  visibleTexts: string[] = []
): boolean {
  return analyzeQuantitativeClaims(diff, measurements, visibleTexts) !== undefined;
}

interface QuantitativeAnalysis {
  offendingValue: number;
  offendingUnit: string;
  excerpt: string;
}

function analyzeQuantitativeClaims(
  diff: Pick<DiffRecord, "title" | "evidence">,
  measurements: DeterministicMeasurement[] = [],
  visibleTexts: string[] = []
): QuantitativeAnalysis | undefined {
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
    if (!supported.some(item => item.value === value && item.unit === unit)) {
      return {
        offendingValue: value,
        offendingUnit: unit,
        excerpt: extractContext(searchable, match.index, match[0].length)
      };
    }
  }
  const pixelCountClaim = /\bpixel[-\s]?count\b\s*(?:is|of|=|:)?\s*(-?\d+(?:\.\d+)?)/gi;
  for (const match of searchable.matchAll(pixelCountClaim)) {
    const value = Math.abs(Number(match[1]));
    if (!supported.some(item => item.value === value && item.unit === "pixels")) {
      return {
        offendingValue: value,
        offendingUnit: "pixels",
        excerpt: extractContext(searchable, match.index, match[0].length)
      };
    }
  }
  const unqualifiedLayoutNumber = /\b(shifted|moved|offset|gap|spacing|margin|padding|font\s*size|width|height|radius|angle)\b[^.\n]{0,30}?(-?\d+(?:\.\d+)?)(?!\s*(?:px|dp|pt|degrees?|°|%|percent))/i;
  const layoutMatch = searchable.match(unqualifiedLayoutNumber);
  if (!layoutMatch) return undefined;
  const value = Math.abs(Number(layoutMatch[2]));
  if (supported.some(item => item.value === value)) return undefined;
  return {
    offendingValue: value,
    offendingUnit: "",
    excerpt: extractContext(searchable, layoutMatch.index, layoutMatch[0].length)
  };
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

const MAX_EXCERPT_LENGTH = 200;
const MAX_SUPPORTED_MEASUREMENTS = 10;

function truncateToLimit(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit);
}

function boundedExcerpt(texts: string[]): string | undefined {
  const joined = texts.join(" ");
  if (!joined) return undefined;
  return truncateToLimit(joined, MAX_EXCERPT_LENGTH);
}

function boundedSupportedMeasurements(measurements: DeterministicMeasurement[]): ClaimDiagnostics["quantitative"] extends infer T ? { name: string; value: string | number | boolean; unit?: string }[] : never {
  return measurements
    .filter(m => typeof m.value === "number")
    .slice(0, MAX_SUPPORTED_MEASUREMENTS)
    .map(m => ({
      name: m.name,
      value: Math.abs(m.value as number),
      ...(m.unit !== undefined ? { unit: m.unit } : {})
    }));
}

export interface ClaimValidationResult {
  valid: boolean;
  reason?: string;
  diagnostics?: ClaimDiagnostics;
}

export function validateClaim(
  diff: Pick<DiffRecord, "title" | "evidence" | "measurements">,
  visibleTexts: string[] = []
): ClaimValidationResult {
  if (hasUnsupportedAbsenceClaim(diff)) {
    const excerpt = unsupportedStatementExcerpt(
      diff,
      isUnsupportedAbsenceStatement,
      /(?:screenshot|image|screen|page)[^.!?;\n]{0,80}(?:blank|empty|black)|absent|missing|does\s+not\s+exist|doesn't\s+exist|no\s+(?:visible\s+)?content|no\s+element|not\s+(?:visible|present)|gone|no\s+longer\s+(?:present|visible)/i
    ) ?? boundedExcerpt([diff.title, ...diff.evidence]);
    return {
      valid: false,
      reason: "Unsupported global absence or blank claim without crop-grounded evidence",
      diagnostics: {
        code: "unsupported_absence",
        message: "Unsupported global absence or blank claim without crop-grounded evidence",
        ...(excerpt !== undefined ? { offendingExcerpt: excerpt } : {})
      }
    };
  }
  if (hasUnsupportedCropBoundaryClaim(diff)) {
    const excerpt = unsupportedStatementExcerpt(
      diff,
      statement => CROP_BOUNDARY_PHRASES.test(statement) && !CROP_QUALIFIED_PHRASES.test(statement),
      CROP_BOUNDARY_PHRASES
    ) ?? boundedExcerpt([diff.title, ...diff.evidence]);
    return {
      valid: false,
      reason: "Unsupported crop-boundary claim without crop or position qualification",
      diagnostics: {
        code: "unsupported_crop_boundary",
        message: "Unsupported crop-boundary claim without crop or position qualification",
        ...(excerpt !== undefined ? { offendingExcerpt: excerpt } : {})
      }
    };
  }
  if (hasUnsupportedQuantitativeClaim(diff, diff.measurements, visibleTexts)) {
    const analysis = analyzeQuantitativeClaims(diff, diff.measurements, visibleTexts)!;
    const supported = boundedSupportedMeasurements(diff.measurements);
    return {
      valid: false,
      reason: "Unsupported quantitative claim",
      diagnostics: {
        code: "unsupported_quantitative",
        message: "Unsupported quantitative claim",
        offendingExcerpt: analysis.excerpt,
        ...(analysis.offendingValue !== undefined && analysis.offendingUnit !== undefined ? {
          quantitative: {
            offendingValue: analysis.offendingValue,
            offendingUnit: analysis.offendingUnit,
            supportedMeasurements: supported
          }
        } : {})
      }
    };
  }
  const invalidPalette = diff.measurements.find(hasInvalidPaletteMeasurement);
  if (invalidPalette) {
    return {
      valid: false,
      reason: `Invalid ${invalidPalette.name} measurement`,
      diagnostics: {
        code: "invalid_palette",
        message: `Invalid ${invalidPalette.name} measurement`
      }
    };
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
