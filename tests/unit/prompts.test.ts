import { describe, expect, it } from "vitest";
import { buildAuditorPrompt, buildRecoveryPrompt, buildRecoveryRepairPrompt, buildRecoveryReviewerPrompt, buildReviewerPrompt, sanitizeRepairPromptInput } from "../../src/audit/prompts.js";
import type { RepairPromptContext } from "../../src/audit/prompts.js";
import { rubrics } from "../../src/audit/criteria.js";

describe("quantitative evidence prompt discipline", () => {
  it("forbids model-authored layout measurements", () => {
    const prompt = buildAuditorPrompt({
      criterion: "geometry",
      rubric: rubrics.geometry,
      elementLabel: "Header",
      elementType: "text",
      pairingStatus: "matched",
      measurements: []
    });

    expect(prompt).not.toContain("actual y=45px");
    expect(prompt).toContain("Do not invent pixel, spacing, font-size, percentage, or angle measurements");
  });

  it("requires the reviewer to reject unsupported quantitative claims", () => {
    const prompt = buildReviewerPrompt("geometry", "Header", "Header shifted by 3px", ["shifted left"], []);
    expect(prompt).toContain("Reject unsupported quantitative layout claims");
  });

  it("describes recovery image 2 as the Lanczos-resized actual comparison crop", () => {
    const prompt = buildRecoveryPrompt(200, 500);
    expect(prompt).toContain("2. ACTUAL comparison crop");
    expect(prompt).toContain("resized with Lanczos to the expected crop dimensions");
    expect(prompt).not.toContain("2. ACTUAL crop — actual screenshot cropped to the changed region");
  });

  it("requires named deterministic measurements for exact color values in both recovery prompts", () => {
    const prompts = [
      buildRecoveryPrompt(200, 500),
      buildRecoveryReviewerPrompt("color_appearance", "Panel", "Panel color differs", ["fill differs"], [])
    ];
    for (const prompt of prompts) {
      expect(prompt).toContain("color values (hex/RGB)");
      expect(prompt).toContain("only when citing a listed deterministic measurement by name");
    }
  });

  it("puts causality, design-intent, and named-measurement constraints in every prompt", () => {
    const prompts = [
      buildRecoveryPrompt(200, 500),
      buildAuditorPrompt({
        criterion: "geometry",
        rubric: rubrics.geometry,
        elementLabel: "Header",
        elementType: "text",
        pairingStatus: "matched",
        measurements: []
      }),
      buildReviewerPrompt("geometry", "Header", "Header shifted", ["shifted"], [])
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain("Do NOT speculate about causality or design intent");
      expect(prompt).toContain("Exact percentages, pixels, sizes, angles, coordinates, and color values (hex/RGB) are allowed only when citing a listed deterministic measurement by name");
    }
  });

  it("requires the reviewer to reject violations of the evidence rules", () => {
    const prompt = buildReviewerPrompt("geometry", "Header", "Header shifted", ["shifted"], []);
    expect(prompt).toContain("Reject any title or evidence that violates these rules");
  });

  it("builds a recovery reviewer prompt for exactly four recovery images", () => {
    const prompt = buildRecoveryReviewerPrompt("geometry", "Header", "Header shifted", ["shifted"], []);
    expect(prompt).toContain("exactly 4 images");
    expect(prompt).toContain("1. EXPECTED crop");
    expect(prompt).toContain("2. ACTUAL comparison crop");
    expect(prompt).toContain("3. Directional diff overlay");
    expect(prompt).toContain("4. Pixel-diff mask");
    expect(prompt).not.toContain("Context crop");
    expect(prompt).not.toContain("5.");
  });
});

