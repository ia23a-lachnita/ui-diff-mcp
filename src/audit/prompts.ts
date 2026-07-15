import type { UiCriterion, DeterministicMeasurement } from "../schemas/core.js";
import type { CriterionRubric } from "./criteria.js";

const CLASSIFIABLE_CRITERIA = [
  "presence",
  "geometry",
  "spacing_alignment",
  "typography_content",
  "color_appearance",
  "icon_image",
  "layering_clipping",
  "component_state",
  "chart_special_geometry"
] as const;

const NO_SPECULATION_RULE = `- Do NOT speculate about causality or design intent.`;
const NAMED_MEASUREMENT_RULE = `- Exact percentages, pixels, sizes, angles, coordinates, and color values (hex/RGB) are allowed only when citing a listed deterministic measurement by name.`;

export function buildRecoveryPrompt(pixelCount: number, componentArea: number, measurements: DeterministicMeasurement[] = []): string {
  const criteriaList = CLASSIFIABLE_CRITERIA.join(" | ");
  const deterministicMeasurements = measurements.length > 0 ? measurements : [
    { name: "changed_pixel_count", value: pixelCount, unit: "pixels" },
    { name: "region_area_pixels", value: componentArea, unit: "px²" },
    { name: "changed_pixel_percent", value: componentArea > 0 ? Math.round((pixelCount / componentArea) * 10000) / 100 : 0, unit: "%" },
    { name: "coordinateSource", value: "deterministic_pixel_component" }
  ];
  const measurementLines = deterministicMeasurements.map(m => `  - ${m.name}: ${m.value}${m.unit ? " " + m.unit : ""}`).join("\n");
  return [
    `You are a UI diff recovery specialist. A visual difference region was detected by pixel analysis but was not matched to any located UI element.`,
    ``,
    `REGION STATS:`,
    `  - Changed pixels: ${pixelCount}`,
    `  - Component area: ${componentArea}px²`,
    ``,
    `DETERMINISTIC MEASUREMENTS:`,
    measurementLines,
    ``,
    `EVIDENCE IMAGES (in order):`,
    `  1. EXPECTED crop — context-expanded evidence: expected image cropped to a region around the changed pixels; the crop may include surrounding UI context around the authoritative changed pixels`,
    `  2. ACTUAL comparison crop — actual source crop resized with Lanczos to the expected crop dimensions`,
    `  3. Directional diff overlay — diagnostic annotation ink: cyan where expected differs, magenta where actual differs, yellow at region outlines. These colors are overlay annotations, not UI colors. The overlay localizes authoritative changed pixels within the context-expanded evidence.`,
    `  4. Pixel-diff mask — white pixels mark changed regions within the context-expanded evidence. The mask localizes the authoritative changed pixels.`,
    ``,
    `TASK:`,
    `Examine the images and determine whether this region contains a classifiable UI difference.`,
    `If yes, provide: criterion, severity, a short descriptive label, and evidence.`,
    `If the region cannot be classified as a meaningful UI diff (e.g., rendering noise, compression artifact), set classified to false.`,
    ``,
    `Evidence sources:`,
    `- Appearance/content claims (color, typography, icon, layering) must come from source crops 1 and 2 only.`,
    `- The context-expanded crops show surrounding context; do not claim the entire context differs. Only the pixels localized by the overlay/mask are known to differ.`,
    `- Overlay and mask images localize differences only; do not treat overlay annotation colors (cyan, magenta, yellow) as actual UI colors.`,
    `- Exact color values (hex, RGB) require a named deterministic source-color measurement.`,
    ``,
    `VALID CRITERIA: ${criteriaList}`,
    ``,
    `STRICT RULES:`,
    `- Report ONLY observable visual differences visible in the images.`,
    `- Do NOT suggest code fixes or root causes.`,
    NO_SPECULATION_RULE,
    NAMED_MEASUREMENT_RULE,
    `- The deterministic region already provides the screen location; do not return coordinates or a bounding box.`,
    `- Evidence must be specific (e.g., "background color changed from dark to light").`,
    ``,
    `EXACT OUTPUT SHAPE:`,
    `- No meaningful difference: { "classified": false }`,
    `- Classifiable difference: { "classified": true, "criterion": "presence", "severity": "high", "label": "short visible label", "evidence": ["visible qualitative observation"] }`,
    `- Use an array of strings for evidence. Return no coordinate or bounding-box fields.`,
    ``,
    `Respond with JSON only matching that exact shape and the provided schema. No prose before or after the JSON.`
  ].join("\n");
}

export interface AuditorPromptContext {
  criterion: UiCriterion;
  rubric: CriterionRubric;
  elementLabel: string;
  elementType: string;
  pairingStatus: string;
  measurements: DeterministicMeasurement[];
}

