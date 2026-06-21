import { describe, expect, it } from "vitest";
import { buildAuditorPrompt, buildReviewerPrompt } from "../../src/audit/prompts.js";
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
});
