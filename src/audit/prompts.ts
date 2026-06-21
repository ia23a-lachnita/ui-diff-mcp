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

export function buildRecoveryPrompt(pixelCount: number, componentArea: number): string {
  const criteriaList = CLASSIFIABLE_CRITERIA.join(" | ");
  return [
    `You are a UI diff recovery specialist. A visual difference region was detected by pixel analysis but was not matched to any located UI element.`,
    ``,
    `REGION STATS:`,
    `  - Changed pixels: ${pixelCount}`,
    `  - Component area: ${componentArea}px²`,
    ``,
    `EVIDENCE IMAGES (in order):`,
    `  1. EXPECTED crop — expected image cropped to the changed region`,
    `  2. ACTUAL crop — actual screenshot cropped to the changed region`,
    `  3. Directional diff overlay — cyan where expected differs, magenta where actual differs, yellow at region outlines`,
    `  4. Pixel-diff mask — white pixels mark changed regions`,
    ``,
    `TASK:`,
    `Examine the images and determine whether this region contains a classifiable UI difference.`,
    `If yes, provide: criterion, severity, a short descriptive label, coordinate frame, bounding box, and evidence.`,
    `If the region cannot be classified as a meaningful UI diff (e.g., rendering noise, compression artifact), set classified to false.`,
    ``,
    `COORDINATE FRAME:`,
    `- Use "expected" if your box is in the expected image coordinate space.`,
    `- Use "actual" if in the actual screenshot coordinate space.`,
    `- Use "normalized" if you use 0..1 fractions of image dimensions.`,
    ``,
    `VALID CRITERIA: ${criteriaList}`,
    ``,
    `STRICT RULES:`,
    `- Report ONLY observable visual differences visible in the images.`,
    `- Do NOT suggest code fixes or root causes.`,
    `- Do NOT fabricate coordinates — use the region shown.`,
    `- Evidence must be specific (e.g., "background color changed from dark to light").`,
    ``,
    `Respond with JSON only matching the schema provided. No prose before or after the JSON.`
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
    `- Evidence must be visually specific but qualitative unless it cites a deterministic measurement listed above by name.`,
    `- Do not invent pixel, spacing, font-size, percentage, or angle measurements.`,
    ``,
    `Evidence discipline:`,
    `- Describe only visible differences supported by the supplied crops, overlay, mask, and measurements.`,
    `- If a crop appears clipped or only partially contains the expected target, say "crop/position mismatch" instead of claiming hidden content.`,
    `- Do not infer implementation cause, app code cause, or config cause.`,
    `- Do not recommend fixes.`,
    `- If the evidence is only a projected-location mismatch, classify it as presence/geometry only when visible evidence supports that label.`,
    ``,
    `Respond with JSON only matching the schema provided. No prose before or after the JSON.`
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
    `- Reject the diff if its title or evidence claims content that is not visible in the supplied images.`,
    `- Accept crop-boundary evidence only when the record explicitly calls it a crop/position mismatch.`,
    `- Reject unsupported quantitative layout claims. Exact dimensions, positions, spacing, font sizes, percentages, and angles are valid only when they cite a deterministic measurement listed above.`,
    ``,
    `Respond with JSON only: { "decision": "accepted" | "rejected" | "needs_escalation", "reason": "<one sentence>" }`
  ].join("\n");
}
