import { describe, expect, it } from "vitest";
import { deduplicateDiffs, filterAcceptedDiffs, hasUnsupportedQuantitativeClaim, requiredAcceptedArtifactRoles, reviewAndMergeFindings, validateClaim } from "../../src/audit/review-findings.js";
import type { DiffRecord } from "../../src/schemas/core.js";

function makeDiff(overrides: Partial<DiffRecord> = {}): DiffRecord {
  return {
    id: "diff-1",
    pairId: "pair-1",
    criterion: "geometry",
    severity: "low",
    title: "test diff",
    reviewerStatus: "accepted",
    location: { x: 10, y: 20, width: 100, height: 50 },
    evidence: ["some evidence"],
    measurements: [],
    artifactPaths: [],
    ...overrides
  };
}

describe("deduplicateDiffs", () => {
  it("keeps first occurrence when same key appears", () => {
    const a = makeDiff({ id: "a", severity: "low" });
    const b = makeDiff({ id: "b", severity: "low" });
    const result = deduplicateDiffs([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("a");
  });

  it("upgrades to higher severity when duplicate key has higher severity", () => {
    const a = makeDiff({ id: "a", severity: "low" });
    const b = makeDiff({ id: "b", severity: "high" });
    const result = deduplicateDiffs([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("high");
  });

  it("keeps unique diffs with different keys", () => {
    const a = makeDiff({ id: "a", location: { x: 10, y: 20, width: 100, height: 50 } });
    const b = makeDiff({ id: "b", location: { x: 99, y: 99, width: 10, height: 10 } });
    expect(deduplicateDiffs([a, b])).toHaveLength(2);
  });
});

describe("filterAcceptedDiffs", () => {
  it("removes rejected diffs", () => {
    const accepted = makeDiff({ id: "a", reviewerStatus: "accepted" });
    const rejected = makeDiff({ id: "b", reviewerStatus: "rejected" });
    expect(filterAcceptedDiffs([accepted, rejected])).toEqual([accepted]);
  });

  it("removes needs_escalation diffs from final findings", () => {
    const accepted = makeDiff({ id: "a", reviewerStatus: "accepted" });
    const escalated = makeDiff({ id: "b", reviewerStatus: "needs_escalation" });
    expect(filterAcceptedDiffs([accepted, escalated])).toEqual([accepted]);
  });

  it("keeps deterministic not_reviewed findings as final evidence", () => {
    const deterministic = makeDiff({
      id: "det",
      reviewerStatus: "not_reviewed",
      classificationSource: "deterministic_projected_mismatch"
    });
    expect(filterAcceptedDiffs([deterministic])).toEqual([deterministic]);
  });
});

describe("reviewAndMergeFindings", () => {
  it("filters rejected and deduplicates", () => {
    const a = makeDiff({ id: "a", severity: "low", reviewerStatus: "accepted" });
    const b = makeDiff({ id: "b", severity: "medium", reviewerStatus: "accepted" });
    const rejected = makeDiff({ id: "c", reviewerStatus: "rejected" });
    const result = reviewAndMergeFindings([a, b, rejected]);
    expect(result).toHaveLength(1);
    expect(result[0]?.severity).toBe("medium");
  });

  it("rejects unsupported absence claims through the final merge guard", () => {
    const result = reviewAndMergeFindings([
      makeDiff({ title: "Actual screenshot is entirely blank", evidence: ["The target is missing"] })
    ]);
    expect(result).toHaveLength(0);
  });

  it("rejects unsupported quantitative scope claims through the final merge guard", () => {
    const result = reviewAndMergeFindings([
      makeDiff({ scopeKind: "screen", scopeId: "screen", title: "Screen changed by 100%", evidence: ["The supplied images differ"] })
    ]);
    expect(result).toHaveLength(0);
  });
});

describe("validateClaim", () => {
  it.each([
    "Actual screenshot is entirely black.",
    "The actual image is blank.",
    "The element is absent.",
    "The element is missing.",
    "The element does not exist.",
    "There is no visible content."
  ])("rejects unqualified global absence claim: %s", statement => {
    expect(validateClaim(makeDiff({ title: statement, evidence: ["Visible difference"] }))).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/absence|blank|black/i)
    });
  });

  it.each([
    "The element is missing within the supplied crop.",
    "The element is absent at the expected position.",
    "The projected expected position has no visible content.",
    "The evidence does not support a missing or misplaced element.",
    "There is no missing or misplaced element.",
    "The evidence is without a missing element.",
    "The triangular arrow is never missing."
  ])("allows qualified or explicitly negated absence statement: %s", statement => {
    expect(validateClaim(makeDiff({ title: "Presence difference", evidence: [statement] }))).toEqual({ valid: true });
  });

  it("rejects a partially missing element as a real absence claim", () => {
    expect(validateClaim(makeDiff({
      title: "Partially missing triangular arrow",
      evidence: ["The triangular arrow is partially missing."]
    }))).toMatchObject({ valid: false, reason: expect.stringMatching(/absence|blank/i) });
  });

  it("continues to reject a global blank assertion", () => {
    expect(validateClaim(makeDiff({ title: "The actual image is blank." }))).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/absence|blank/i)
    });
  });

  it.each([
    "The button is gone.",
    "The element is no longer visible.",
    "The icon is no longer present.",
    "The text is gone from the screen."
  ])("rejects unqualified absence claim with expanded phrase: %s", statement => {
    expect(validateClaim(makeDiff({ title: statement, evidence: ["Visible difference"] }))).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/absence|blank|black/i)
    });
  });

  it.each([
    "The button is gone from the expected crop.",
    "The element is no longer visible in the supplied crop.",
    "The icon is no longer present at the expected position."
  ])("allows crop-grounded expanded absence claim: %s", statement => {
    expect(validateClaim(makeDiff({ title: "Presence difference", evidence: [statement] }))).toEqual({ valid: true });
  });

  it("allows ordinary black-background color statements", () => {
    expect(validateClaim(makeDiff({ title: "Black background", evidence: ["The panel background changed to black."] }))).toEqual({ valid: true });
  });

  it("allows black button/text/icon statements without global qualifiers", () => {
    expect(validateClaim(makeDiff({ title: "Black button", evidence: ["The actual screenshot contains a black button."] }))).toEqual({ valid: true });
    expect(validateClaim(makeDiff({ title: "Black text", evidence: ["The actual screenshot has a black text element."] }))).toEqual({ valid: true });
    expect(validateClaim(makeDiff({ title: "Black icon", evidence: ["The icon is black."] }))).toEqual({ valid: true });
  });

  it.each([
    "The actual screenshot is entirely black.",
    "The actual image is completely black.",
    "The actual screenshot is totally black.",
    "The actual screenshot is solid black.",
    "The expected screenshot is all-black."
  ])("rejects global black claim with qualifier: %s", statement => {
    expect(validateClaim(makeDiff({ title: statement, evidence: ["Visible difference"] }))).toMatchObject({
      valid: false,
      reason: expect.stringMatching(/absence|blank|black/i)
    });
  });

  it.each([
    "The actual screenshot is entirely white.",
    "The actual screenshot is completely blurred."
  ])("allows qualifier without black: %s", statement => {
    expect(validateClaim(makeDiff({ title: statement, evidence: ["Visible difference"] }))).toEqual({ valid: true });
  });

  it("allows screenshot containing a black button", () => {
    expect(validateClaim(makeDiff({ title: "Black button", evidence: ["The actual screenshot contains a black button."] }))).toEqual({ valid: true });
  });

  it("allows screenshot containing a black text element", () => {
    expect(validateClaim(makeDiff({ title: "Black text", evidence: ["The actual screenshot contains a black text element."] }))).toEqual({ valid: true });
  });

  it("allows screenshot containing a black background", () => {
    expect(validateClaim(makeDiff({ title: "Black background", evidence: ["The actual screenshot contains a black background."] }))).toEqual({ valid: true });
  });

  it.each([
    ["2107px²", "px²"],
    ["2107px^2", "px²"],
    ["2107 square pixels", "px²"],
    ["2107 pixels squared", "px²"],
    ["2107 pixel-count", "pixels"],
    ["2107 pixel count", "pixels"],
    ["2107 pixels", "pixels"],
    ["pixel count: 2107", "pixels"],
    ["100%", "%"],
    ["100 percent", "%"]
  ] as const)("accepts supported quantitative unit %s", (claim, unit) => {
    const value = claim.startsWith("100") ? 100 : 2107;
    expect(validateClaim(makeDiff({ evidence: [`Changed region measures ${claim}.`], measurements: [{ name: "deterministic", value, unit }] }))).toEqual({ valid: true });
  });

  it.each(["2107px²", "2107 pixel count", "100%"]) ("rejects unsupported quantitative claim %s", claim => {
    expect(validateClaim(makeDiff({ evidence: [`Changed region measures ${claim}.`] }))).toMatchObject({ valid: false, reason: expect.stringMatching(/quantitative/i) });
  });

  it("validates dominant palette JSON RGB channels and counts", () => {
    const valid = [{ name: "color_dominant_expected_palette", value: JSON.stringify([{ r: 0, g: 128, b: 255, count: 12 }]) }];
    const invalid = [{ name: "color_dominant_actual_palette", value: JSON.stringify([{ r: 256, g: 0, b: 1, count: 12 }]) }];
    expect(validateClaim(makeDiff({ measurements: valid }))).toEqual({ valid: true });
    expect(validateClaim(makeDiff({ measurements: invalid }))).toMatchObject({ valid: false, reason: expect.stringMatching(/palette/i) });
  });
});