describe("prompt builder context-expanded truthfulness", () => {
  const recoveryPrompt = buildRecoveryPrompt(200, 500);
  const repairPrompt = buildRecoveryRepairPrompt({
    originalCriterion: "geometry",
    originalLabel: "Header",
    originalTitle: "Header shifted",
    originalEvidence: ["shifted left"],
    diagnosticCode: "unsupported_quantitative",
    diagnosticMessage: "unsupported exact claim",
    measurements: []
  });
  const reviewerPrompt = buildRecoveryReviewerPrompt("geometry", "Header", "Header shifted", ["shifted"], []);
  const auditorReviewerPrompt = buildReviewerPrompt("geometry", "Header", "Header shifted", ["shifted"], []);

  it("recovery prompt describes context-expanded crop truthfully", () => {
    expect(recoveryPrompt).toContain("context-expanded evidence");
    expect(recoveryPrompt).toContain("the crop may include surrounding UI context around the authoritative changed pixels");
    expect(recoveryPrompt).not.toContain("larger than the changed area itself");
  });

  it("repair prompt describes context-expanded crop truthfully", () => {
    expect(repairPrompt).toContain("context-expanded evidence");
    expect(repairPrompt).toContain("the crop may include surrounding UI context around the authoritative changed pixels");
    expect(repairPrompt).not.toContain("larger than the changed area itself");
  });

  it("recovery reviewer prompt describes context-expanded crop truthfully", () => {
    expect(reviewerPrompt).toContain("context-expanded evidence");
    expect(reviewerPrompt).toContain("the crop may include surrounding UI context around the authoritative changed pixels");
    expect(reviewerPrompt).not.toContain("larger than the changed area itself");
  });

  it("recovery prompt says overlay and mask localize authoritative changed pixels", () => {
    expect(recoveryPrompt).toContain("The overlay localizes authoritative changed pixels within the context-expanded evidence");
    expect(recoveryPrompt).toContain("The mask localizes the authoritative changed pixels");
  });

  it("repair prompt says overlay and mask localize authoritative changed pixels", () => {
    expect(repairPrompt).toContain("The overlay localizes authoritative changed pixels within the context-expanded evidence");
    expect(repairPrompt).toContain("The mask localizes the authoritative changed pixels");
  });

  it("recovery reviewer prompt says overlay and mask localize authoritative changed pixels", () => {
    expect(reviewerPrompt).toContain("The overlay localizes authoritative changed pixels within the context-expanded evidence");
    expect(reviewerPrompt).toContain("The mask localizes the authoritative changed pixels");
  });

  it("auditor reviewer prompt says overlay and mask localize authoritative changed pixels", () => {
    expect(auditorReviewerPrompt).toContain("The overlay and mask localize authoritative changed pixels");
  });

  it("recovery prompt warns not to claim the entire context differs", () => {
    expect(recoveryPrompt).toContain("do not claim the entire context differs");
  });

  it("repair prompt warns not to claim the entire context differs", () => {
    expect(repairPrompt).toContain("do not claim the entire context differs");
  });

  it("recovery reviewer prompt warns not to claim the entire context differs", () => {
    expect(reviewerPrompt).toContain("do not claim the entire context differs");
  });

  it("auditor reviewer prompt warns not to claim the entire crop differs", () => {
    expect(auditorReviewerPrompt).toContain("do not claim the entire crop differs");
  });
});

