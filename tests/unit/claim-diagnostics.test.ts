import { describe, expect, it } from "vitest";
import { collectVisibleClaimLiterals, validateClaim, validateFinalizedClaim, validateFinalizedClaims } from "../../src/audit/review-findings.js";
import type { ClaimDiagnostics, DiffRecord, RecoveryComponentTrace, RecoveryRegionOutcome, UiArtifact, UiElement } from "../../src/schemas/core.js";
import { DiffRecordSchema, UnresolvedRegionSchema, RecoveryComponentTraceSchema } from "../../src/schemas/core.js";
import { annotateRecoveryTraceSupersessions, applyFindingCoverage, applyRecoveryOutcomes, buildRegionLedger, invalidateCoverageForEscalatedClaims, markBroadVlmEvidence, unresolvedRegionsFromLedger } from "../../src/report/region-ledger.js";
import type { CanonicalRegion, RegionLedger } from "../../src/report/region-ledger.js";
import type { PixelComponent } from "../../src/signals/pixel-diff.js";

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

function makeElement(id: string, label: string, text?: string): UiElement {
  return {
    id,
    label,
    type: "text",
    box: { x: 10, y: 20, width: 100, height: 30 },
    normalizedBox: { x: 0.05, y: 0.05, width: 0.5, height: 0.1 },
    confidence: 1,
    source: "locator",
    childIds: [],
    ...(text !== undefined ? { text } : {})
  };
}

function makeComponent(x: number, y: number, w: number, h: number, pixelCount = 200): PixelComponent {
  return { box: { x, y, width: w, height: h }, pixelCount };
}

const RECOVERY_ROLES: UiArtifact["role"][] = [
  "recovery_expected_crop",
  "recovery_actual_crop",
  "recovery_actual_comparison_crop",
  "recovery_directional_overlay",
  "recovery_pixel_diff_mask"
];

function makeRecoveryArtifacts(regionId: string): UiArtifact[] {
  return RECOVERY_ROLES.map(role => ({ role, path: `artifacts/recovery-${regionId}-${role}.png` }));
}

describe("ClaimDiagnostics schema", () => {
  it("accepts a minimal unsupported_absence diagnostic", () => {
    const diag: ClaimDiagnostics = {
      code: "unsupported_absence",
      message: "Unsupported global absence or blank claim without crop-grounded evidence"
    };
    expect(diag.code).toBe("unsupported_absence");
    expect(diag.offendingExcerpt).toBeUndefined();
    expect(diag.quantitative).toBeUndefined();
  });

  it("accepts a full quantitative diagnostic with excerpt and measurements", () => {
    const diag: ClaimDiagnostics = {
      code: "unsupported_quantitative",
      message: "Unsupported quantitative claim",
      offendingExcerpt: "Changed region measures 2107px². The background is different.",
      quantitative: {
        offendingValue: 2107,
        offendingUnit: "px²",
        supportedMeasurements: [
          { name: "changed_pixel_count", value: 500, unit: "pixels" },
          { name: "region_area", value: 4800, unit: "px²" }
        ]
      }
    };
    expect(diag.code).toBe("unsupported_quantitative");
    expect(diag.offendingExcerpt).toContain("2107px²");
    expect(diag.offendingExcerpt!.length).toBeLessThanOrEqual(200);
    expect(diag.quantitative?.offendingValue).toBe(2107);
    expect(diag.quantitative?.offendingUnit).toBe("px²");
    expect(diag.quantitative?.supportedMeasurements).toHaveLength(2);
  });

  it("accepts invalid_palette diagnostic", () => {
    const diag: ClaimDiagnostics = {
      code: "invalid_palette",
      message: "Invalid color_dominant_actual_palette measurement"
    };
    expect(diag.code).toBe("invalid_palette");
  });

  it("accepts unsupported_crop_boundary diagnostic", () => {
    const diag: ClaimDiagnostics = {
      code: "unsupported_crop_boundary",
      message: "Unsupported crop-boundary claim",
      offendingExcerpt: "The left half of the image is cut off"
    };
    expect(diag.code).toBe("unsupported_crop_boundary");
    expect(diag.offendingExcerpt).toBeDefined();
  });

  it("round-trips post-finalization claim diagnostics on DiffRecord", () => {
    const parsed = DiffRecordSchema.parse(makeDiff({
      claimValidationDiagnostics: {
        code: "unsupported_quantitative",
        message: "Unsupported quantitative claim",
        offendingExcerpt: "5%"
      }
    }));

    expect(parsed.claimValidationDiagnostics?.code).toBe("unsupported_quantitative");
    expect(parsed.claimValidationDiagnostics?.offendingExcerpt).toBe("5%");
  });

  it("accepts an unsupported_exact_color diagnostic", () => {
    const diag: ClaimDiagnostics = {
      code: "unsupported_exact_color",
      message: "Unsupported exact hex color claim",
      offendingExcerpt: "The panel is #1A1A1A"
    };
    expect(diag.code).toBe("unsupported_exact_color");
  });

  it("backward compatible: ClaimValidationResult without diagnostics still valid", () => {
    const result = validateClaim(makeDiff({ title: "Valid claim" }));
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toBeUndefined();
  });
});

describe("post-finalization visible claim literals", () => {
  it("strips LocateAnything markup and preserves numeric text as one literal", () => {
    const elements = [makeElement("target", "<ref>96/170mg5%</ref><box><622><450><882><471></box>")];

    expect(collectVisibleClaimLiterals(makeDiff({ targetIds: ["target"] }), elements)).toEqual(["96/170mg5%"]);
  });

  it("deduplicates normalized label/text literals in stable order and excludes non-target elements", () => {
    const elements = [
      makeElement("other", "Should not be included", "outside"),
      makeElement("b", "  Macro   circle ", "96/170mg5%"),
      makeElement("a", "Macro circle", " 96/170mg5% ")
    ];

    expect(collectVisibleClaimLiterals(makeDiff({ targetIds: ["b", "a"] }), elements)).toEqual([
      "96/170mg5%",
      "Macro circle"
    ]);
  });

  it("allows an exact visible full label but not unsupported numeric claims", () => {
    const visible = collectVisibleClaimLiterals(
      makeDiff({ targetIds: ["target"] }),
      [makeElement("target", "96/170mg5%")]
    );

    expect(validateClaim(makeDiff({ title: "96/170mg5%", targetIds: ["target"] }), visible).valid).toBe(true);
    expect(validateClaim(makeDiff({ title: "96/170mg5%", targetIds: ["target"] }), ["Macro circle"]).valid).toBe(false);
    for (const title of ["5%", "12px", "shifted 96", "width 170"]) {
      expect(validateClaim(makeDiff({ title, targetIds: ["target"] }), visible).valid).toBe(false);
    }
    expect(validateClaim(makeDiff({ title: "5%" }), []).valid).toBe(false);
  });

  it("keeps a generated parent-label title valid when the target is visible", () => {
    const diff = makeDiff({ title: "geometry in recovered region: Submit button", targetIds: ["button"] });
    const visible = collectVisibleClaimLiterals(diff, [makeElement("button", "Submit button")]);

    expect(validateClaim(diff, visible).valid).toBe(true);
  });

  it("requires resolved literals for target-level accepted claims", () => {
    const dangling = makeDiff({
      title: "Button is shifted",
      pairId: "pair-missing",
      targetIds: ["missing-target"],
      reviewerStatus: "accepted"
    });
    expect(validateFinalizedClaim(dangling, [makeElement("other", "Other button")])).toMatchObject({
      valid: false,
      diagnostics: { code: "missing_target_literal" }
    });

    const screenDiff = makeDiff({ title: "Navigation differs", scopeKind: "screen", reviewerStatus: "accepted" });
    delete screenDiff.pairId;
    expect(validateFinalizedClaim(screenDiff, []).valid).toBe(true);
    const recovered = makeDiff({ title: "Recovered region differs", classificationSource: "target_recovery", reviewerStatus: "accepted" });
    delete recovered.pairId;
    expect(validateFinalizedClaim(recovered, []).valid).toBe(true);
  });

  it("escalates unsupported accepted final claims with bounded diagnostics", () => {
    const result = validateFinalizedClaims(
      [makeDiff({ id: "unsupported", title: "5%", targetIds: ["target"] })],
      [makeElement("target", "Macro circle")]
    );

    expect(result.escalatedCount).toBe(1);
    expect(result.diffs[0]).toMatchObject({
      reviewerStatus: "needs_escalation",
      reviewerReason: expect.stringMatching(/^Post-consolidation claim validation failed:/),
      claimValidationDiagnostics: { code: "unsupported_quantitative" }
    });

    const missingTarget = validateFinalizedClaims(
      [makeDiff({ id: "unsupported-without-target", title: "5%", pairId: "pair-missing", targetIds: [] })],
      [makeElement("target", "Macro circle")]
    );
    expect(missingTarget.escalatedCount).toBe(1);
    expect(missingTarget.diffs[0]).toMatchObject({
      reviewerStatus: "needs_escalation",
      reviewerReason: expect.stringMatching(/^Post-consolidation claim validation failed:/),
      claimValidationDiagnostics: { code: "missing_target_literal" }
    });
  });

  it("leaves deterministic not_reviewed findings unchanged", () => {
    const diff = makeDiff({
      reviewerStatus: "not_reviewed",
      classificationSource: "deterministic_geometry",
      title: "5%",
      targetIds: ["target"]
    });

    expect(validateFinalizedClaims([diff], [makeElement("target", "Macro circle")])).toEqual({
      diffs: [diff],
      escalatedCount: 0
    });
  });
});

