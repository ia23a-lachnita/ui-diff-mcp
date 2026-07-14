import { describe, expect, it } from "vitest";
import { buildAuditorPrompt, buildRecoveryPrompt, buildRecoveryReviewerPrompt, buildReviewerPrompt } from "../../src/audit/prompts.js";
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