export function buildAuditorPrompt(ctx: AuditorPromptContext): string {
  const measurementLines = ctx.measurements.length > 0
    ? ctx.measurements.map(m => `  - ${m.name}: ${m.value}${m.unit ? " " + m.unit : ""}`).join("\n")
    : "  (none)";

  return [
    `You are a UI quality inspector. Your task is to determine whether a specific UI criterion differs between an expected mockup and an actual screenshot.`,
    ``,
    `ELEMENT: "${ctx.elementLabel}" (type: ${ctx.elementType}, pairing: ${ctx.pairingStatus})`,
    `CRITERION: ${ctx.criterion}`,
    `CRITERION DESCRIPTION: ${ctx.rubric.description}`,
    ``,
    `DETERMINISTIC MEASUREMENTS:`,
    measurementLines,
    ``,
    `EVIDENCE IMAGES (in order):`,
    `  1. EXPECTED crop — the expected mockup for this element`,
    `  2. ACTUAL crop — the actual screenshot for this element`,
    `  3. Directional diff overlay — cyan where expected differs, magenta where actual differs, yellow at region outlines`,
    `  4. Pixel-diff mask — white pixels mark changed regions`,
    `  5. Context crop — wider view of the expected image for spatial context`,
    ``,
    `STRICT RULES:`,
    `- Report ONLY observable visual differences between the two images.`,
    `- Do NOT explain why the difference exists.`,
    `- Do NOT suggest how to resolve the difference in code or design.`,
    `- Do NOT comment on correctness or acceptability of the UI.`,
    `- Do NOT speculate about implementation details.`,
    NO_SPECULATION_RULE,
    NAMED_MEASUREMENT_RULE,
    `- Evidence must be visually specific but qualitative unless it cites a deterministic measurement listed above by name.`,
    `- Do not invent pixel, spacing, font-size, percentage, or angle measurements.`,
    ``,
    `Evidence discipline:`,
    `- Describe only visible differences supported by the supplied crops, overlay, mask, and measurements.`,
    `- The overlay and mask localize authoritative changed pixels; do not claim the entire crop differs.`,
    `- If a crop appears clipped or only partially contains the expected target, say "crop/position mismatch" instead of claiming hidden content.`,
    `- Do not infer implementation cause, app code cause, or config cause.`,
    `- Do not recommend fixes.`,
    `- If the evidence is only a projected-location mismatch, classify it as presence/geometry only when visible evidence supports that label.`,
    ``,
    `EXACT OUTPUT SHAPE:`,
    `- No criterion difference: { "hasDiff": false }`,
    `- Visible criterion difference: { "hasDiff": true, "severity": "medium", "title": "short qualitative title", "evidence": ["visible qualitative observation"] }`,
    `- Use the exact keys hasDiff, severity, title, and evidence. Evidence is always an array of strings.`,
    `- Do not return determination or reasoning keys.`,
    ``,
    `Respond with JSON only matching that exact shape and the provided schema. No prose before or after the JSON.`
  ].join("\n");
}

export function buildReviewerPrompt(
  criterion: UiCriterion,
  elementLabel: string,
  auditorTitle: string,
  evidence: string[],
  measurements: DeterministicMeasurement[] = []
): string {
  const evidenceLines = evidence.map(e => `  - ${e}`).join("\n");
  const measurementLines = measurements.length > 0
    ? measurements.map(m => `  - ${m.name}: ${m.value}${m.unit ? " " + m.unit : ""}`).join("\n")
    : "  (none)";

  return [
    `You are a UI diff reviewer. Evaluate whether the following reported diff is valid based solely on the supplied evidence.`,
    ``,
    `ELEMENT: "${elementLabel}"`,
    `CRITERION: ${criterion}`,
    `REPORTED TITLE: ${auditorTitle}`,
    ``,
    `EVIDENCE:`,
    evidenceLines,
    `DETERMINISTIC MEASUREMENTS:`,
    measurementLines,
    ``,
    `EVIDENCE IMAGES (in order):`,
    `  1. EXPECTED crop — the expected mockup for this element`,
    `  2. ACTUAL crop — the actual screenshot for this element`,
    `  3. Directional diff overlay — cyan where expected differs, magenta where actual differs, yellow at region outlines`,
    `  4. Pixel-diff mask — white pixels mark changed regions`,
    `  5. Context crop — wider view of the expected image for spatial context`,
    ``,
    `STRICT RULES:`,
    `- Accept the diff ONLY if the evidence is visually verifiable in the images.`,
    `- Reject the diff if the evidence is vague, unverifiable, or contradicted by the images.`,
    `- Mark needs_escalation if the images are ambiguous or the diff requires deeper analysis.`,
    `- Do NOT explain causality. Do NOT suggest code changes. Do NOT judge correctness.`,
    NO_SPECULATION_RULE,
    NAMED_MEASUREMENT_RULE,
    `- Reject the diff if its title or evidence claims content that is not visible in the supplied images.`,
    `- Accept crop-boundary evidence only when the record explicitly calls it a crop/position mismatch.`,
    `- Reject unsupported quantitative layout claims. Exact dimensions, positions, spacing, font sizes, percentages, and angles are valid only when they cite a deterministic measurement listed above.`,
    `- Reject any title or evidence that violates these rules, including causality, design-intent, or uncited exact-quantity claims.`,
    `- The overlay and mask localize authoritative changed pixels; do not claim the entire crop differs.`,
    ``,
    `Respond with JSON only: { "decision": "accepted" | "rejected" | "needs_escalation", "reason": "<one sentence>" }`
  ].join("\n");
}