describe("validateClaim structured diagnostics", () => {
  it("quantitative rejection exposes excerpt/value/unit/supported measurements", () => {
    const diff = makeDiff({
      evidence: ["Changed region measures 2107px². The background is different."],
      measurements: [
        { name: "changed_pixel_count", value: 500, unit: "pixels" },
        { name: "region_area", value: 4800, unit: "px²" }
      ]
    });
    const result = validateClaim(diff);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics!.code).toBe("unsupported_quantitative");
    expect(result.diagnostics!.offendingExcerpt).toContain("2107px²");
    expect(result.diagnostics!.quantitative).toBeDefined();
    expect(result.diagnostics!.quantitative!.offendingValue).toBe(2107);
    expect(result.diagnostics!.quantitative!.offendingUnit).toBe("px²");
    expect(result.diagnostics!.quantitative!.supportedMeasurements).toHaveLength(2);
    expect(result.diagnostics!.quantitative!.supportedMeasurements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 500, unit: "pixels" }),
        expect.objectContaining({ value: 4800, unit: "px²" })
      ])
    );
  });

  it("absence exposes bounded excerpt", () => {
    const longTitle = "A".repeat(100) + " The actual screenshot is entirely black. " + "B".repeat(100);
    const diff = makeDiff({
      title: longTitle,
      evidence: ["Evidence text"]
    });
    const result = validateClaim(diff);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics!.code).toBe("unsupported_absence");
    expect(result.diagnostics!.offendingExcerpt).toBeDefined();
    expect(result.diagnostics!.offendingExcerpt!.length).toBeLessThanOrEqual(200);
    expect(result.diagnostics!.offendingExcerpt).toContain("entirely black");
  });

  it("crop boundary rejection exposes excerpt", () => {
    const diff = makeDiff({
      title: "Layout issue",
      evidence: ["The left half of the image is cut off"]
    });
    const result = validateClaim(diff);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics!.code).toBe("unsupported_crop_boundary");
    expect(result.diagnostics!.offendingExcerpt).toContain("left half");
  });

  it("invalid palette rejection exposes measurement name", () => {
    const diff = makeDiff({
      measurements: [{
        name: "color_dominant_actual_palette",
        value: JSON.stringify([{ r: 256, g: 0, b: 1, count: 12 }])
      }]
    });
    const result = validateClaim(diff);
    expect(result.valid).toBe(false);
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics!.code).toBe("invalid_palette");
    expect(result.diagnostics!.message).toContain("color_dominant_actual_palette");
  });

  it("valid claim has no diagnostics", () => {
    const result = validateClaim(makeDiff({ title: "Button shifted" }));
    expect(result.valid).toBe(true);
    expect(result.diagnostics).toBeUndefined();
  });

  it("rejects an exact hex color literal without a deterministic supporting measurement", () => {
    const result = validateClaim(makeDiff({
      title: "Panel color changed to #1A1A1A",
      evidence: ["The expected panel is #fff and the actual panel is #1A1A1A"]
    }));
    expect(result).toMatchObject({
      valid: false,
      diagnostics: {
        code: "unsupported_exact_color",
        offendingExcerpt: expect.stringContaining("#1A1A1A")
      }
    });
  });

  it("allows an exact hex color literal when a deterministic measurement contains that literal", () => {
    const result = validateClaim(makeDiff({
      title: "Panel color changed to #1A1A1A",
      measurements: [{ name: "actual_fill", value: "#1A1A1A", unit: "hex" }]
    }));
    expect(result).toEqual({ valid: true });
  });

  it("does not parse #1A1A1A as an unqualified layout number", () => {
    const result = validateClaim(makeDiff({
      title: "Panel shifted #1A1A1A",
      evidence: ["The panel remains visible"]
    }));
    expect(result).not.toMatchObject({ diagnostics: { code: "unsupported_quantitative", quantitative: { offendingValue: 1 } } });
  });

  it("continues rejecting unsupported percentage claims", () => {
    const result = validateClaim(makeDiff({
      title: "Progress is 100%",
      evidence: ["The deterministic progress is 86.95%"],
      measurements: [{ name: "progress_percent", value: 86.95, unit: "%" }]
    }));
    expect(result).toMatchObject({ valid: false, diagnostics: { code: "unsupported_quantitative" } });
  });

  it("does not let a possessive apostrophe corrupt later quoted visible percentages", () => {
    const result = validateClaim(makeDiff({
      title: "Spacing alignment mismatch",
      evidence: [
        "The element's placement differs from the expected mockup.",
        "The baseline of the text '132/250g' is not aligned with the quoted value '53%'."
      ]
    }));

    expect(result).toEqual({ valid: true });
  });

  it("keeps apostrophes inside a single-quoted visible label within that quote", () => {
    const result = validateClaim(makeDiff({
      title: "Text alignment mismatch",
      evidence: ["The label 'user's input 53%' is vertically misaligned."]
    }));

    expect(result).toEqual({ valid: true });
  });

  it("still rejects the real percentage when it is not quoted", () => {
    const result = validateClaim(makeDiff({
      title: "Spacing alignment mismatch",
      evidence: [
        "The element's placement differs from the expected mockup.",
        "The progress is 53%."
      ]
    }));

    expect(result).toMatchObject({ valid: false, diagnostics: { code: "unsupported_quantitative" } });
  });

  it("offending excerpt is capped at 200 characters", () => {
    const longEvidence = "X".repeat(300) + "100%" + "Y".repeat(300);
    const diff = makeDiff({ evidence: [longEvidence] });
    const result = validateClaim(diff);
    if (!result.valid && result.diagnostics?.offendingExcerpt) {
      expect(result.diagnostics.offendingExcerpt.length).toBeLessThanOrEqual(200);
    }
  });

  it("supported measurements are capped at 10 entries", () => {
    const manyMeasurements = Array.from({ length: 15 }, (_, i) => ({
      name: `measurement_${i}`,
      value: i * 100,
      unit: "pixels"
    }));
    const diff = makeDiff({
      evidence: ["Changed region measures 500px."],
      measurements: manyMeasurements
    });
    const result = validateClaim(diff);
    if (!result.valid && result.diagnostics?.quantitative?.supportedMeasurements) {
      expect(result.diagnostics.quantitative.supportedMeasurements.length).toBeLessThanOrEqual(10);
    }
  });
});

describe("RecoveryComponentTrace structured candidate fields", () => {
  it("supports optional candidateTitle, candidateEvidence, candidateMeasurements, claimValidationDiagnostics", () => {
    const trace: Partial<RecoveryComponentTrace> = {
      componentId: "region-0001",
      rank: 0,
      componentBox: { x: 10, y: 10, width: 80, height: 60 },
      pixelCount: 500,
      status: "unsupported_recovery_claim",
      candidateTitle: "geometry in recovered region: Submit button",
      candidateEvidence: ["element visibly shifted"],
      candidateMeasurements: [{ name: "changed_pixel_count", value: 500, unit: "pixels" }],
      claimValidationDiagnostics: {
        code: "unsupported_quantitative",
        message: "Unsupported quantitative claim"
      }
    };
    const parsed = RecoveryComponentTraceSchema.parse(trace);
    expect(parsed.candidateTitle).toBe("geometry in recovered region: Submit button");
    expect(parsed.candidateEvidence).toEqual(["element visibly shifted"]);
    expect(parsed.candidateMeasurements).toEqual([{ name: "changed_pixel_count", value: 500, unit: "pixels" }]);
    expect(parsed.claimValidationDiagnostics?.code).toBe("unsupported_quantitative");
  });

  it("backward compatible: trace without candidate fields is valid", () => {
    const trace = {
      componentId: "region-0001",
      rank: 0,
      componentBox: { x: 10, y: 10, width: 80, height: 60 },
      pixelCount: 500,
      status: "recovery_accepted" as const,
      artifactPaths: []
    };
    expect(() => RecoveryComponentTraceSchema.parse(trace)).not.toThrow();
    const parsed = RecoveryComponentTraceSchema.parse(trace);
    expect(parsed.candidateTitle).toBeUndefined();
    expect(parsed.candidateEvidence).toBeUndefined();
    expect(parsed.claimValidationDiagnostics).toBeUndefined();
  });
});