describe("sanitizeRepairPromptInput: direct unit tests", () => {
  const unsupportedCodes = [
    "unsupported_exact_color",
    "unsupported_quantitative",
    "unsupported_absence",
    "unsupported_crop_boundary"
  ] as const;

  for (const code of unsupportedCodes) {
    it(`${code}: empties title, evidence, omit excerpt, uses fixed remediation message`, () => {
      const result = sanitizeRepairPromptInput({
        originalCriterion: "geometry",
        originalLabel: "Button",
        originalTitle: "Button shifted by 3px exactly",
        originalEvidence: ["button width is 120px", "height is 45px"],
        diagnosticCode: code,
        diagnosticMessage: "Some user text with #FF0000 and 120px and rgb(1,2,3)",
        diagnosticExcerpt: "#FF0000",
        measurements: []
      });
      expect(result.originalTitle).toBe("");
      expect(result.originalEvidence).toEqual([]);
      expect(result.diagnosticExcerpt).toBeUndefined();
      expect(result.diagnosticCode).toBe(code);
      expect(result.originalCriterion).toBe("geometry");
    });
  }

  it("unsupported_exact_color uses qualitative color remediation message", () => {
    const result = sanitizeRepairPromptInput({
      originalCriterion: "color_appearance",
      originalLabel: "Panel",
      originalTitle: "Panel fill #FF0000 wrong",
      originalEvidence: ["panel is #FF0000"],
      diagnosticCode: "unsupported_exact_color",
      diagnosticMessage: "Unsupported exact hex color claim: #FF0000",
      measurements: []
    });
    expect(result.diagnosticMessage).toContain("qualitative color wording");
    expect(result.diagnosticMessage).not.toContain("#FF0000");
  });

  it("unsupported_quantitative uses qualitative wording remediation message", () => {
    const result = sanitizeRepairPromptInput({
      originalCriterion: "geometry",
      originalLabel: "Button",
      originalTitle: "Button shifted by 3px exactly",
      originalEvidence: ["button width is 120px"],
      diagnosticCode: "unsupported_quantitative",
      diagnosticMessage: "Unsupported quantitative claim",
      measurements: []
    });
    expect(result.diagnosticMessage).toContain("qualitative wording");
    expect(result.diagnosticMessage).toContain("named deterministic measurement");
  });

  it("unsupported_absence uses visible-content-only remediation message", () => {
    const result = sanitizeRepairPromptInput({
      originalCriterion: "presence",
      originalLabel: "Card",
      originalTitle: "Card is missing",
      originalEvidence: ["The actual screenshot is entirely blank."],
      diagnosticCode: "unsupported_absence",
      diagnosticMessage: "Unsupported global absence claim",
      measurements: []
    });
    expect(result.diagnosticMessage).toContain("visible content in supplied crops");
    expect(result.diagnosticMessage).toContain("no global absence inference");
  });

  it("unsupported_crop_boundary uses visually-supported-only remediation message", () => {
    const result = sanitizeRepairPromptInput({
      originalCriterion: "presence",
      originalLabel: "Element",
      originalTitle: "Element cut off at crop boundary",
      originalEvidence: ["element is cut off at the edge of the crop"],
      diagnosticCode: "unsupported_crop_boundary",
      diagnosticMessage: "Unsupported crop-boundary claim",
      measurements: []
    });
    expect(result.diagnosticMessage).toContain("crop/position mismatch only when visually supported");
  });

  it("label sanitized of hex tokens: label-only hex falls back to Changed region", () => {
    const result = sanitizeRepairPromptInput({
      originalCriterion: "color_appearance",
      originalLabel: "#FF0000",
      originalTitle: "color mismatch",
      originalEvidence: ["color is wrong"],
      diagnosticCode: "unsupported_exact_color",
      diagnosticMessage: "bad claim",
      measurements: []
    });
    expect(result.originalLabel).toBe("Changed region");
  });

  it("label sanitized of RGB tokens: pure RGB label falls back to Changed region", () => {
    const result = sanitizeRepairPromptInput({
      originalCriterion: "color_appearance",
      originalLabel: "rgb(255,0,0)",
      originalTitle: "color mismatch",
      originalEvidence: ["color is wrong"],
      diagnosticCode: "unsupported_exact_color",
      diagnosticMessage: "bad claim",
      measurements: []
    });
    expect(result.originalLabel).toBe("Changed region");
  });

  it("label sanitized of exact-pixel tokens: 120px label falls back to Changed region", () => {
    const result = sanitizeRepairPromptInput({
      originalCriterion: "geometry",
      originalLabel: "120px",
      originalTitle: "width mismatch",
      originalEvidence: ["width is wrong"],
      diagnosticCode: "unsupported_quantitative",
      diagnosticMessage: "bad claim",
      measurements: []
    });
    expect(result.originalLabel).toBe("Changed region");
  });

  it("label keeps non-numeric prefix after stripping hex/pixel tokens", () => {
    const result = sanitizeRepairPromptInput({
      originalCriterion: "color_appearance",
      originalLabel: "Header #1A2B3C background",
      originalTitle: "color mismatch",
      originalEvidence: ["color is wrong"],
      diagnosticCode: "unsupported_exact_color",
      diagnosticMessage: "bad claim",
      measurements: []
    });
    expect(result.originalLabel).toBe("Header background");
    expect(result.originalLabel).not.toContain("#1A2B3C");
  });

  it("non-unsupported diagnostic preserves original title, evidence, and excerpt", () => {
    const result = sanitizeRepairPromptInput({
      originalCriterion: "geometry",
      originalLabel: "Button",
      originalTitle: "Button shifted by 3px exactly",
      originalEvidence: ["button width is 120px", "height is 45px"],
      diagnosticCode: "schema_format_error",
      diagnosticMessage: "Invalid JSON response",
      diagnosticExcerpt: "shifted by 3px",
      measurements: []
    });
    expect(result.originalTitle).toBe("Button shifted by 3px exactly");
    expect(result.originalEvidence).toEqual(["button width is 120px", "height is 45px"]);
    expect(result.diagnosticExcerpt).toBe("shifted by 3px");
    expect(result.diagnosticMessage).toBe("Invalid JSON response");
    expect(result.originalLabel).toBe("Button");
  });

  it("non-unsupported diagnostic with no excerpt omits diagnosticExcerpt", () => {
    const result = sanitizeRepairPromptInput({
      originalCriterion: "geometry",
      originalLabel: "Button",
      originalTitle: "Button shifted",
      originalEvidence: ["shifted left"],
      diagnosticCode: "schema_format_error",
      diagnosticMessage: "Invalid JSON",
      measurements: []
    });
    expect(result.diagnosticExcerpt).toBeUndefined();
  });
});