export interface RepairPromptContext {
  originalCriterion: UiCriterion;
  originalLabel: string;
  originalTitle: string;
  originalEvidence: string[];
  diagnosticCode: string;
  diagnosticMessage: string;
  diagnosticExcerpt?: string;
  measurements: DeterministicMeasurement[];
}

export function buildRecoveryRepairPrompt(ctx: RepairPromptContext): string {
  const evidenceLines = ctx.originalEvidence.map(e => `  - ${e}`).join("\n");
  const measurementLines = ctx.measurements.length > 0
    ? ctx.measurements.map(m => `  - ${m.name}: ${m.value}${m.unit ? " " + m.unit : ""}`).join("\n")
    : "  (none)";

  return [
    `You are a UI diff recovery repair specialist. An initial recovery classification was rejected by validation.`,
    ``,
    `ORIGINAL CLASSIFICATION:`,
    `  Criterion: ${ctx.originalCriterion}`,
    `  Label: ${ctx.originalLabel}`,
    `  Title: ${ctx.originalTitle}`,
    `  Evidence:`,
    evidenceLines,
    ``,
    `VALIDATION DIAGNOSTIC:`,
    `  Code: ${ctx.diagnosticCode}`,
    `  Message: ${ctx.diagnosticMessage}`,
    ...(ctx.diagnosticExcerpt !== undefined ? [`  Offending excerpt: "${ctx.diagnosticExcerpt}"`] : []),
    ``,
    `DETERMINISTIC MEASUREMENTS:`,
    measurementLines,
    ``,
    `EVIDENCE IMAGES (in order):`,
    `  1. EXPECTED crop — context-expanded evidence: expected image cropped to a region around the changed pixels; the crop may include surrounding UI context around the authoritative changed pixels`,
    `  2. ACTUAL comparison crop — actual source crop resized with Lanczos to the expected crop dimensions`,
    `  3. Directional diff overlay — diagnostic annotation ink: cyan where expected differs, magenta where actual differs, yellow at region outlines. These colors are overlay annotations, not UI colors. The overlay localizes authoritative changed pixels within the context-expanded evidence.`,
    `  4. Pixel-diff mask — white pixels mark changed regions within the context-expanded evidence. The mask localizes the authoritative changed pixels.`,
    ``,
    `TASK:`,
    `Reclassify this region from scratch using only the four source images and the deterministic measurements.`,
    `You must provide a complete new classification. Do NOT repeat the unsupported claim.`,
    ``,
    `RULES:`,
    `- If no meaningful UI difference exists, set classified to false.`,
    `- If classified is true, use the SAME criterion as the original: ${ctx.originalCriterion}.`,
    `- Qualitative evidence only. Describe visible differences from source crops 1 and 2.`,
    `- The context-expanded crops show surrounding context; do not claim the entire context differs. Only the pixels localized by the overlay/mask are known to differ.`,
    `- Do NOT invent new measurements or facts not present in the images or deterministic measurements.`,
    `- Do NOT repeat the offending excerpt or claim pattern that caused the validation failure.`,
    `- Exact color values (hex, RGB) require a named deterministic source-color measurement.`,
    `- Overlay and mask images localize differences only; do not treat overlay annotation colors as UI colors.`,
    NO_SPECULATION_RULE,
    `- This is a one-shot repair. Provide your best complete classification.`,
    ``,
    `EXACT OUTPUT SHAPE:`,
    `- No meaningful difference: { "classified": false }`,
    `- Classifiable difference: { "classified": true, "criterion": "${ctx.originalCriterion}", "severity": "medium", "label": "short visible label", "evidence": ["visible qualitative observation"] }`,
    `- Use an array of strings for evidence. Return no coordinate or bounding-box fields.`,
    ``,
    `Respond with JSON only matching that exact shape and the provided schema. No prose before or after the JSON.`
  ].join("\n");
}