describe("RecoveryRegionOutcome structured fields", () => {
  it("carries criterion, diagnostics, and candidateTitle for unsupported claims", () => {
    const outcome: RecoveryRegionOutcome = {
      regionId: "region-0001",
      state: "unresolved",
      reason: "unsupported_recovery_claim: Unsupported quantitative claim",
      artifactPaths: makeRecoveryArtifacts("region-0001"),
      criterion: "geometry",
      diagnostics: {
        code: "unsupported_quantitative",
        message: "Unsupported quantitative claim",
        offendingExcerpt: "Changed region measures 2107px².",
        quantitative: {
          offendingValue: 2107,
          offendingUnit: "px²",
          supportedMeasurements: [{ name: "changed_pixel_count", value: 500, unit: "pixels" }]
        }
      },
      candidateTitle: "geometry in recovered region: Submit button",
      candidateEvidence: ["element visibly shifted"]
    };
    expect(outcome.criterion).toBe("geometry");
    expect(outcome.diagnostics?.code).toBe("unsupported_quantitative");
    expect(outcome.candidateTitle).toBeDefined();
    expect(outcome.candidateEvidence).toEqual(["element visibly shifted"]);
  });
});

describe("UnresolvedRegion unsupported_recovery_claim reason", () => {
  it("accepts unsupported_recovery_claim reason with optional diagnostics", () => {
    const parsed = UnresolvedRegionSchema.parse({
      id: "region-0001",
      location: { x: 10, y: 10, width: 80, height: 60 },
      pixelCount: 500,
      sourceComponentIds: ["component-0001"],
      reason: "unsupported_recovery_claim",
      diagnostics: {
        code: "unsupported_quantitative",
        message: "Unsupported quantitative claim"
      },
      artifactPaths: makeRecoveryArtifacts("region-0001")
    });
    expect(parsed.reason).toBe("unsupported_recovery_claim");
    expect(parsed.diagnostics?.code).toBe("unsupported_quantitative");
  });

  it("backward compatible: unresolved region without diagnostics is valid", () => {
    const parsed = UnresolvedRegionSchema.parse({
      id: "region-0001",
      location: { x: 10, y: 10, width: 80, height: 60 },
      pixelCount: 500,
      sourceComponentIds: ["component-0001"],
      reason: "not_classified",
      artifactPaths: []
    });
    expect(parsed.reason).toBe("not_classified");
    expect(parsed.diagnostics).toBeUndefined();
  });
});

describe("CanonicalRegion blockingRecoveryOutcome", () => {
  it("stores blockingRecoveryOutcome separately from state", () => {
    const region: CanonicalRegion = {
      id: "region-0001",
      box: { x: 10, y: 10, width: 80, height: 60 },
      pixelCount: 500,
      sourceComponentIds: ["component-0001"],
      state: "unresolved",
      coveringFindingIds: [],
      artifactPaths: [],
      blockingRecoveryOutcome: {
        regionId: "region-0001",
        state: "unresolved",
        reason: "unsupported_recovery_claim: Unsupported quantitative claim",
        artifactPaths: makeRecoveryArtifacts("region-0001"),
        criterion: "geometry",
        diagnostics: {
          code: "unsupported_quantitative",
          message: "Unsupported quantitative claim"
        },
        candidateTitle: "geometry in recovered region",
        candidateEvidence: ["element visibly shifted"]
      }
    };
    expect(region.blockingRecoveryOutcome).toBeDefined();
    expect(region.blockingRecoveryOutcome?.criterion).toBe("geometry");
    expect(region.blockingRecoveryOutcome?.diagnostics?.code).toBe("unsupported_quantitative");
  });
});

describe("ledger: applyRecoveryOutcomes sets blockingRecoveryOutcome for unsupported_recovery_claim", () => {
  function makeLedgerWithRegion(regionId: string): RegionLedger {
    return {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: regionId,
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-0001"],
        state: "unresolved",
        coveringFindingIds: [],
        artifactPaths: []
      }],
      coverageTrace: []
    };
  }

  it("sets blockingRecoveryOutcome for unsupported_recovery_claim outcome", () => {
    const ledger = makeLedgerWithRegion("region-0001");
    const outcome: RecoveryRegionOutcome = {
      regionId: "region-0001",
      state: "unresolved",
      reason: "unsupported_recovery_claim: Unsupported quantitative claim",
      artifactPaths: makeRecoveryArtifacts("region-0001"),
      criterion: "geometry",
      diagnostics: {
        code: "unsupported_quantitative",
        message: "Unsupported quantitative claim"
      },
      candidateTitle: "geometry in recovered region",
      candidateEvidence: ["evidence"]
    };
    applyRecoveryOutcomes(ledger, [outcome]);
    const region = ledger.regions[0]!;
    expect(region.blockingRecoveryOutcome).toBeDefined();
    expect(region.blockingRecoveryOutcome?.criterion).toBe("geometry");
    expect(region.blockingRecoveryOutcome?.diagnostics?.code).toBe("unsupported_quantitative");
    expect(region.state).toBe("unresolved");
    expect(region.unresolvedDetail).toBe("unsupported_recovery_claim: Unsupported quantitative claim");
  });

  it("does not set blockingRecoveryOutcome for recovered outcome", () => {
    const ledger = makeLedgerWithRegion("region-0001");
    applyRecoveryOutcomes(ledger, [{
      regionId: "region-0001",
      state: "recovered",
      reason: "recovery_accepted",
      artifactPaths: makeRecoveryArtifacts("region-0001"),
      findingId: "diff-1"
    }]);
    expect(ledger.regions[0]!.blockingRecoveryOutcome).toBeUndefined();
  });

  it("sets blockingRecoveryOutcome for every unresolved outcome, including reviewer rejection without a criterion", () => {
    const ledger = makeLedgerWithRegion("region-0001");
    const outcome: RecoveryRegionOutcome = {
      regionId: "region-0001",
      state: "unresolved",
      reason: "reviewer_rejected: evidence was not visually supported",
      artifactPaths: makeRecoveryArtifacts("region-0001")
    };

    applyRecoveryOutcomes(ledger, [outcome]);

    expect(ledger.regions[0]!.blockingRecoveryOutcome).toEqual(outcome);
  });
});