describe("repair prompt decontamination for unsupported diagnostics", () => {
  it("unsupported_exact_color: repair prompt must NOT contain hex colors, original title, or evidence", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "color_appearance",
      originalLabel: "Header background",
      originalTitle: "Header background is #1A2B3C",
      originalEvidence: ["background color is #1A2B3C", "fill is #445566"],
      diagnosticCode: "unsupported_exact_color",
      diagnosticMessage: "Unsupported exact hex color claim",
      diagnosticExcerpt: "#1A2B3C",
      measurements: [{ name: "changed_pixel_count", value: 500, unit: "pixels" }]
    });
    expect(prompt).not.toContain("#1A2B3C");
    expect(prompt).not.toContain("#445566");
    expect(prompt).not.toContain("Header background is #1A2B3C");
    expect(prompt).not.toContain("background color is #1A2B3C");
    expect(prompt).not.toContain("fill is #445566");
    expect(prompt).toContain("color_appearance");
    expect(prompt).toContain("unsupported_exact_color");
    expect(prompt).toContain("changed_pixel_count");
  });

  it("unsupported_exact_color: repair prompt must NOT contain the offending excerpt", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "color_appearance",
      originalLabel: "Button",
      originalTitle: "Button color mismatch",
      originalEvidence: ["button is #FF0000"],
      diagnosticCode: "unsupported_exact_color",
      diagnosticMessage: "Unsupported exact hex color claim",
      diagnosticExcerpt: "#FF0000",
      measurements: []
    });
    expect(prompt).not.toContain("#FF0000");
    expect(prompt).toContain("unsupported_exact_color");
  });

  it("unsupported_quantitative: repair prompt must NOT contain exact pixel claims or original evidence", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "geometry",
      originalLabel: "Button",
      originalTitle: "Button shifted by 3px exactly",
      originalEvidence: ["button width is 120px", "height is 45px"],
      diagnosticCode: "unsupported_quantitative",
      diagnosticMessage: "Unsupported quantitative claim",
      diagnosticExcerpt: "120px",
      measurements: [{ name: "changed_pixel_count", value: 300, unit: "pixels" }]
    });
    expect(prompt).not.toContain("120px");
    expect(prompt).not.toContain("45px");
    expect(prompt).not.toContain("Button shifted by 3px exactly");
    expect(prompt).not.toContain("button width is 120px");
    expect(prompt).toContain("geometry");
    expect(prompt).toContain("unsupported_quantitative");
    expect(prompt).toContain("changed_pixel_count");
  });

  it("unsupported_absence: repair prompt must NOT contain the original absence claim", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "presence",
      originalLabel: "Card",
      originalTitle: "Card is missing",
      originalEvidence: ["The actual screenshot is entirely blank."],
      diagnosticCode: "unsupported_absence",
      diagnosticMessage: "Unsupported global absence claim",
      diagnosticExcerpt: "entirely blank",
      measurements: []
    });
    expect(prompt).not.toContain("entirely blank");
    expect(prompt).not.toContain("The actual screenshot is entirely blank.");
    expect(prompt).toContain("presence");
    expect(prompt).toContain("unsupported_absence");
  });

  it("unsupported_crop_boundary: repair prompt must NOT contain the original crop claim", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "presence",
      originalLabel: "Element",
      originalTitle: "Element cut off at crop boundary",
      originalEvidence: ["element is cut off at the edge of the crop"],
      diagnosticCode: "unsupported_crop_boundary",
      diagnosticMessage: "Unsupported crop-boundary claim",
      diagnosticExcerpt: "cut off at the edge",
      measurements: []
    });
    expect(prompt).not.toContain("cut off at the edge");
    expect(prompt).not.toContain("Element cut off at crop boundary");
    expect(prompt).toContain("presence");
    expect(prompt).toContain("unsupported_crop_boundary");
  });

  it("repair prompt preserves criterion, diagnostic code, and measurements for all unsupported types", () => {
    const types = [
      { code: "unsupported_exact_color", criterion: "color_appearance" as const },
      { code: "unsupported_quantitative", criterion: "geometry" as const },
      { code: "unsupported_absence", criterion: "presence" as const },
      { code: "unsupported_crop_boundary", criterion: "presence" as const }
    ];
    for (const t of types) {
      const prompt = buildRecoveryRepairPrompt({
        originalCriterion: t.criterion,
        originalLabel: "Test",
        originalTitle: "Test title",
        originalEvidence: ["test evidence"],
        diagnosticCode: t.code,
        diagnosticMessage: "test message",
        measurements: [{ name: "changed_pixel_count", value: 100, unit: "pixels" }]
      });
      expect(prompt).toContain(t.criterion);
      expect(prompt).toContain(t.code);
      expect(prompt).toContain("changed_pixel_count");
    }
  });

  it("repair prompt for unsupported diagnostics includes neutral label without original offending context", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "color_appearance",
      originalLabel: "Header background",
      originalTitle: "Header background is #1A2B3C",
      originalEvidence: ["background is #1A2B3C"],
      diagnosticCode: "unsupported_exact_color",
      diagnosticMessage: "Unsupported exact hex color claim",
      measurements: []
    });
    expect(prompt).toContain("Label: Header background");
    expect(prompt).not.toContain("#1A2B3C");
  });

  it("sanitized diagnostic message must not embed the offending hex/RGB claim", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "color_appearance",
      originalLabel: "Panel",
      originalTitle: "Panel fill #FF0000 wrong",
      originalEvidence: ["panel is #FF0000"],
      diagnosticCode: "unsupported_exact_color",
      diagnosticMessage: "Unsupported exact hex color claim: #FF0000",
      diagnosticExcerpt: "#FF0000",
      measurements: []
    });
    expect(prompt).not.toContain("#FF0000");
    expect(prompt).toContain("unsupported_exact_color");
  });

  it("unsupported_exact_color: full original title sentence does not leak any distinctive claim phrase", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "color_appearance",
      originalLabel: "Button",
      originalTitle: "Button color is exactly #AABBCC",
      originalEvidence: ["Button has color #AABBCC exactly"],
      diagnosticCode: "unsupported_exact_color",
      diagnosticMessage: "Unsupported exact color claim: Button color is exactly #AABBCC",
      diagnosticExcerpt: "#AABBCC",
      measurements: []
    });
    expect(prompt).not.toContain("#AABBCC");
    expect(prompt).not.toContain("exactly #AABBCC");
    expect(prompt).not.toContain("color is exactly");
    expect(prompt).toContain("unsupported_exact_color");
  });

  it("unsupported_quantitative: full original title sentence does not leak any distinctive claim phrase", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "geometry",
      originalLabel: "Button",
      originalTitle: "Button shifted by 3px exactly",
      originalEvidence: ["Button shifted by 3px exactly", "button width is 120px"],
      diagnosticCode: "unsupported_quantitative",
      diagnosticMessage: "Unsupported quantitative claim: Button shifted by 3px exactly",
      diagnosticExcerpt: "120px",
      measurements: []
    });
    expect(prompt).not.toContain("shifted by 3px");
    expect(prompt).not.toContain("120px");
    expect(prompt).not.toContain("Button shifted by 3px exactly");
    expect(prompt).toContain("unsupported_quantitative");
  });

  it("unsupported_absence: full original title does not leak absence claim", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "presence",
      originalLabel: "Card",
      originalTitle: "Card is entirely missing from the page",
      originalEvidence: ["The actual screenshot is entirely blank and empty"],
      diagnosticCode: "unsupported_absence",
      diagnosticMessage: "Unsupported global absence claim: Card is entirely missing from the page",
      diagnosticExcerpt: "entirely blank",
      measurements: []
    });
    expect(prompt).not.toContain("entirely missing");
    expect(prompt).not.toContain("entirely blank");
    expect(prompt).not.toContain("entirely empty");
    expect(prompt).toContain("unsupported_absence");
  });

  it("unsupported_crop_boundary: full original title does not leak crop claim", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "presence",
      originalLabel: "Element",
      originalTitle: "Element cut off at crop boundary",
      originalEvidence: ["element is cut off at the edge of the crop region"],
      diagnosticCode: "unsupported_crop_boundary",
      diagnosticMessage: "Unsupported crop-boundary claim: Element cut off at crop boundary",
      diagnosticExcerpt: "cut off at the edge",
      measurements: []
    });
    expect(prompt).not.toContain("cut off at");
    expect(prompt).not.toContain("crop boundary");
    expect(prompt).toContain("unsupported_crop_boundary");
  });

  it("uppercase PX/RGB hex variants cannot leak through label sanitation", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "color_appearance",
      originalLabel: "Button #FF0000 BG",
      originalTitle: "Button BG color mismatch",
      originalEvidence: ["background is #FF0000"],
      diagnosticCode: "unsupported_exact_color",
      diagnosticMessage: "Unsupported exact hex color claim",
      diagnosticExcerpt: "#FF0000",
      measurements: []
    });
    expect(prompt).not.toContain("#FF0000");
    expect(prompt).toContain("Label: Button BG");
  });

  it("uppercase PX variant cannot leak through label sanitation", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "geometry",
      originalLabel: "Button 120PX wide",
      originalTitle: "Button width mismatch",
      originalEvidence: ["button is 120px wide"],
      diagnosticCode: "unsupported_quantitative",
      diagnosticMessage: "Unsupported quantitative claim",
      diagnosticExcerpt: "120px",
      measurements: []
    });
    expect(prompt).not.toContain("120px");
    expect(prompt).not.toContain("120PX");
    expect(prompt).toContain("Label: Button wide");
  });

  it("unsupported_exact_color: diagnostic message uses fixed qualitative wording", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "color_appearance",
      originalLabel: "Panel",
      originalTitle: "Panel fill wrong",
      originalEvidence: ["fill differs"],
      diagnosticCode: "unsupported_exact_color",
      diagnosticMessage: "Unsupported exact hex color claim",
      measurements: []
    });
    expect(prompt).toContain("qualitative color wording");
    expect(prompt).toContain("named deterministic source-color measurement");
  });

  it("unsupported_quantitative: diagnostic message uses fixed qualitative wording", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "geometry",
      originalLabel: "Button",
      originalTitle: "Button shifted",
      originalEvidence: ["shifted left"],
      diagnosticCode: "unsupported_quantitative",
      diagnosticMessage: "Unsupported quantitative claim",
      measurements: []
    });
    expect(prompt).toContain("qualitative wording");
    expect(prompt).toContain("named deterministic measurement supports the quantity");
  });

  it("unsupported_absence: diagnostic message describes visible-content-only rule", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "presence",
      originalLabel: "Card",
      originalTitle: "Card missing",
      originalEvidence: ["not visible"],
      diagnosticCode: "unsupported_absence",
      diagnosticMessage: "Unsupported global absence claim",
      measurements: []
    });
    expect(prompt).toContain("visible content in supplied crops");
    expect(prompt).toContain("no global absence inference");
  });

  it("unsupported_crop_boundary: diagnostic message describes visually-supported-only rule", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "presence",
      originalLabel: "Element",
      originalTitle: "Element cropped",
      originalEvidence: ["cropped"],
      diagnosticCode: "unsupported_crop_boundary",
      diagnosticMessage: "Unsupported crop-boundary claim",
      measurements: []
    });
    expect(prompt).toContain("crop/position mismatch only when visually supported");
  });

  it("non-unsupported diagnostic preserves original title, evidence, and excerpt in prompt", () => {
    const prompt = buildRecoveryRepairPrompt({
      originalCriterion: "geometry",
      originalLabel: "Button",
      originalTitle: "Button shifted by 3px exactly",
      originalEvidence: ["button width is 120px", "height is 45px"],
      diagnosticCode: "schema_format_error",
      diagnosticMessage: "Invalid JSON response",
      diagnosticExcerpt: "shifted by 3px",
      measurements: []
    });
    expect(prompt).toContain("Title: Button shifted by 3px exactly");
    expect(prompt).toContain("button width is 120px");
    expect(prompt).toContain("height is 45px");
    expect(prompt).toContain("Invalid JSON response");
    expect(prompt).toContain("schema_format_error");
    expect(prompt).toContain('Offending excerpt: "shifted by 3px"');
  });
});