describe("hasUnsupportedQuantitativeClaim", () => {
  it("rejects an exact pixel shift without matching deterministic evidence", () => {
    expect(hasUnsupportedQuantitativeClaim(
      makeDiff({ evidence: ["The element is shifted left by 3px."] }),
      []
    )).toBe(true);
  });

  it("allows a claim backed by the named deterministic measurement", () => {
    expect(hasUnsupportedQuantitativeClaim(
      makeDiff({ evidence: ["The element is shifted left by 3px."] }),
      [{ name: "horizontal_shift", value: -3, unit: "px" }]
    )).toBe(false);
  });

  it("allows quoted and OCR-backed literal UI values", () => {
    expect(hasUnsupportedQuantitativeClaim(
      makeDiff({ evidence: ["Visible text changed from \"420\" to \"10%\" and still includes of 2,400."] }),
      [],
      ["420", "10%", "of 2,400"]
    )).toBe(false);
  });

  it("rejects unsupported font-size and spacing measurements", () => {
    expect(hasUnsupportedQuantitativeClaim(
      makeDiff({ title: "Font size is 16px", evidence: ["Gap increased by 8px."] }),
      []
    )).toBe(true);
  });
});

describe("requiredAcceptedArtifactRoles", () => {
  it("returns scope audit roles for screen-kind vlm_reviewed diffs", () => {
    const roles = requiredAcceptedArtifactRoles({ classificationSource: "vlm_reviewed", scopeKind: "screen" });
    expect(roles).toEqual(["expected_normalized", "actual_comparison_space", "directional_overlay", "pixel_diff_mask"]);
  });

  it("returns scope audit roles for region-kind vlm_reviewed diffs", () => {
    const roles = requiredAcceptedArtifactRoles({ classificationSource: "vlm_reviewed", scopeKind: "region" });
    expect(roles).toEqual(["expected_normalized", "actual_comparison_space", "directional_overlay", "pixel_diff_mask"]);
  });

  it("returns target audit roles for target-kind vlm_reviewed diffs", () => {
    const roles = requiredAcceptedArtifactRoles({ classificationSource: "vlm_reviewed", scopeKind: "target" });
    expect(roles).toEqual(["expected_crop", "actual_crop", "local_directional_overlay", "local_pixel_diff_mask", "context_crop"]);
  });

  it("returns target audit roles for vlm_reviewed diffs with no scopeKind", () => {
    const roles = requiredAcceptedArtifactRoles({ classificationSource: "vlm_reviewed" });
    expect(roles).toEqual(["expected_crop", "actual_crop", "local_directional_overlay", "local_pixel_diff_mask", "context_crop"]);
  });

  it("returns recovery roles for target_recovery diffs", () => {
    const roles = requiredAcceptedArtifactRoles({ classificationSource: "target_recovery", scopeKind: "target" });
    expect(roles).toEqual(["recovery_expected_crop", "recovery_actual_crop", "recovery_directional_overlay", "recovery_pixel_diff_mask"]);
  });

  it("returns target audit roles for diffs with no classificationSource", () => {
    const roles = requiredAcceptedArtifactRoles({});
    expect(roles).toEqual(["expected_crop", "actual_crop", "local_directional_overlay", "local_pixel_diff_mask", "context_crop"]);
  });
});