describe("ledger: applyFindingCoverage cannot hide unsupported_recovery_claim at 10% overlap", () => {
  it("remains unresolved with blockingRecoveryOutcome even when a larger finding overlaps 10%", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-0001"],
        state: "unresolved",
        coveringFindingIds: [],
        artifactPaths: [],
        unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
        blockingRecoveryOutcome: {
          regionId: "region-0001",
          state: "unresolved",
          reason: "unsupported_recovery_claim: Unsupported quantitative claim",
          artifactPaths: makeRecoveryArtifacts("region-0001"),
          criterion: "geometry",
          diagnostics: {
            code: "unsupported_quantitative",
            message: "Unsupported quantitative claim"
          }
        }
      }],
      coverageTrace: []
    };
    // Finding that overlaps the region by ~15% (above 10% threshold but below 90%)
    const overlapFinding: DiffRecord = {
      id: "diff-overlap",
      criterion: "color_appearance",
      severity: "medium",
      title: "Color changed",
      location: { x: 50, y: 30, width: 60, height: 50 },
      evidence: ["Color differs"],
      measurements: [],
      artifactPaths: [],
      reviewerStatus: "accepted"
    };
    applyFindingCoverage(ledger, [overlapFinding]);
    const region = ledger.regions[0]!;
    // Must remain unresolved because blockingRecoveryOutcome exists and overlap < 90%
    expect(region.state).toBe("unresolved");
    expect(region.blockingRecoveryOutcome).toBeDefined();
    expect(region.blockingRecoveryOutcome?.diagnostics?.code).toBe("unsupported_quantitative");
  });

  it("supersedes at >=90% overlap with same criterion and records supersession detail", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-0001"],
        state: "unresolved",
        coveringFindingIds: [],
        artifactPaths: [],
        unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
        blockingRecoveryOutcome: {
          regionId: "region-0001",
          state: "unresolved",
          reason: "unsupported_recovery_claim: Unsupported quantitative claim",
          artifactPaths: makeRecoveryArtifacts("region-0001"),
          criterion: "geometry",
          diagnostics: {
            code: "unsupported_quantitative",
            message: "Unsupported quantitative claim"
          }
        }
      }],
      coverageTrace: []
    };
    // Finding with same criterion that overlaps >= 90%
    const sameCriterionFinding: DiffRecord = {
      id: "diff-same",
      criterion: "geometry",
      severity: "medium",
      title: "Geometry changed",
      location: { x: 10, y: 10, width: 80, height: 58 },
      evidence: ["Geometry differs"],
      measurements: [],
      artifactPaths: [],
      reviewerStatus: "accepted"
    };
    applyFindingCoverage(ledger, [sameCriterionFinding]);
    const region = ledger.regions[0]!;
    // Superseded: state changes to covered, supersession detail recorded
    expect(region.state).toBe("covered");
    expect(region.supersessionDetail).toBeDefined();
    expect(region.supersessionDetail?.supersedingFindingId).toBe("diff-same");
    expect(region.supersessionDetail?.reason).toBe("same_criterion_acceptance_overlap");
    expect(region.supersessionDetail?.overlapRatio).toBeGreaterThanOrEqual(0.9);
    // blockingRecoveryOutcome preserved for auditability
    expect(region.blockingRecoveryOutcome).toBeDefined();
  });

  it("does not cover an unresolved blocker without a criterion at 10% overlap", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-0001"],
        state: "unresolved",
        coveringFindingIds: [],
        artifactPaths: [],
        unresolvedDetail: "reviewer_rejected: evidence was not visually supported",
        blockingRecoveryOutcome: {
          regionId: "region-0001",
          state: "unresolved",
          reason: "reviewer_rejected: evidence was not visually supported",
          artifactPaths: makeRecoveryArtifacts("region-0001")
        }
      }],
      coverageTrace: []
    };
    const broadFinding = makeDiff({ id: "diff-broad", location: { x: 0, y: 0, width: 100, height: 100 } });

    applyFindingCoverage(ledger, [broadFinding]);

    expect(ledger.regions[0]!.state).toBe("unresolved");
  });

  it("does NOT supersede at >=90% overlap with different criterion", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-0001"],
        state: "unresolved",
        coveringFindingIds: [],
        artifactPaths: [],
        unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
        blockingRecoveryOutcome: {
          regionId: "region-0001",
          state: "unresolved",
          reason: "unsupported_recovery_claim: Unsupported quantitative claim",
          artifactPaths: makeRecoveryArtifacts("region-0001"),
          criterion: "geometry",
          diagnostics: {
            code: "unsupported_quantitative",
            message: "Unsupported quantitative claim"
          }
        }
      }],
      coverageTrace: []
    };
    // Finding with different criterion overlapping >= 90%
    const diffCriterionFinding: DiffRecord = {
      id: "diff-diff-criterion",
      criterion: "color_appearance",
      severity: "medium",
      title: "Color changed",
      location: { x: 10, y: 10, width: 80, height: 58 },
      evidence: ["Color differs"],
      measurements: [],
      artifactPaths: [],
      reviewerStatus: "accepted"
    };
    applyFindingCoverage(ledger, [diffCriterionFinding]);
    const region = ledger.regions[0]!;
    // Must remain unresolved because different criterion
    expect(region.state).toBe("unresolved");
    expect(region.blockingRecoveryOutcome).toBeDefined();
  });
});

describe("ledger: post-finalization claim escalation reopens dependent coverage", () => {
  const escalated: DiffRecord = {
    ...makeDiff({
      id: "primary-escalated",
      reviewerStatus: "needs_escalation",
      artifactPaths: [{ role: "expected_crop", path: "claim-expected.png" }],
      claimValidationDiagnostics: { code: "unsupported_quantitative", message: "Unsupported quantitative claim" },
      childFindingIds: ["child-escalated"]
    })
  };

  it("invalidates primary and child coverage while retaining an alternative valid cover", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-0001"],
        state: "covered",
        coveringFindingIds: ["primary-escalated", "valid-cover"],
        artifactPaths: [{ role: "pixel_diff", path: "pixel.png" }]
      }],
      coverageTrace: [{
        componentId: "component-0001",
        componentBox: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        status: "covered_by_diff",
        coveringDiffId: "primary-escalated",
        coveringCriterion: "geometry"
      }]
    };

    invalidateCoverageForEscalatedClaims(ledger, [escalated], [makeDiff({ id: "valid-cover", title: "Valid cover" })]);

    expect(ledger.regions[0]).toMatchObject({ state: "covered", coveringFindingIds: ["valid-cover"] });
    expect(ledger.regions[0]?.relatedFindingIds).toEqual(["child-escalated", "primary-escalated"]);
    expect(ledger.regions[0]?.artifactPaths).toEqual(expect.arrayContaining([
      { role: "pixel_diff", path: "pixel.png" },
      { role: "expected_crop", path: "claim-expected.png" }
    ]));
  });

  it("reopens covered and residual-noise regions when no eligible cover remains", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-0001"],
        state: "noise",
        coveringFindingIds: ["child-escalated", "stale-cover"],
        supersessionDetail: { supersedingFindingId: "primary-escalated", reason: "same_criterion_acceptance_overlap", overlapRatio: 1 },
        artifactPaths: [{ role: "pixel_diff", path: "pixel.png" }]
      }],
      coverageTrace: [{
        componentId: "component-0001",
        componentBox: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        status: "noise_residual_fragment",
        coveringDiffId: "child-escalated",
        coveringCriterion: "geometry"
      }]
    };

    invalidateCoverageForEscalatedClaims(ledger, [escalated]);

    expect(ledger.regions[0]).toMatchObject({
      state: "unresolved",
      coveringFindingIds: [],
      unresolvedDetail: expect.stringContaining("unsupported_final_claim"),
      claimValidationDiagnostics: { code: "unsupported_quantitative" }
    });
    expect(ledger.regions[0]?.supersessionDetail).toBeUndefined();
    expect(ledger.coverageTrace[0]).toMatchObject({ status: "uncovered" });
    expect(ledger.coverageTrace[0]?.coveringDiffId).toBeUndefined();
    expect(ledger.regions[0]?.artifactPaths).toEqual(expect.arrayContaining([
      { role: "pixel_diff", path: "pixel.png" },
      { role: "expected_crop", path: "claim-expected.png" }
    ]));
    const unresolved = unresolvedRegionsFromLedger(ledger, "not_classified");
    expect(unresolved[0]).toMatchObject({
      reason: "unsupported_final_claim",
      relatedFindingIds: ["child-escalated", "primary-escalated"],
      diagnostics: { code: "unsupported_quantitative" }
    });
  });

  it("does not cross-contaminate unrelated escalations or keep stale noneligible covers", () => {
    const other: DiffRecord = {
      ...makeDiff({
        id: "other-escalated",
        artifactPaths: [{ role: "actual_crop", path: "other-actual.png" }],
        claimValidationDiagnostics: { code: "missing_target_literal", message: "Missing target literal" },
        childFindingIds: ["other-child"]
      })
    };
    const ledger: RegionLedger = {
      rawComponentCount: 2,
      belowThresholdCount: 0,
      regions: [
        {
          id: "region-a",
          box: { x: 10, y: 10, width: 40, height: 40 },
          pixelCount: 100,
          sourceComponentIds: ["component-a"],
          state: "covered",
          coveringFindingIds: ["primary-escalated"],
          artifactPaths: []
        },
        {
          id: "region-b",
          box: { x: 100, y: 10, width: 40, height: 40 },
          pixelCount: 100,
          sourceComponentIds: ["component-b"],
          state: "covered",
          coveringFindingIds: ["other-escalated"],
          artifactPaths: []
        }
      ],
      coverageTrace: [
        {
          componentId: "component-a",
          componentBox: { x: 10, y: 10, width: 40, height: 40 },
          pixelCount: 100,
          status: "covered_by_diff",
          coveringDiffId: "primary-escalated",
          coveringCriterion: "geometry"
        },
        {
          componentId: "component-b",
          componentBox: { x: 100, y: 10, width: 40, height: 40 },
          pixelCount: 100,
          status: "covered_by_diff",
          coveringDiffId: "other-escalated",
          coveringCriterion: "geometry"
        }
      ]
    };

    invalidateCoverageForEscalatedClaims(ledger, [escalated, other]);

    expect(ledger.regions[0]?.artifactPaths).toEqual([{ role: "expected_crop", path: "claim-expected.png" }]);
    expect(ledger.regions[0]?.claimValidationDiagnostics?.code).toBe("unsupported_quantitative");
    expect(ledger.regions[0]?.relatedFindingIds).not.toContain("other-escalated");
    expect(ledger.regions[1]?.artifactPaths).toEqual([{ role: "actual_crop", path: "other-actual.png" }]);
    expect(ledger.regions[1]?.claimValidationDiagnostics?.code).toBe("missing_target_literal");
    expect(ledger.regions[1]?.relatedFindingIds).not.toContain("primary-escalated");
    expect(ledger.regions.every(region => region.state === "unresolved")).toBe(true);
    expect(ledger.regions.every(region => region.coveringFindingIds.length === 0)).toBe(true);
  });

  it("canonicalizes an eligible parent's pre-consolidation child while removing an escalated parent", () => {
    const eligibleParent = makeDiff({
      id: "eligible-parent",
      title: "Valid parent",
      reviewerStatus: "accepted",
      childFindingIds: ["eligible-child"]
    });
    const ledger: RegionLedger = {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-0001"],
        state: "covered",
        coveringFindingIds: ["primary-escalated", "eligible-child"],
        artifactPaths: []
      }],
      coverageTrace: [{
        componentId: "component-0001",
        componentBox: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        status: "covered_by_diff",
        coveringDiffId: "eligible-child",
        coveringCriterion: "geometry"
      }]
    };

    invalidateCoverageForEscalatedClaims(ledger, [escalated], [eligibleParent]);

    expect(ledger.regions[0]).toMatchObject({ state: "covered", coveringFindingIds: ["eligible-parent"] });
    expect(ledger.coverageTrace[0]).toMatchObject({ status: "covered_by_diff", coveringDiffId: "eligible-parent" });
    expect(ledger.regions[0]?.unresolvedDetail).toBeUndefined();
  });

  it("keeps separate eligible child traces mapped to their own parents regardless of parent ordering", () => {
    const parentA = makeDiff({ id: "z-parent-a", title: "Parent A", childFindingIds: ["child-a"] });
    const parentB = makeDiff({ id: "a-parent-b", title: "Parent B", childFindingIds: ["child-b"] });
    const ledger: RegionLedger = {
      rawComponentCount: 2,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-a", "component-b"],
        state: "covered",
        coveringFindingIds: ["primary-escalated", "child-a", "child-b"],
        artifactPaths: []
      }],
      coverageTrace: [
        {
          componentId: "component-a",
          componentBox: { x: 10, y: 10, width: 40, height: 60 },
          pixelCount: 250,
          status: "covered_by_diff",
          coveringDiffId: "child-a",
          coveringCriterion: "geometry"
        },
        {
          componentId: "component-b",
          componentBox: { x: 50, y: 10, width: 40, height: 60 },
          pixelCount: 250,
          status: "covered_by_diff",
          coveringDiffId: "child-b",
          coveringCriterion: "geometry"
        }
      ]
    };

    invalidateCoverageForEscalatedClaims(ledger, [escalated], [parentA, parentB]);

    expect(ledger.regions[0]?.coveringFindingIds).toEqual(["a-parent-b", "z-parent-a"]);
    expect(ledger.coverageTrace[0]).toMatchObject({ coveringDiffId: "z-parent-a", coveringCriterion: parentA.criterion });
    expect(ledger.coverageTrace[1]).toMatchObject({ coveringDiffId: "a-parent-b", coveringCriterion: parentB.criterion });
  });
});