describe("recovery reviewer prompt continuity rules for repaired candidates", () => {
  it("reviewer prompt states that removing unsupported specificity is expected repair behavior", () => {
    const prompt = buildRecoveryReviewerPrompt(
      "color_appearance",
      "Header",
      "Header background color changed",
      ["background color differs from expected"],
      [],
      {
        originalCandidateTitle: "Header background is #1A2B3C",
        originalCandidateEvidence: ["background color is #1A2B3C"],
        diagnosticCode: "unsupported_exact_color",
        diagnosticMessage: "Unsupported exact hex color claim",
        repairedCandidateTitle: "Header background color changed",
        repairedCandidateEvidence: ["background color differs from expected"]
      }
    );
    expect(prompt).toContain("ORIGINAL CANDIDATE");
    expect(prompt).toContain("REPAIRED CANDIDATE");
    expect(prompt).toContain("unsupported specificity");
    expect(prompt).toContain("qualitative wording");
  });

  it("reviewer prompt states that renaming equivalent labels is expected when criterion and observation are the same", () => {
    const prompt = buildRecoveryReviewerPrompt(
      "color_appearance",
      "Header",
      "Header gradient vs flat",
      ["gradient changed to flat fill"],
      [],
      {
        originalCandidateTitle: "Header gradient vs flat color",
        originalCandidateEvidence: ["gradient changed to flat fill"],
        diagnosticCode: "unsupported_exact_color",
        diagnosticMessage: "Unsupported exact color claim",
        repairedCandidateTitle: "Header fill appearance changed",
        repairedCandidateEvidence: ["gradient appearance changed to flat"]
      }
    );
    expect(prompt).toContain("equivalent label");
    expect(prompt).toContain("criterion and core qualitative");
  });

  it("reviewer prompt still rejects true semantic substitution (e.g. gradient-vs-flat to missing icon)", () => {
    const prompt = buildRecoveryReviewerPrompt(
      "color_appearance",
      "Header",
      "Header gradient vs flat",
      ["gradient changed to flat fill"],
      [],
      {
        originalCandidateTitle: "Header gradient vs flat color",
        originalCandidateEvidence: ["gradient changed to flat fill"],
        diagnosticCode: "unsupported_exact_color",
        diagnosticMessage: "Unsupported exact color claim",
        repairedCandidateTitle: "Header icon is missing",
        repairedCandidateEvidence: ["icon element not present in actual"]
      }
    );
    expect(prompt).toContain("different visual observation");
    expect(prompt).toContain("reject");
  });

  it("reviewer prompt does not include continuity rules when there is no repair context", () => {
    const prompt = buildRecoveryReviewerPrompt(
      "geometry",
      "Button",
      "Button shifted",
      ["shifted left"],
      []
    );
    expect(prompt).not.toContain("unsupported specificity");
    expect(prompt).not.toContain("equivalent label");
    expect(prompt).not.toContain("ORIGINAL CANDIDATE");
  });
});
