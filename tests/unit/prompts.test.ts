import { describe, expect, it } from "vitest";
import { buildAuditorPrompt, buildRecoveryPrompt, buildReviewerPrompt } from "../../src/audit/prompts.js";
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
      expect(prompt).toContain("Exact percentages, pixels, sizes, angles, and coordinates are allowed only when citing a listed deterministic measurement by name");
    }
  });

  it("requires the reviewer to reject violations of the evidence rules", () => {
    const prompt = buildReviewerPrompt("geometry", "Header", "Header shifted", ["shifted"], []);
    expect(prompt).toContain("Reject any title or evidence that violates these rules");
  });
});