describe("ledger: markBroadVlmEvidence cannot overwrite blocking reason/diagnostics", () => {
  it("appends broad_vlm_evidence relation but preserves blocking reason", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-0001"],
        state: "unresolved",
        coveringFindingIds: [],
        artifactPaths: [],
        unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
        blockingRecoveryOutcome: {
          regionId: "region-0001",
          state: "unresolved",
          reason: "unsupported_recovery_claim: Unsupported quantitative claim",
          artifactPaths: makeRecoveryArtifacts("region-0001"),
          criterion: "geometry",
          diagnostics: {
            code: "unsupported_quantitative",
            message: "Unsupported quantitative claim"
          }
        }
      }],
      coverageTrace: []
    };
    const broadFinding: DiffRecord = {
      id: "diff-broad",
      criterion: "geometry",
      severity: "medium",
      title: "Broad change",
      location: { x: 0, y: 0, width: 100, height: 100 },
      evidence: ["Broad change"],
      measurements: [],
      artifactPaths: [],
      reviewerStatus: "accepted"
    };
    markBroadVlmEvidence(ledger, [broadFinding]);
    const region = ledger.regions[0]!;
    // broad_vlm_evidence appended to detail
    expect(region.unresolvedDetail).toContain("broad_vlm_evidence");
    expect(region.unresolvedDetail).toContain("unsupported_recovery_claim");
    // Broad evidence has its own namespace and cannot masquerade as a final finding.
    expect(region.coveringFindingIds).toEqual([]);
    expect(region.relatedBroadEvidenceIds).toEqual(["diff-broad"]);
    // blocking reason/diagnostics preserved
    expect(region.blockingRecoveryOutcome).toBeDefined();
    expect(region.blockingRecoveryOutcome?.diagnostics?.code).toBe("unsupported_quantitative");
    const [unresolved] = unresolvedRegionsFromLedger(ledger, "not_classified");
    expect(unresolved).toMatchObject({
      reason: "unsupported_recovery_claim",
      diagnostics: { code: "unsupported_quantitative" }
    });
  });

  it("appends broad evidence while preserving a reviewer rejection reason", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-0001"],
        state: "unresolved",
        coveringFindingIds: [],
        artifactPaths: [],
        unresolvedDetail: "reviewer_rejected: evidence was not visually supported",
        blockingRecoveryOutcome: {
          regionId: "region-0001",
          state: "unresolved",
          reason: "reviewer_rejected: evidence was not visually supported",
          artifactPaths: []
        }
      }],
      coverageTrace: []
    };

    markBroadVlmEvidence(ledger, [makeDiff({ id: "diff-broad", location: { x: 0, y: 0, width: 100, height: 100 } })]);

    expect(ledger.regions[0]!.unresolvedDetail).toBe(
      "reviewer_rejected: evidence was not visually supported; broad_vlm_evidence"
    );
    expect(unresolvedRegionsFromLedger(ledger, "not_classified")[0]).toMatchObject({
      reason: "not_classified",
      detail: "reviewer_rejected: evidence was not visually supported; broad_vlm_evidence",
      relatedFindingIds: [],
      relatedBroadEvidenceIds: ["diff-broad"]
    });
  });

  it("categorizes pure broad evidence as broad_vlm_evidence", () => {
    const ledger = buildRegionLedger([makeComponent(10, 10, 80, 60, 500)], [], {
      minPixelCount: 1,
      maxGapPx: 5,
      maxClusterAreaRatio: 0.5,
      imageWidth: 200,
      imageHeight: 200
    });

    markBroadVlmEvidence(ledger, [makeDiff({ id: "diff-broad", location: { x: 0, y: 0, width: 100, height: 100 } })]);

    expect(unresolvedRegionsFromLedger(ledger, "not_classified")[0]).toMatchObject({
      reason: "broad_vlm_evidence",
      detail: "broad_vlm_evidence",
      relatedFindingIds: [],
      relatedBroadEvidenceIds: ["diff-broad"]
    });
  });
});

describe("ledger: unresolvedRegionsFromLedger emits blocking unsupported outcomes", () => {
  it("emits each non-superseded blocking unsupported outcome with reason, diagnostics, artifacts", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 2,
      belowThresholdCount: 0,
      regions: [
        {
          id: "region-0001",
          box: { x: 10, y: 10, width: 80, height: 60 },
          pixelCount: 500,
          sourceComponentIds: ["comp-1"],
          state: "unresolved",
          coveringFindingIds: [],
          artifactPaths: makeRecoveryArtifacts("region-0001"),
          unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
          blockingRecoveryOutcome: {
            regionId: "region-0001",
            state: "unresolved",
            reason: "unsupported_recovery_claim: Unsupported quantitative claim",
            artifactPaths: makeRecoveryArtifacts("region-0001"),
            criterion: "geometry",
            diagnostics: {
              code: "unsupported_quantitative",
              message: "Unsupported quantitative claim",
              quantitative: { offendingValue: 2107, offendingUnit: "px²", supportedMeasurements: [] }
            },
            candidateTitle: "geometry in recovered region: Button",
            candidateEvidence: ["evidence"]
          }
        },
        {
          id: "region-0002",
          box: { x: 200, y: 200, width: 50, height: 50 },
          pixelCount: 300,
          sourceComponentIds: ["comp-2"],
          state: "unresolved",
          coveringFindingIds: [],
          artifactPaths: makeRecoveryArtifacts("region-0002"),
          unresolvedDetail: "unsupported_recovery_claim: Unsupported absence claim",
          blockingRecoveryOutcome: {
            regionId: "region-0002",
            state: "unresolved",
            reason: "unsupported_recovery_claim: Unsupported absence claim",
            artifactPaths: makeRecoveryArtifacts("region-0002"),
            criterion: "presence",
            diagnostics: {
              code: "unsupported_absence",
              message: "Unsupported global absence claim"
            }
          }
        }
      ],
      coverageTrace: []
    };
    const unresolved = unresolvedRegionsFromLedger(ledger, "not_classified");
    expect(unresolved).toHaveLength(2);

    const r1 = unresolved.find(r => r.id === "region-0001")!;
    expect(r1.reason).toBe("unsupported_recovery_claim");
    expect(r1.diagnostics?.code).toBe("unsupported_quantitative");
    expect(r1.diagnostics?.quantitative?.offendingValue).toBe(2107);
    expect(r1.artifactPaths).toHaveLength(5);
    expect(r1.artifactPaths.map(a => a.role).sort()).toEqual(RECOVERY_ROLES.sort());

    const r2 = unresolved.find(r => r.id === "region-0002")!;
    expect(r2.reason).toBe("unsupported_recovery_claim");
    expect(r2.diagnostics?.code).toBe("unsupported_absence");
    expect(r2.artifactPaths).toHaveLength(5);
  });

  it("omits superseded blocking outcomes from unresolved output", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["comp-1"],
        state: "covered",
        coveringFindingIds: ["diff-superseding"],
        artifactPaths: makeRecoveryArtifacts("region-0001"),
        unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
        blockingRecoveryOutcome: {
          regionId: "region-0001",
          state: "unresolved",
          reason: "unsupported_recovery_claim: Unsupported quantitative claim",
          artifactPaths: makeRecoveryArtifacts("region-0001"),
          criterion: "geometry",
          diagnostics: {
            code: "unsupported_quantitative",
            message: "Unsupported quantitative claim"
          }
        },
        supersessionDetail: {
          supersedingFindingId: "diff-superseding",
          reason: "same_criterion_acceptance_overlap",
          overlapRatio: 0.95
        }
      }],
      coverageTrace: []
    };
    const unresolved = unresolvedRegionsFromLedger(ledger, "not_classified");
    // Superseded region should not appear in unresolved output
    expect(unresolved).toHaveLength(0);
  });
});