export interface RecoveryReviewerContext {
  originalCandidateTitle?: string;
  originalCandidateEvidence?: string[];
  diagnosticCode?: string;
  diagnosticMessage?: string;
  repairedCandidateTitle?: string;
  repairedCandidateEvidence?: string[];
}

export function buildRecoveryReviewerPrompt(
  criterion: UiCriterion,
  elementLabel: string,
  auditorTitle: string,
  evidence: string[],
  measurements: DeterministicMeasurement[] = [],
  repairContext?: RecoveryReviewerContext
): string {
  const evidenceLines = evidence.map(e => `  - ${e}`).join("\n");
  const measurementLines = measurements.length > 0
    ? measurements.map(m => `  - ${m.name}: ${m.value}${m.unit ? " " + m.unit : ""}`).join("\n")
    : "  (none)";

  const hasRepair = repairContext?.originalCandidateTitle !== undefined;
  const repairSections: string[] = [];
  if (hasRepair) {
    const origEvidenceLines = (repairContext!.originalCandidateEvidence ?? []).map(e => `  - ${e}`).join("\n");
    const repairedEvidenceLines = (repairContext!.repairedCandidateEvidence ?? []).map(e => `  - ${e}`).join("\n");
    repairSections.push(
      ``,
      `ORIGINAL CANDIDATE (before repair):`,
      `  Title: ${repairContext!.originalCandidateTitle}`,
      `  Evidence:`,
      origEvidenceLines || "  (none)",
      ``,
      `VALIDATION DIAGNOSTIC:`,
      `  Code: ${repairContext!.diagnosticCode ?? "unknown"}`,
      `  Message: ${repairContext!.diagnosticMessage ?? "unknown"}`,
      ``,
      `REPAIRED CANDIDATE (after repair — this is what you are reviewing):`,
      `  Title: ${repairContext!.repairedCandidateTitle}`,
      `  Evidence:`,
      repairedEvidenceLines || "  (none)",
    );
  }

  return [
    `You are a UI diff recovery reviewer. Evaluate whether the reported diff is valid based solely on the supplied recovery evidence.`,
    ``,
    `ELEMENT: "${elementLabel}"`,
    `CRITERION: ${criterion}`,
    `REPORTED TITLE: ${auditorTitle}`,
    ...repairSections,
    ``,
    `EVIDENCE:`,
    evidenceLines,
    `DETERMINISTIC MEASUREMENTS:`,
    measurementLines,
    ``,
    `EVIDENCE IMAGES (exactly 4 images, in order):`,
    `  1. EXPECTED crop — context-expanded evidence: expected image cropped to a region around the changed pixels; the crop may include surrounding UI context around the authoritative changed pixels`,
    `  2. ACTUAL comparison crop — actual source crop resized with Lanczos to the expected crop dimensions`,
    `  3. Directional diff overlay — diagnostic annotation ink: cyan where expected differs, magenta where actual differs, yellow at region outlines. These colors are overlay annotations, not UI colors. The overlay localizes authoritative changed pixels within the context-expanded evidence.`,
    `  4. Pixel-diff mask — white pixels mark changed regions within the context-expanded evidence. The mask localizes the authoritative changed pixels.`,
    ``,
    `STRICT RULES:`,
    `- Accept the diff ONLY if the evidence is visually verifiable in the four supplied images.`,
    `- Reject the diff if the evidence is vague, unverifiable, or contradicted by the images.`,
    `- Mark needs_escalation if the images are ambiguous or the diff requires deeper analysis.`,
    `- Do NOT explain causality. Do NOT suggest code changes. Do NOT judge correctness.`,
    NO_SPECULATION_RULE,
    NAMED_MEASUREMENT_RULE,
    `- Appearance/content claims must come from source crops 1 and 2 only.`,
    `- The context-expanded crops show surrounding context; do not claim the entire context differs. Only the pixels localized by the overlay/mask are known to differ.`,
    `- The overlay and mask localize authoritative changed pixels; the context crop shows surrounding context only.`,
    `- Overlay and mask images localize differences only; do not treat overlay annotation colors (cyan, magenta, yellow) as actual UI colors.`,
    `- Reject unsupported quantitative layout claims. Exact dimensions, positions, spacing, font sizes, percentages, and angles are valid only when they cite a deterministic measurement listed above.`,
    ...(hasRepair ? [
      `- When reviewing a repaired candidate, compare the ORIGINAL candidate against the REPAIRED candidate. If the repair describes a different visual observation than the original (semantic substitution), reject it.`
    ] : []),
    ``,
    `Respond with JSON only: { "decision": "accepted" | "rejected" | "needs_escalation", "reason": "<one sentence>" }`
  ].join("\n");
}