describe("pipeline/report regression: two unsupported outcomes traceable or explicit supersession", () => {
  it("both non-superseded unsupported outcomes appear in final unresolved with diagnostics and accounting", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 2,
      belowThresholdCount: 0,
      regions: [
        {
          id: "region-0001",
          box: { x: 10, y: 10, width: 80, height: 60 },
          pixelCount: 500,
          sourceComponentIds: ["comp-1"],
          state: "unresolved",
          coveringFindingIds: [],
          artifactPaths: makeRecoveryArtifacts("region-0001"),
          unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
          blockingRecoveryOutcome: {
            regionId: "region-0001",
            state: "unresolved",
            reason: "unsupported_recovery_claim: Unsupported quantitative claim",
            artifactPaths: makeRecoveryArtifacts("region-0001"),
            criterion: "geometry",
            diagnostics: {
              code: "unsupported_quantitative",
              message: "Unsupported quantitative claim",
              offendingExcerpt: "Changed by 2107px²",
              quantitative: {
                offendingValue: 2107,
                offendingUnit: "px²",
                supportedMeasurements: [{ name: "changed_pixel_count", value: 500, unit: "pixels" }]
              }
            },
            candidateTitle: "geometry in recovered region: Button",
            candidateEvidence: ["evidence text"]
          }
        },
        {
          id: "region-0002",
          box: { x: 200, y: 200, width: 50, height: 50 },
          pixelCount: 300,
          sourceComponentIds: ["comp-2"],
          state: "unresolved",
          coveringFindingIds: [],
          artifactPaths: makeRecoveryArtifacts("region-0002"),
          unresolvedDetail: "unsupported_recovery_claim: Unsupported absence claim",
          blockingRecoveryOutcome: {
            regionId: "region-0002",
            state: "unresolved",
            reason: "unsupported_recovery_claim: Unsupported absence claim",
            artifactPaths: makeRecoveryArtifacts("region-0002"),
            criterion: "presence",
            diagnostics: {
              code: "unsupported_absence",
              message: "Unsupported global absence claim",
              offendingExcerpt: "The actual screenshot is entirely black."
            }
          }
        }
      ],
      coverageTrace: []
    };
    const unresolved = unresolvedRegionsFromLedger(ledger, "not_classified");
    expect(unresolved).toHaveLength(2);

    // Both have diagnostics
    for (const region of unresolved) {
      expect(region.diagnostics).toBeDefined();
      expect(region.diagnostics?.code).toBeDefined();
      expect(["unsupported_quantitative", "unsupported_absence"]).toContain(region.diagnostics?.code);
    }

    // Both have all five persisted recovery artifacts
    for (const region of unresolved) {
      expect(region.artifactPaths).toHaveLength(5);
      const roles = region.artifactPaths.map(a => a.role).sort();
      expect(roles).toEqual(RECOVERY_ROLES.sort());
    }

    // Recovery summary accounting: unclassifiedCount should be >= 2
    const unclassifiedCount = unresolved.length;
    expect(unclassifiedCount).toBeGreaterThanOrEqual(2);
  });

  it("explicit supersession for one of two unsupported outcomes is traceable", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 2,
      belowThresholdCount: 0,
      regions: [
        {
          id: "region-0001",
          box: { x: 10, y: 10, width: 80, height: 60 },
          pixelCount: 500,
          sourceComponentIds: ["comp-1"],
          state: "covered",
          coveringFindingIds: ["diff-superseding"],
          artifactPaths: makeRecoveryArtifacts("region-0001"),
          unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
          blockingRecoveryOutcome: {
            regionId: "region-0001",
            state: "unresolved",
            reason: "unsupported_recovery_claim: Unsupported quantitative claim",
            artifactPaths: makeRecoveryArtifacts("region-0001"),
            criterion: "geometry",
            diagnostics: {
              code: "unsupported_quantitative",
              message: "Unsupported quantitative claim"
            }
          },
          supersessionDetail: {
            supersedingFindingId: "diff-superseding",
            reason: "same_criterion_acceptance_overlap",
            overlapRatio: 0.95
          }
        },
        {
          id: "region-0002",
          box: { x: 200, y: 200, width: 50, height: 50 },
          pixelCount: 300,
          sourceComponentIds: ["comp-2"],
          state: "unresolved",
          coveringFindingIds: [],
          artifactPaths: makeRecoveryArtifacts("region-0002"),
          unresolvedDetail: "unsupported_recovery_claim: Unsupported absence claim",
          blockingRecoveryOutcome: {
            regionId: "region-0002",
            state: "unresolved",
            reason: "unsupported_recovery_claim: Unsupported absence claim",
            artifactPaths: makeRecoveryArtifacts("region-0002"),
            criterion: "presence",
            diagnostics: {
              code: "unsupported_absence",
              message: "Unsupported global absence claim"
            }
          }
        }
      ],
      coverageTrace: []
    };
    const unresolved = unresolvedRegionsFromLedger(ledger, "not_classified");
    // Only non-superseded region appears
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.id).toBe("region-0002");
    expect(unresolved[0]!.reason).toBe("unsupported_recovery_claim");
    expect(unresolved[0]!.diagnostics?.code).toBe("unsupported_absence");
  });
});

describe("recovery trace: unsupported entries have all five persisted recovery roles", () => {
  it("each non-superseded unsupported trace entry has diagnostics and five persisted recovery artifacts", () => {
    const traces: Partial<RecoveryComponentTrace>[] = [
      {
        componentId: "region-0001",
        rank: 0,
        componentBox: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        status: "unsupported_recovery_claim",
        candidateTitle: "geometry in recovered region: Button",
        candidateEvidence: ["element visibly shifted"],
        candidateMeasurements: [{ name: "changed_pixel_count", value: 500, unit: "pixels" }],
        claimValidationDiagnostics: {
          code: "unsupported_quantitative",
          message: "Unsupported quantitative claim"
        },
        artifactPaths: makeRecoveryArtifacts("region-0001"),
        criterion: "geometry"
      },
      {
        componentId: "region-0002",
        rank: 1,
        componentBox: { x: 200, y: 200, width: 50, height: 50 },
        pixelCount: 300,
        status: "unsupported_recovery_claim",
        candidateTitle: "presence in recovered region: Icon",
        candidateEvidence: ["icon missing"],
        claimValidationDiagnostics: {
          code: "unsupported_absence",
          message: "Unsupported global absence claim"
        },
        artifactPaths: makeRecoveryArtifacts("region-0002"),
        criterion: "presence"
      }
    ];
    for (const trace of traces) {
      const parsed = RecoveryComponentTraceSchema.parse(trace);
      expect(parsed.status).toBe("unsupported_recovery_claim");
      expect(parsed.claimValidationDiagnostics).toBeDefined();
      expect(parsed.artifactPaths).toHaveLength(5);
      const roles = parsed.artifactPaths.map(a => a.role).sort();
      expect(roles).toEqual(RECOVERY_ROLES.sort());
      expect(parsed.candidateTitle).toBeDefined();
      expect(parsed.candidateEvidence).toBeDefined();
      expect(parsed.criterion).toBeDefined();
    }
  });
});

describe("validateClaim: first unsupported quantitative after supported claim", () => {
  it("reports 2107/px when evidence has supported 500 pixels first", () => {
    const diff = makeDiff({
      evidence: ["The button is 500 pixels wide. Changed region measures 2107px. The background is different."],
      measurements: [
        { name: "button_width", value: 500, unit: "pixels" },
        { name: "region_area", value: 4800, unit: "px" }
      ]
    });
    const result = validateClaim(diff);
    expect(result.valid).toBe(false);
    expect(result.diagnostics!.code).toBe("unsupported_quantitative");
    expect(result.diagnostics!.quantitative!.offendingValue).toBe(2107);
    expect(result.diagnostics!.offendingExcerpt).toContain("2107");
  });
});

describe("validateClaim: excerpt windows around offender even after 250 chars", () => {
  it("excerpt contains offender when it appears after 250 chars", () => {
    const padding = "A".repeat(260);
    const diff = makeDiff({
      title: "Test",
      evidence: [padding + " Changed region measures 2107px. Background different."],
      measurements: [{ name: "button_width", value: 500, unit: "pixels" }]
    });
    const result = validateClaim(diff);
    expect(result.valid).toBe(false);
    expect(result.diagnostics!.offendingExcerpt).toBeDefined();
    expect(result.diagnostics!.offendingExcerpt!.length).toBeLessThanOrEqual(200);
    expect(result.diagnostics!.offendingExcerpt).toContain("2107");
  });

  it("keeps an unsupported absence phrase in the bounded excerpt after 250 chars", () => {
    const padding = "A".repeat(260);
    const diff = makeDiff({
      title: "Test",
      evidence: [padding + " The actual screenshot is entirely blank."],
      measurements: []
    });
    const result = validateClaim(diff);
    expect(result.diagnostics?.code).toBe("unsupported_absence");
    expect(result.diagnostics?.offendingExcerpt).toContain("entirely blank");
    expect(result.diagnostics?.offendingExcerpt?.length).toBeLessThanOrEqual(200);
  });

  it("keeps an unsupported crop phrase in the bounded excerpt after 250 chars", () => {
    const padding = "A".repeat(260);
    const diff = makeDiff({
      title: "Test",
      evidence: [padding + " The left half of the image is cut off."],
      measurements: []
    });
    const result = validateClaim(diff);
    expect(result.diagnostics?.code).toBe("unsupported_crop_boundary");
    expect(result.diagnostics?.offendingExcerpt).toContain("left half");
    expect(result.diagnostics?.offendingExcerpt?.length).toBeLessThanOrEqual(200);
  });
});

describe("applyFindingCoverage: rejected same-criterion finding does not supersede", () => {
  it("does NOT supersede when superseding finding has rejected reviewerStatus", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1, belowThresholdCount: 0,
      regions: [{
        id: "region-0001", box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500, sourceComponentIds: ["comp-1"], state: "unresolved" as const,
        coveringFindingIds: [], artifactPaths: [],
        unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
        blockingRecoveryOutcome: {
          regionId: "region-0001", state: "unresolved" as const,
          reason: "unsupported_recovery_claim: Unsupported quantitative claim",
          artifactPaths: makeRecoveryArtifacts("region-0001"),
          criterion: "geometry" as const,
          diagnostics: { code: "unsupported_quantitative" as const, message: "test" }
        }
      }], coverageTrace: []
    };
    const rejectedFinding: DiffRecord = {
      id: "diff-rejected", criterion: "geometry", severity: "medium",
      title: "Geometry changed", location: { x: 10, y: 10, width: 80, height: 58 },
      evidence: ["Geometry differs"], measurements: [], artifactPaths: [],
      reviewerStatus: "rejected"
    };
    applyFindingCoverage(ledger, [rejectedFinding]);
    expect(ledger.regions[0]!.state).toBe("unresolved");
    expect(ledger.regions[0]!.supersessionDetail).toBeUndefined();
  });
});

describe("applyFindingCoverage: not_reviewed same-criterion finding does not supersede", () => {
  it("does NOT supersede when superseding finding has not_reviewed reviewerStatus", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1, belowThresholdCount: 0,
      regions: [{
        id: "region-0001", box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500, sourceComponentIds: ["comp-1"], state: "unresolved" as const,
        coveringFindingIds: [], artifactPaths: [],
        unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
        blockingRecoveryOutcome: {
          regionId: "region-0001", state: "unresolved" as const,
          reason: "unsupported_recovery_claim: Unsupported quantitative claim",
          artifactPaths: makeRecoveryArtifacts("region-0001"),
          criterion: "geometry" as const,
          diagnostics: { code: "unsupported_quantitative" as const, message: "test" }
        }
      }], coverageTrace: []
    };
    const unreviewedFinding: DiffRecord = {
      id: "diff-not-reviewed", criterion: "geometry" as const, severity: "medium",
      title: "Geometry changed", location: { x: 10, y: 10, width: 80, height: 58 },
      evidence: ["Geometry differs"], measurements: [], artifactPaths: [],
      reviewerStatus: "not_reviewed", classificationSource: "deterministic_geometry"
    };
    applyFindingCoverage(ledger, [unreviewedFinding]);
    expect(ledger.regions[0]!.state).toBe("unresolved");
    expect(ledger.regions[0]!.supersessionDetail).toBeUndefined();
  });
});

describe("reconciliation: superseded unsupported does not remain blocker", () => {
  it("one superseded + one remaining means one final unresolved", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 2, belowThresholdCount: 0,
      regions: [
        {
          id: "region-0001", box: { x: 10, y: 10, width: 80, height: 60 },
          pixelCount: 500, sourceComponentIds: ["comp-1"], state: "unresolved" as const,
          coveringFindingIds: [], artifactPaths: makeRecoveryArtifacts("region-0001"),
          unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
          blockingRecoveryOutcome: {
            regionId: "region-0001", state: "unresolved" as const,
            reason: "unsupported_recovery_claim: Unsupported quantitative claim",
            artifactPaths: makeRecoveryArtifacts("region-0001"),
            criterion: "geometry" as const,
            diagnostics: { code: "unsupported_quantitative" as const, message: "test" }
          }
        },
        {
          id: "region-0002", box: { x: 200, y: 200, width: 50, height: 50 },
          pixelCount: 300, sourceComponentIds: ["comp-2"], state: "unresolved" as const,
          coveringFindingIds: [], artifactPaths: makeRecoveryArtifacts("region-0002"),
          unresolvedDetail: "unsupported_recovery_claim: Unsupported absence claim",
          blockingRecoveryOutcome: {
            regionId: "region-0002", state: "unresolved" as const,
            reason: "unsupported_recovery_claim: Unsupported absence claim",
            artifactPaths: makeRecoveryArtifacts("region-0002"),
            criterion: "presence" as const,
            diagnostics: { code: "unsupported_absence" as const, message: "test" }
          }
        }
      ], coverageTrace: []
    };
    applyFindingCoverage(ledger, [{
      id: "diff-super", criterion: "geometry" as const, severity: "medium",
      title: "Geometry changed", location: { x: 10, y: 10, width: 80, height: 58 },
      evidence: ["Geometry differs"], measurements: [], artifactPaths: [],
      reviewerStatus: "accepted"
    }]);
    const unresolved = unresolvedRegionsFromLedger(ledger, "not_classified");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.id).toBe("region-0002");
    expect(ledger.regions[0]!.supersessionDetail).toBeDefined();
    expect(ledger.regions[0]!.supersessionDetail!.supersedingFindingId).toBe("diff-super");
  });

  it("visual classification can complete only when final count and regions are zero", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1, belowThresholdCount: 0,
      regions: [{
        id: "region-0001", box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500, sourceComponentIds: ["comp-1"], state: "unresolved" as const,
        coveringFindingIds: [], artifactPaths: makeRecoveryArtifacts("region-0001"),
        unresolvedDetail: "unsupported_recovery_claim: Unsupported quantitative claim",
        blockingRecoveryOutcome: {
          regionId: "region-0001", state: "unresolved" as const,
          reason: "unsupported_recovery_claim: Unsupported quantitative claim",
          artifactPaths: makeRecoveryArtifacts("region-0001"),
          criterion: "geometry" as const,
          diagnostics: { code: "unsupported_quantitative" as const, message: "test" }
        }
      }], coverageTrace: []
    };
    expect(unresolvedRegionsFromLedger(ledger, "not_classified")).toHaveLength(1);
    applyFindingCoverage(ledger, [{
      id: "diff-super", criterion: "geometry" as const, severity: "medium",
      title: "Geometry changed", location: { x: 10, y: 10, width: 80, height: 58 },
      evidence: ["Geometry differs"], measurements: [], artifactPaths: [],
      reviewerStatus: "accepted"
    }]);
    expect(unresolvedRegionsFromLedger(ledger, "not_classified")).toHaveLength(0);
  });
});

describe("release gate: recovery accounting with supersession metadata", () => {
  it("supersession fields on trace are serializable and auditable", () => {
    const trace = RecoveryComponentTraceSchema.parse({
      componentId: "region-0001", rank: 0,
      componentBox: { x: 10, y: 10, width: 80, height: 60 },
      pixelCount: 500, status: "unsupported_recovery_claim",
      criterion: "geometry",
      claimValidationDiagnostics: { code: "unsupported_quantitative", message: "test" },
      artifactPaths: makeRecoveryArtifacts("region-0001"),
      supersededByFindingId: "diff-super",
      supersessionReason: "same_criterion_acceptance_overlap",
      supersessionOverlapRatio: 0.95
    });
    expect(trace.supersededByFindingId).toBe("diff-super");
    expect(trace.supersessionReason).toBe("same_criterion_acceptance_overlap");
    expect(trace.supersessionOverlapRatio).toBe(0.95);
  });
});

describe("annotateRecoveryTraceSupersessions", () => {
  it("annotates matching rejected and unsupported recovery traces without mutating inputs", () => {
    const ledger: RegionLedger = {
      rawComponentCount: 1,
      belowThresholdCount: 0,
      regions: [{
        id: "region-0001",
        box: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        sourceComponentIds: ["component-0001"],
        state: "covered",
        coveringFindingIds: ["diff-accepted"],
        artifactPaths: [],
        supersessionDetail: {
          supersedingFindingId: "diff-accepted",
          reason: "same_criterion_acceptance_overlap",
          overlapRatio: 0.95
        }
      }],
      coverageTrace: []
    };
    const trace: RecoveryComponentTrace[] = [
      {
        componentId: "region-0001",
        rank: 0,
        componentBox: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        status: "unsupported_recovery_claim",
        criterion: "geometry",
        artifactPaths: makeRecoveryArtifacts("region-0001")
      },
      {
        componentId: "region-0001",
        rank: 1,
        componentBox: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        status: "recovery_rejected",
        criterion: "geometry",
        artifactPaths: []
      },
      {
        componentId: "region-0002",
        rank: 2,
        componentBox: { x: 10, y: 10, width: 80, height: 60 },
        pixelCount: 500,
        status: "unsupported_recovery_claim",
        criterion: "geometry",
        artifactPaths: makeRecoveryArtifacts("region-0002")
      }
    ];

    const annotated = annotateRecoveryTraceSupersessions(ledger, trace);

    expect(annotated).not.toBe(trace);
    expect(annotated[0]).toMatchObject({
      supersededByFindingId: "diff-accepted",
      supersessionReason: "same_criterion_acceptance_overlap",
      supersessionOverlapRatio: 0.95
    });
    expect(annotated[1]).toMatchObject({
      supersededByFindingId: "diff-accepted",
      supersessionReason: "same_criterion_acceptance_overlap",
      supersessionOverlapRatio: 0.95
    });
    expect(annotated[2]?.supersededByFindingId).toBeUndefined();
    expect(trace[0]?.supersededByFindingId).toBeUndefined();
    expect(trace[1]?.supersededByFindingId).toBeUndefined();
  });
});

describe("validateClaim: px² area measurement aliased to pixels in prose", () => {
  it("accepts prose '7614 pixels' when region_area_pixels=7614 px²", () => {
    const diff = makeDiff({
      evidence: ["2809/7614 pixels (36.89%) differ"],
      measurements: [
        { name: "changed_pixel_count", value: 2809, unit: "pixels" },
        { name: "region_area_pixels", value: 7614, unit: "px²" },
        { name: "changed_pixel_percent", value: 36.89, unit: "%" }
      ]
    });
    const result = validateClaim(diff);
    expect(result).toEqual({ valid: true });
  });

  it("rejects a different area value stated as pixels even with a px² measurement present", () => {
    const diff = makeDiff({
      evidence: ["9999 pixels differ"],
      measurements: [
        { name: "changed_pixel_count", value: 2809, unit: "pixels" },
        { name: "region_area_pixels", value: 7614, unit: "px²" }
      ]
    });
    const result = validateClaim(diff);
    expect(result.valid).toBe(false);
    expect(result.diagnostics!.code).toBe("unsupported_quantitative");
  });

  it("does NOT alias retry_count with px² to pixels in prose", () => {
    const diff = makeDiff({
      evidence: ["7614 pixels differ"],
      measurements: [
        { name: "retry_count", value: 7614, unit: "px²" }
      ]
    });
    const result = validateClaim(diff);
    expect(result.valid).toBe(false);
    expect(result.diagnostics!.code).toBe("unsupported_quantitative");
    expect(result.diagnostics!.quantitative!.offendingValue).toBe(7614);
    expect(result.diagnostics!.quantitative!.offendingUnit).toBe("pixels");
  });

  it("does NOT alias sample_count with px² to pixels in prose", () => {
    const diff = makeDiff({
      evidence: ["7614 pixels differ"],
      measurements: [
        { name: "sample_count", value: 7614, unit: "px²" }
      ]
    });
    const result = validateClaim(diff);
    expect(result.valid).toBe(false);
    expect(result.diagnostics!.code).toBe("unsupported_quantitative");
  });

  it("accepts prose '7614 pixels' when componentArea=7614 px²", () => {
    const diff = makeDiff({
      evidence: ["7614 pixels differ in the component"],
      measurements: [
        { name: "componentArea", value: 7614, unit: "px²" }
      ]
    });
    const result = validateClaim(diff);
    expect(result).toEqual({ valid: true });
  });
});

describe("validateClaim: approximate qualifier rounding (regression run-1784120538636-00ab5b)", () => {
  it("accepts 'approximately 46%' when changed_pixel_percent=45.96", () => {
    const diff = makeDiff({
      evidence: ["The pixel-diff mask confirms substantial visual changes across approximately 46% of the region"],
      measurements: [{ name: "changed_pixel_percent", value: 45.96, unit: "%" }]
    });
    const result = validateClaim(diff);
    expect(result).toEqual({ valid: true });
  });

  it("rejects bare '46%' with 45.96% (no qualifier means exact match required)", () => {
    const diff = makeDiff({
      evidence: ["Visual changes across 46% of the region"],
      measurements: [{ name: "changed_pixel_percent", value: 45.96, unit: "%" }]
    });
    const result = validateClaim(diff);
    expect(result).toMatchObject({ valid: false, diagnostics: { code: "unsupported_quantitative" } });
  });

  it("rejects 'approximately 47%' with 45.96% (rounded mismatch)", () => {
    const diff = makeDiff({
      evidence: ["Visual changes across approximately 47% of the region"],
      measurements: [{ name: "changed_pixel_percent", value: 45.96, unit: "%" }]
    });
    const result = validateClaim(diff);
    expect(result).toMatchObject({ valid: false, diagnostics: { code: "unsupported_quantitative" } });
  });

  it("rejects approximate qualifier when units differ", () => {
    const diff = makeDiff({
      evidence: ["The region measures approximately 46px wide"],
      measurements: [{ name: "changed_pixel_percent", value: 45.96, unit: "%" }]
    });
    const result = validateClaim(diff);
    expect(result).toMatchObject({ valid: false, diagnostics: { code: "unsupported_quantitative" } });
  });

  it("accepts 'approximately 46.0%' with 45.96% (decimal precision controls rounding)", () => {
    const diff = makeDiff({
      evidence: ["Visual changes across approximately 46.0% of the region"],
      measurements: [{ name: "changed_pixel_percent", value: 45.96, unit: "%" }]
    });
    const result = validateClaim(diff);
    expect(result).toEqual({ valid: true });
  });

  it("rejects 'approximately 45.9%' with 45.96% (rounds to 46.0, not 45.9)", () => {
    const diff = makeDiff({
      evidence: ["Visual changes across approximately 45.9% of the region"],
      measurements: [{ name: "changed_pixel_percent", value: 45.96, unit: "%" }]
    });
    const result = validateClaim(diff);
    expect(result).toMatchObject({ valid: false, diagnostics: { code: "unsupported_quantitative" } });
  });

  it("qualifier does not bless a later unrelated number in a different sentence", () => {
    const diff = makeDiff({
      evidence: ["Changes across approximately 46% of the region. The button is 100px wide."],
      measurements: [{ name: "changed_pixel_percent", value: 45.96, unit: "%" }]
    });
    const result = validateClaim(diff);
    expect(result).toMatchObject({ valid: false, diagnostics: { code: "unsupported_quantitative" } });
  });

  it("accepts 'about 46%' with 45.96%", () => {
    const diff = makeDiff({
      evidence: ["Visual changes across about 46% of the region"],
      measurements: [{ name: "changed_pixel_percent", value: 45.96, unit: "%" }]
    });
    const result = validateClaim(diff);
    expect(result).toEqual({ valid: true });
  });

  it("accepts '~46%' with 45.96%", () => {
    const diff = makeDiff({
      evidence: ["Visual changes across ~46% of the region"],
      measurements: [{ name: "changed_pixel_percent", value: 45.96, unit: "%" }]
    });
    const result = validateClaim(diff);
    expect(result).toEqual({ valid: true });
  });
});
