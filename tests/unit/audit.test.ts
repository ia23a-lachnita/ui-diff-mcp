import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { rubrics, selectTriggeredCriteria } from "../../src/audit/criteria.js";
import { buildAuditorPrompt, buildRecoveryPrompt, buildReviewerPrompt } from "../../src/audit/prompts.js";
import { auditElementPair } from "../../src/audit/audit-target.js";
import { reviewAndMergeFindings, hasUnsupportedCropBoundaryClaim } from "../../src/audit/review-findings.js";
import { UiCriterionSchema } from "../../src/schemas/core.js";
import type { ElementPair, UiElement, DiffRecord } from "../../src/schemas/core.js";
import type { VisionJsonCaller } from "../../src/models/vision-json.js";
import { RouteExhaustedError } from "../../src/models/fallback-caller.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";
import { summarizeAuditPairOutcomes } from "../../src/debug/run-debug.js";
import { createUniformContainImagePairTransform } from "../../src/images/coordinates.js";
import { computeComparisonSpaceDelta } from "../../src/images/comparison-geometry.js";

// Creates an RGBA buffer with 2-row white/blue stripes — produces real edges so
// the content-based projected-mismatch logic can distinguish it from a solid actual.
function makeStripedRgba(width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const isWhiteRow = Math.floor(y / 2) % 2 === 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (isWhiteRow) {
        data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
      } else {
        data[i] = 0; data[i + 1] = 0; data[i + 2] = 255; data[i + 3] = 255;
      }
    }
  }
  return data;
}

describe("criteria rubrics", () => {
  it("has a rubric for every criterion", () => {
    for (const criterion of UiCriterionSchema.options) {
      expect(rubrics[criterion]).toBeDefined();
      expect(rubrics[criterion]?.jsonSchema).toBeDefined();
    }
  });
});

describe("audit pair accounting", () => {
  it("separates selected, provider-called, valid, reviewed, skipped, and failed pairs", () => {
    const scope = summarizeAuditPairOutcomes([
      { pairId: "no-trigger", entered: true, providerCalled: false, validAuditor: false, reviewed: false, skippedNoTrigger: true, failed: false },
      { pairId: "reviewed", entered: true, providerCalled: true, validAuditor: true, reviewed: true, skippedNoTrigger: false, failed: false },
      { pairId: "exhausted", entered: true, providerCalled: true, validAuditor: false, reviewed: false, skippedNoTrigger: false, failed: true }
    ], { totalPairs: 3, auditLimited: false, stoppedReason: "route_exhausted" });

    expect(scope).toMatchObject({
      selectedPairs: 3,
      enteredPairs: 3,
      providerCalledPairs: 2,
      validAuditorPairs: 1,
      reviewedPairs: 1,
      failedPairs: 1,
      skippedNoTriggeredPairs: 1,
      stoppedReason: "route_exhausted"
    });
  });
});

describe("selectTriggeredCriteria", () => {
  it("triggers geometry for a shifted button", () => {
    const criteria = selectTriggeredCriteria({
      pairingStatus: "matched",
      positionDeltaPx: 15,
      geometryDeltaPx: 15,
      comparisonComparable: true,
      textDelta: false,
      colorDelta: false,
      edgeMismatch: false,
      overlapDetected: false,
      stateWordsDiffer: false,
      elementType: "button",
      measurements: []
    });
    expect(criteria).toContain("geometry");
    expect(criteria).not.toContain("typography_content");
  });

  it("triggers typography_content for changed label text", () => {
    const criteria = selectTriggeredCriteria({
      pairingStatus: "matched",
      positionDeltaPx: 0,
      geometryDeltaPx: 0,
      comparisonComparable: true,
      textDelta: true,
      colorDelta: false,
      edgeMismatch: false,
      overlapDetected: false,
      stateWordsDiffer: false,
      elementType: "text",
      measurements: []
    });
    expect(criteria).toContain("typography_content");
  });

  it("triggers presence for missing element", () => {
    const criteria = selectTriggeredCriteria({
      pairingStatus: "missing",
      positionDeltaPx: 0,
      geometryDeltaPx: 0,
      comparisonComparable: true,
      textDelta: false,
      colorDelta: false,
      edgeMismatch: false,
      overlapDetected: false,
      stateWordsDiffer: false,
      elementType: "button",
      measurements: []
    });
    expect(criteria).toContain("presence");
  });
});

describe("prompt builders", () => {
  it("spells out the exact auditor JSON keys and forbids provider-invented aliases", () => {
    const prompt = buildAuditorPrompt({
      criterion: "geometry",
      rubric: rubrics.geometry,
      elementLabel: "Nutrition ring",
      elementType: "chart",
      pairingStatus: "matched",
      measurements: []
    });
    expect(prompt).toContain('"hasDiff": false');
    expect(prompt).toContain('"evidence": ["visible qualitative observation"]');
    expect(prompt).toContain("Do not return determination or reasoning keys");
  });

  it("keeps recovery semantic and does not ask for unavailable screen coordinates", () => {
    const prompt = buildRecoveryPrompt(200, 500);
    expect(prompt).not.toContain("coordinateFrame");
    expect(prompt).not.toContain('"box"');
    expect(prompt).toContain('"evidence": ["visible qualitative observation"]');
    expect(prompt).toContain("The deterministic region already provides the screen location");
  });

  it("passes deterministic recovery measurements to recovery prompts", () => {
    const measurements = [
      { name: "changed_pixel_count", value: 500, unit: "pixels" },
      { name: "region_area_pixels", value: 4800, unit: "px²" },
      { name: "changed_pixel_percent", value: 10.42, unit: "%" },
      { name: "coordinateSource", value: "deterministic_pixel_component" }
    ];
    const recoveryPrompt = buildRecoveryPrompt(500, 4800, measurements);
    const reviewerPrompt = buildReviewerPrompt("geometry", "Button", "Button shifted", ["visible shift"], measurements);
    for (const prompt of [recoveryPrompt, reviewerPrompt]) {
      expect(prompt).toContain("DETERMINISTIC MEASUREMENTS:");
      expect(prompt).toContain("changed_pixel_count: 500 pixels");
      expect(prompt).toContain("region_area_pixels: 4800 px²");
      expect(prompt).toContain("changed_pixel_percent: 10.42 %");
      expect(prompt).toContain("coordinateSource: deterministic_pixel_component");
    }
  });

  it("auditor prompt does not contain code-edit advice", () => {
    const prompt = buildAuditorPrompt({
      criterion: "geometry",
      rubric: rubrics["geometry"],
      elementLabel: "Submit Button",
      elementType: "button",
      pairingStatus: "matched",
      measurements: [{ name: "yDelta", value: 15, unit: "px" }]
    });
    expect(prompt).not.toMatch(/fix the code|fix the bug|implement this|change the code|update the component|edit the/i);
    expect(prompt).toContain("EXPECTED");
    expect(prompt).toContain("ACTUAL");
  });

  it("reviewer prompt instructs accept/reject/needs_escalation only", () => {
    const prompt = buildReviewerPrompt(
      "geometry",
      "Submit Button",
      "Button is lower than expected",
      ["actual y=45px, expected y=30px"]
    );
    expect(prompt).toContain("accepted");
    expect(prompt).toContain("rejected");
    expect(prompt).toContain("needs_escalation");
    expect(prompt).not.toMatch(/fix|implement|change the/i);
  });
});

describe("auditElementPair", () => {
  it("rejects invalid crop evidence before calling an auditor", async () => {
    const auditorCaller: VisionJsonCaller = vi.fn();
    const result = await auditElementPair(pair, makeAuditContext({
      auditorCaller,
      expectedElements: [{ ...expectedEl, box: { x: 199, y: 199, width: 1, height: 1 } }]
    }));

    expect(auditorCaller).not.toHaveBeenCalled();
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "reviewer_rejected", rejectionReason: "evidence_crop_rejected: below_minimum_artifact_size" })
    ]));
  });

  it("records a non-comparable matched pair without calling a provider", async () => {
    const auditorCaller: VisionJsonCaller = vi.fn();
    const reviewerCaller: VisionJsonCaller = vi.fn();
    const context = makeAuditContext({ auditorCaller, reviewerCaller });
    const result = await auditElementPair(pair, {
      ...context,
      triggerCtx: {
        ...context.triggerCtx,
        comparisonComparable: false
      }
    });

    expect(auditorCaller).not.toHaveBeenCalled();
    expect(reviewerCaller).not.toHaveBeenCalled();
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.trace).toEqual([
      expect.objectContaining({
        criterion: "geometry",
        status: "comparison_non_comparable",
        skipReason: "no_comparable_intersection",
        rejectionReason: "no_comparable_intersection"
      })
    ]);
  });
  let tmpDir: string;
  let grayPng: string;

  const expectedEl: UiElement = {
    id: "e1",
    label: "Submit Button",
    type: "button",
    box: { x: 10, y: 50, width: 80, height: 40 },
    normalizedBox: { x: 0.05, y: 0.125, width: 0.4, height: 0.1 },
    confidence: 0.95,
    source: "locator",
    childIds: []
  };

  const pair: ElementPair = {
    id: "pair-1",
    expectedId: "e1",
    actualId: "a1",
    status: "matched",
    score: 0.8,
    reasons: []
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-audit-"));
    grayPng = await writeSolidPng(tmpDir, "gray.png", 200, 400, 128, 128, 128);
  });

  function makeAuditContext(overrides: {
    auditorCaller?: VisionJsonCaller;
    reviewerCaller?: VisionJsonCaller;
    positionDeltaPx?: number;
    geometryDeltaPx?: number;
    expectedElements?: UiElement[];
  } = {}) {
    const auditorCaller: VisionJsonCaller = overrides.auditorCaller ?? vi.fn().mockResolvedValue({
      parsed: { hasDiff: false },
      rawContent: "",
      model: "default-auditor",
      provider: "nvidia"
    });
    const reviewerCaller: VisionJsonCaller = overrides.reviewerCaller ?? vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "default-reviewer",
      provider: "nvidia"
    });
    return {
      expectedImagePath: grayPng,
      actualImagePath: grayPng,
      expectedElements: overrides.expectedElements ?? [expectedEl],
      actualElements: [{ ...expectedEl, id: "a1", box: { x: 10, y: 50 + (overrides.positionDeltaPx ?? 0), width: 80, height: 40 } }],
      artifactDir: tmpDir,
      auditorCaller,
      reviewerCaller,
      expectedRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      actualRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      measurements: [],
      auditIndex: 1,
      auditTotal: 1,
      elementSlug: "submit-button",
      triggerCtx: {
        pairingStatus: "matched" as const,
        positionDeltaPx: overrides.positionDeltaPx ?? 0,
        geometryDeltaPx: overrides.geometryDeltaPx ?? overrides.positionDeltaPx ?? 0,
        comparisonComparable: true,
        textDelta: false,
        colorDelta: false,
        edgeMismatch: false,
        overlapDetected: false,
        stateWordsDiffer: false,
        elementType: "button" as const,
        measurements: []
      }
    };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns accepted diff when auditor and reviewer agree", async () => {
    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { hasDiff: true, severity: "high", title: "Button shifted down", evidence: ["The actual button is visibly lower than the expected button."] },
      rawContent: "",
      model: "test-auditor",
      provider: "openrouter"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "Visual shift confirmed in both images" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });

    const result = await auditElementPair(pair, {
      expectedImagePath: grayPng,
      actualImagePath: grayPng,
      expectedElements: [expectedEl],
      actualElements: [{ ...expectedEl, id: "a1", box: { x: 10, y: 65, width: 80, height: 40 } }],
      artifactDir: tmpDir,
      auditorCaller,
      reviewerCaller,
      expectedRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      actualRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      measurements: [],
      auditIndex: 1,
      auditTotal: 1,
      elementSlug: "submit-button",
      triggerCtx: {
        pairingStatus: "matched",
        positionDeltaPx: 15,
        geometryDeltaPx: 15,
        comparisonComparable: true,
        textDelta: false,
        colorDelta: false,
        edgeMismatch: false,
        overlapDetected: false,
        stateWordsDiffer: false,
        elementType: "button",
        measurements: []
      }
    });

    expect(result.accepted.length).toBeGreaterThanOrEqual(1);
    expect(result.accepted[0]?.criterion).toBe("geometry");
    expect(vi.mocked(auditorCaller)).toHaveBeenCalled();
  });

  it("gives reasoning auditors enough output budget to emit structured JSON", async () => {
    const auditorCaller = vi.fn().mockResolvedValue({
      parsed: { hasDiff: false }, rawContent: "", model: "m", provider: "nvidia"
    });

    await auditElementPair(pair, makeAuditContext({ auditorCaller, positionDeltaPx: 15, geometryDeltaPx: 15 }));

    expect(auditorCaller).toHaveBeenCalled();
    expect(auditorCaller.mock.calls[0]?.[0].maxOutputTokens).toBeGreaterThanOrEqual(8192);
  });

  it("records transient all-route exhaustion without aborting later pairs", async () => {
    const auditorCaller = vi.fn().mockRejectedValue(
      new RouteExhaustedError(new Error("all transient routes returned empty content"), false)
    );

    const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, positionDeltaPx: 15, geometryDeltaPx: 15 }));

    expect(result.accepted).toHaveLength(0);
    expect(result.trace.some(entry => entry.status === "auditor_error")).toBe(true);
  });

  it("removes diff when reviewer rejects it", async () => {
    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { hasDiff: true, severity: "low", title: "Minor shift", evidence: ["The actual button appears slightly lower than expected."] },
      rawContent: "",
      model: "test-auditor",
      provider: "openrouter"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "rejected", reason: "Shift is within acceptable tolerance" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });

    const result = await auditElementPair(pair, {
      expectedImagePath: grayPng,
      actualImagePath: grayPng,
      expectedElements: [expectedEl],
      actualElements: [{ ...expectedEl, id: "a1" }],
      artifactDir: tmpDir,
      auditorCaller,
      reviewerCaller,
      expectedRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      actualRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      measurements: [],
      auditIndex: 1,
      auditTotal: 1,
      elementSlug: "submit-button",
      triggerCtx: {
        pairingStatus: "matched",
        positionDeltaPx: 4,
        geometryDeltaPx: 4,
        comparisonComparable: true,
        textDelta: false,
        colorDelta: false,
        edgeMismatch: false,
        overlapDetected: false,
        stateWordsDiffer: false,
        elementType: "button",
        measurements: []
      }
    });

    expect(result.accepted.length).toBe(0);
    expect(result.rejected.length).toBeGreaterThanOrEqual(1);
  });

  it("calls auditor via provider-agnostic caller without touching OpenRouter fetch directly", async () => {
    const nvidiaCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { hasDiff: true, severity: "medium", title: "Color diff", evidence: ["background changed"] },
      rawContent: "",
      model: "moonshotai/kimi-k2.6",
      provider: "nvidia"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "nvidia/nemotron-nano-12b-v2-vl",
      provider: "nvidia"
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const result = await auditElementPair(pair, {
      expectedImagePath: grayPng,
      actualImagePath: grayPng,
      expectedElements: [expectedEl],
      actualElements: [{ ...expectedEl, id: "a1" }],
      artifactDir: tmpDir,
      auditorCaller: nvidiaCaller,
      reviewerCaller,
      expectedRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      actualRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      measurements: [],
      auditIndex: 1,
      auditTotal: 1,
      elementSlug: "submit-button",
      triggerCtx: {
        pairingStatus: "matched",
        positionDeltaPx: 0,
        geometryDeltaPx: 0,
        comparisonComparable: true,
        textDelta: false,
        colorDelta: true,
        edgeMismatch: false,
        overlapDetected: false,
        stateWordsDiffer: false,
        elementType: "button",
        measurements: []
      }
    });

    expect(vi.mocked(nvidiaCaller)).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.accepted.length).toBeGreaterThanOrEqual(1);
    expect(result.accepted[0]?.model).toBe("moonshotai/kimi-k2.6");
  });

  it("creates artifact files with correct naming and includes paths in DiffRecord", async () => {
    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { hasDiff: true, severity: "high", title: "Button shifted down", evidence: ["The actual button is visibly lower than the expected button."] },
      rawContent: "",
      model: "test-auditor",
      provider: "openrouter"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "Visual shift confirmed in both images" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });

    const auditIndex = 5;
    const auditTotal = 10;
    const elementSlug = "submit-button";

    const result = await auditElementPair(pair, {
      expectedImagePath: grayPng,
      actualImagePath: grayPng,
      expectedElements: [expectedEl],
      actualElements: [{ ...expectedEl, id: "a1", box: { x: 10, y: 65, width: 80, height: 40 } }],
      artifactDir: tmpDir,
      auditorCaller,
      reviewerCaller,
      expectedRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      actualRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      measurements: [],
      auditIndex,
      auditTotal,
      elementSlug,
      triggerCtx: {
        pairingStatus: "matched",
        positionDeltaPx: 15,
        geometryDeltaPx: 15,
        comparisonComparable: true,
        textDelta: false,
        colorDelta: false,
        edgeMismatch: false,
        overlapDetected: false,
        stateWordsDiffer: false,
        elementType: "button",
        measurements: []
      }
    });

    expect(result.accepted.length).toBeGreaterThanOrEqual(1);
    const diffRecord = result.accepted[0];
    expect(diffRecord?.artifactPaths).toBeDefined();
    expect(diffRecord?.artifactPaths.length).toBeGreaterThanOrEqual(5); // At least expected, actual, local_pixel_diff_mask, local_directional_overlay, context crop

    const artifactFiles = await fs.readdir(tmpDir);
    const shortId = pair.id.slice(0, 12);
    const expectedBaseName = `audit-${String(auditIndex).padStart(3, "0")}-of-${String(auditTotal).padStart(3, "0")}-pair-${shortId}-${elementSlug}`;

    const expectedCropPath = path.join(tmpDir, `${expectedBaseName}-expected-crop.png`);
    const actualCropPath = path.join(tmpDir, `${expectedBaseName}-actual-crop.png`);
    const localPixelDiffMaskPath = path.join(tmpDir, `${expectedBaseName}-local-pixel-diff-mask.png`);
    const localDirectionalOverlayPath = path.join(tmpDir, `${expectedBaseName}-local-directional-overlay.png`);
    const contextCropPath = path.join(tmpDir, `${expectedBaseName}-context-crop.png`);

    // Verify files exist on disk
    await expect(fs.access(expectedCropPath)).resolves.toBeUndefined();
    await expect(fs.access(actualCropPath)).resolves.toBeUndefined();
    await expect(fs.access(localPixelDiffMaskPath)).resolves.toBeUndefined();
    await expect(fs.access(localDirectionalOverlayPath)).resolves.toBeUndefined();
    await expect(fs.access(contextCropPath)).resolves.toBeUndefined();

    // Verify paths are in artifactPaths with correct roles
    expect(diffRecord?.artifactPaths).toContainEqual(expect.objectContaining({ role: "expected_crop", path: expectedCropPath, pairId: pair.id }));
    expect(diffRecord?.artifactPaths).toContainEqual(expect.objectContaining({ role: "actual_crop", path: actualCropPath, pairId: pair.id }));
    expect(diffRecord?.artifactPaths).toContainEqual(expect.objectContaining({ role: "local_pixel_diff_mask", path: localPixelDiffMaskPath, pairId: pair.id }));
    expect(diffRecord?.artifactPaths).toContainEqual(expect.objectContaining({ role: "local_directional_overlay", path: localDirectionalOverlayPath, pairId: pair.id }));
    expect(diffRecord?.artifactPaths).toContainEqual(expect.objectContaining({ role: "context_crop", path: contextCropPath, pairId: pair.id }));

    // Optional: Verify dimensions of one crop
    const metadata = await sharp(expectedCropPath).metadata();
    expect(metadata.width).toBe(expectedEl.box.width);
    expect(metadata.height).toBe(expectedEl.box.height);
  });

  it("records auditor_no_diff when model returns hasDiff false", async () => {
    const auditorCaller = vi.fn().mockResolvedValue({ parsed: { hasDiff: false }, rawContent: "", model: "audit-model", provider: "nvidia" });
    const reviewerCaller = vi.fn();
    const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, reviewerCaller, positionDeltaPx: 15, geometryDeltaPx: 15 }));
    expect(result.accepted).toHaveLength(0);
    expect(result.trace.some(t => t.status === "auditor_no_diff" && t.model === "audit-model")).toBe(true);
    expect(reviewerCaller).not.toHaveBeenCalled();
  });

  it("records empty_evidence when hasDiff true has no evidence", async () => {
    const auditorCaller = vi.fn().mockResolvedValue({ parsed: { hasDiff: true, title: "Bad" }, rawContent: "", model: "audit-model", provider: "nvidia" });
    const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, positionDeltaPx: 15, geometryDeltaPx: 15 }));
    expect(result.trace.some(t => t.status === "empty_evidence")).toBe(true);
  });

  it("records reviewer_rejected with reason", async () => {
    const result = await auditElementPair(pair, makeAuditContext({
      auditorCaller: vi.fn().mockResolvedValue({ parsed: { hasDiff: true, evidence: ["visible"], title: "Shift" }, rawContent: "", model: "audit-model", provider: "nvidia" }),
      reviewerCaller: vi.fn().mockResolvedValue({ parsed: { decision: "rejected", reason: "not supported" }, rawContent: "", model: "review-model", provider: "nvidia" }),
      positionDeltaPx: 15,
      geometryDeltaPx: 15
    }));
    expect(result.trace.some(t => t.status === "reviewer_rejected" && t.rejectionReason === "not supported")).toBe(true);
  });

  it("persists reviewer reason on final accepted and escalated diff records", async () => {
    const accepted = await auditElementPair(pair, makeAuditContext({
      auditorCaller: vi.fn().mockResolvedValue({ parsed: { hasDiff: true, evidence: ["visible"], title: "Shift" }, rawContent: "", model: "audit-model", provider: "nvidia" }),
      reviewerCaller: vi.fn().mockResolvedValue({ parsed: { decision: "accepted", reason: "visible in overlay" }, rawContent: "", model: "review-model", provider: "nvidia" }),
      positionDeltaPx: 15,
      geometryDeltaPx: 15
    }));

    expect(accepted.accepted[0]).toMatchObject({
      reviewerStatus: "accepted",
      reviewerReason: "visible in overlay"
    });

    const escalated = await auditElementPair(pair, makeAuditContext({
      auditorCaller: vi.fn().mockResolvedValue({ parsed: { hasDiff: true, evidence: ["visible"], title: "Shift" }, rawContent: "", model: "audit-model", provider: "nvidia" }),
      reviewerCaller: vi.fn().mockResolvedValue({ parsed: { decision: "needs_escalation", reason: "crop is ambiguous" }, rawContent: "", model: "review-model", provider: "nvidia" }),
      positionDeltaPx: 15,
      geometryDeltaPx: 15
    }));

    expect(escalated.accepted[0]).toMatchObject({
      reviewerStatus: "needs_escalation",
      reviewerReason: "crop is ambiguous"
    });
  });

  it("records criterion_not_triggered for criteria not selected by triggers", async () => {
    const auditorCaller = vi.fn().mockResolvedValue({ parsed: { hasDiff: false }, rawContent: "", model: "m", provider: "nvidia" });
    const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, positionDeltaPx: 0, geometryDeltaPx: 0 }));
    expect(result.trace.some(t => t.status === "criterion_not_triggered")).toBe(true);
  });

  it("sends directional overlay and context crop as evidence images to auditor", async () => {
    const capturedRequests: import("../../src/models/vision-json.js").VisionJsonRequest[] = [];
    const auditorCaller: VisionJsonCaller = vi.fn().mockImplementation(async (req) => {
      capturedRequests.push(req);
      return {
        parsed: { hasDiff: true, severity: "medium", title: "Evidence test", evidence: ["diff present"] },
        rawContent: "",
        model: "test-model",
        provider: "openrouter"
      };
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });

    await auditElementPair(pair, {
      expectedImagePath: grayPng,
      actualImagePath: grayPng,
      expectedElements: [expectedEl],
      actualElements: [{ ...expectedEl, id: "a1", box: { x: 10, y: 65, width: 80, height: 40 } }],
      artifactDir: tmpDir,
      auditorCaller,
      reviewerCaller,
      expectedRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      actualRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      measurements: [],
      auditIndex: 1,
      auditTotal: 1,
      elementSlug: "submit-button",
      triggerCtx: {
        pairingStatus: "matched",
        positionDeltaPx: 15,
        geometryDeltaPx: 15,
        comparisonComparable: true,
        textDelta: false,
        colorDelta: false,
        edgeMismatch: false,
        overlapDetected: false,
        stateWordsDiffer: false,
        elementType: "button",
        measurements: []
      }
    });

    expect(capturedRequests.length).toBeGreaterThanOrEqual(1);
    const firstRequest = capturedRequests[0];
    // Expect: expected crop, actual crop, directional overlay, pixel-diff mask, context crop
    expect(firstRequest?.images.length).toBeGreaterThanOrEqual(3);
    // All images should be data URIs
    for (const img of firstRequest?.images ?? []) {
      expect(img).toMatch(/^data:image\/png;base64,/);
    }
  });

  it("identical content at different scale produces near-empty pixel diff mask", async () => {
    // Regression: pixel mask used zero-padded actual while overlay used sharp-resized actual,
    // producing mask/overlay mismatch and incorrect diff mass for size-mismatched crops.
    // The fix: a single Sharp-resized comparison crop is used for both operations.
    // Verify by checking that same solid-gray content at different scale → <5% changed pixels.
    function makeSolidGrayRgba(w: number, h: number): Uint8Array {
      const buf = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        buf[i * 4] = 128; buf[i * 4 + 1] = 128; buf[i * 4 + 2] = 128; buf[i * 4 + 3] = 255;
      }
      return buf;
    }

    const smallActualEl: UiElement = { ...expectedEl, id: "a1", box: { x: 10, y: 50, width: 40, height: 20 } };
    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { hasDiff: false }, rawContent: "", model: "m", provider: "nvidia"
    });
    const ctx = {
      ...makeAuditContext({ auditorCaller }),
      actualElements: [smallActualEl],
      expectedRgba: { data: makeSolidGrayRgba(200, 400), width: 200, height: 400 },
      actualRgba: { data: makeSolidGrayRgba(200, 400), width: 200, height: 400 }
    };
    await auditElementPair(pair, ctx);

    // After Sharp/Lanczos3 resize the actual crop matches the expected crop exactly.
    const maskFiles = (await fs.readdir(tmpDir)).filter(f => f.endsWith("-local-pixel-diff-mask.png"));
    expect(maskFiles.length).toBeGreaterThanOrEqual(1);
    const { data: maskData, info: maskInfo } = await sharp(path.join(tmpDir, maskFiles[0]!)).raw().toBuffer({ resolveWithObject: true });
    const nonZero = [...maskData].filter(v => v > 0).length;
    const total = maskInfo.width * maskInfo.height * maskInfo.channels;
    expect(nonZero / total).toBeLessThan(0.05);
  });

  it("local comparison preserves a circular feature across crop aspect ratios",
      async () => {
    function makeCircleCanvas(
      width: number,
      height: number,
      centerX: number,
      centerY: number,
      radius: number
    ): Uint8Array {
      const data = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = (y * width + x) * 4;
          const inside =
            (x - centerX) ** 2 + (y - centerY) ** 2 <= radius ** 2;
          const value = inside ? 255 : 0;
          data[offset] = value;
          data[offset + 1] = value;
          data[offset + 2] = value;
          data[offset + 3] = 255;
        }
      }
      return data;
    }

    const squareActualEl: UiElement = {
      ...expectedEl,
      id: "a1",
      box: { x: 10, y: 50, width: 40, height: 40 }
    };
    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { hasDiff: false },
      rawContent: "",
      model: "m",
      provider: "nvidia"
    });
    await auditElementPair(pair, {
      ...makeAuditContext({ auditorCaller }),
      actualElements: [squareActualEl],
      expectedRgba: {
        data: makeCircleCanvas(200, 400, 50, 70, 15),
        width: 200,
        height: 400
      },
      actualRgba: {
        data: makeCircleCanvas(200, 400, 30, 70, 15),
        width: 200,
        height: 400
      }
    });

    const maskFile = (await fs.readdir(tmpDir))
      .find(file => file.endsWith("-local-pixel-diff-mask.png"));
    expect(maskFile).toBeDefined();
    const { data } = await sharp(path.join(tmpDir, maskFile!))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const nonZero = [...data].filter(value => value > 0).length;
    expect(nonZero).toBeLessThan(20);
  });

  it("does not call a provider for an ideal full-width projected pair", async () => {
    const transform = createUniformContainImagePairTransform(
      { width: 402, height: 874 },
      { width: 1080, height: 2400 }
    );
    const comparisonDelta = computeComparisonSpaceDelta({
      expectedBox: { x: 0, y: 0, width: 402, height: 874 },
      actualBox: { x: 0, y: 0, width: 1080, height: 2400 },
      transform
    });
    expect(comparisonDelta).toMatchObject({ comparable: true, positionDeltaPx: 0, geometryDeltaPx: 0 });
    if (!comparisonDelta.comparable) return;

    const auditorCaller = vi.fn().mockResolvedValue({ parsed: { hasDiff: false }, rawContent: "", model: "m", provider: "nvidia" });
    const context = makeAuditContext({ auditorCaller });
    const result = await auditElementPair(pair, {
      ...context,
      triggerCtx: {
        ...context.triggerCtx,
        positionDeltaPx: comparisonDelta.positionDeltaPx,
        geometryDeltaPx: comparisonDelta.geometryDeltaPx,
        comparisonComparable: true
      }
    });
    expect(auditorCaller).not.toHaveBeenCalled();
    expect(result.trace.every(t => t.status === "criterion_not_triggered")).toBe(true);
  });

  it("trace predicate for vlmAuditedPairs: explicit criterion trigger also satisfies predicate", async () => {
    const auditorCaller = vi.fn().mockResolvedValue({
      parsed: { hasDiff: true, severity: "high", title: "Shift", evidence: ["y offset"] },
      rawContent: "", model: "m", provider: "nvidia"
    });
    const reviewerCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" }, rawContent: "", model: "r", provider: "nvidia"
    });
    const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, reviewerCaller, positionDeltaPx: 15, geometryDeltaPx: 15 }));
    // Geometry and spacing_alignment both fire with 15px delta; predicate must be true.
    expect(result.trace.some(t => t.status !== "criterion_not_triggered")).toBe(true);
  });
});

describe("reviewAndMergeFindings", () => {
  it("removes rejected diffs", () => {
    const diffs: DiffRecord[] = [
      {
        id: "d1", criterion: "geometry", severity: "high", title: "Shift",
        location: { x: 0, y: 0, width: 10, height: 10 },
        evidence: ["actual y=20"], measurements: [], artifactPaths: [],
        reviewerStatus: "accepted"
      },
      {
        id: "d2", criterion: "geometry", severity: "low", title: "Minor",
        location: { x: 0, y: 0, width: 10, height: 10 },
        evidence: ["actual y=2"], measurements: [], artifactPaths: [],
        reviewerStatus: "rejected"
      }
    ];
    const result = reviewAndMergeFindings(diffs);
    expect(result.every(d => d.reviewerStatus !== "rejected")).toBe(true);
    expect(result).toHaveLength(1);
  });
});

describe("prompt builders — Evidence discipline", () => {
  it("auditor prompt contains Evidence discipline block", () => {
    const prompt = buildAuditorPrompt({
      criterion: "geometry",
      rubric: rubrics["geometry"],
      elementLabel: "Header",
      elementType: "text",
      pairingStatus: "matched",
      measurements: []
    });
    expect(prompt).toContain("Evidence discipline");
    expect(prompt).toContain("crop/position mismatch");
  });

  it("reviewer prompt rejects crop-boundary evidence without explicit qualification", () => {
    const prompt = buildReviewerPrompt("geometry", "Header", "Text is cut off", ["left half of text is cut"]);
    expect(prompt).toContain("crop/position mismatch");
    expect(prompt).toMatch(/reject.*title.*evidence.*not visible/i);
  });
});

describe("hasUnsupportedCropBoundaryClaim", () => {
  const base: DiffRecord = {
    id: "d1", criterion: "typography_content", severity: "medium",
    title: "Element visual difference", location: { x: 0, y: 0, width: 100, height: 30 },
    evidence: [], measurements: [], artifactPaths: [], reviewerStatus: "accepted"
  };

  it("flags diff whose evidence describes 'left half' without crop/position/projected qualifier", () => {
    const diff: DiffRecord = { ...base, evidence: ["left half of text is cut"] };
    expect(hasUnsupportedCropBoundaryClaim(diff)).toBe(true);
  });

  it("does not flag diff when evidence explicitly says crop/position mismatch", () => {
    const diff: DiffRecord = { ...base, evidence: ["left half of text is cut — crop/position mismatch"] };
    expect(hasUnsupportedCropBoundaryClaim(diff)).toBe(false);
  });

  it("does not flag diff with no crop-boundary phrase at all", () => {
    const diff: DiffRecord = { ...base, evidence: ["background color changed from dark to light"] };
    expect(hasUnsupportedCropBoundaryClaim(diff)).toBe(false);
  });
});

describe("reviewAndMergeFindings — crop-boundary guard", () => {
  const base: DiffRecord = {
    id: "d1", criterion: "typography_content", severity: "medium",
    title: "Text appears cut", location: { x: 0, y: 0, width: 100, height: 30 },
    evidence: [], measurements: [], artifactPaths: [], reviewerStatus: "accepted"
  };

  it("rejects diff with unsupported 'left half' crop claim", () => {
    const diff: DiffRecord = { ...base, evidence: ["left half of text is cut off"] };
    const result = reviewAndMergeFindings([diff]);
    expect(result).toHaveLength(0);
  });

  it("keeps diff when evidence qualifies the claim as crop/position mismatch", () => {
    const diff: DiffRecord = { ...base, evidence: ["right half cropped — crop/position mismatch"] };
    const result = reviewAndMergeFindings([diff]);
    expect(result).toHaveLength(1);
  });

  it("keeps diff with 'projected' qualifier", () => {
    const diff: DiffRecord = { ...base, evidence: ["left half cut — projected location mismatch"] };
    const result = reviewAndMergeFindings([diff]);
    expect(result).toHaveLength(1);
  });
});

describe("projected actual element reaches VLM auditor after pre-audit stage", () => {
  // Since Task 4 moved deterministic projected mismatch to the pre-audit stage,
  // any projected pair that reaches auditElementPair must be audited by the VLM.
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-proj-vlm-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("invokes the VLM auditor for a projected actual element that pre-audit did not skip", async () => {
    const baseEl: UiElement = {
      id: "e1", label: "Nav Header", type: "text",
      box: { x: 0, y: 0, width: 80, height: 40 },
      normalizedBox: { x: 0, y: 0, width: 0.4, height: 0.1 },
      confidence: 0.9, source: "locator", childIds: []
    };
    const projectedEl: UiElement = {
      ...baseEl, id: "a1", source: "projected",
      box: { x: 0, y: 0, width: 40, height: 20 },
      normalizedBox: { x: 0, y: 0, width: 0.2, height: 0.05 }
    };
    const pair: ElementPair = { id: "pair-vlm-proj", expectedId: "e1", actualId: "a1", status: "matched", score: 1.0, reasons: [] };

    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { hasDiff: false },
      model: "test-model",
      usage: { input_tokens: 1, output_tokens: 1 }
    });
    const reviewerCaller: VisionJsonCaller = vi.fn();

    await auditElementPair(pair, {
      expectedImagePath: tmpDir,
      actualImagePath: tmpDir,
      expectedElements: [baseEl],
      actualElements: [projectedEl],
      artifactDir: tmpDir,
      auditorCaller,
      reviewerCaller,
      expectedRgba: { data: makeStripedRgba(200, 400), width: 200, height: 400 },
      actualRgba: { data: new Uint8Array(200 * 400 * 4).fill(128), width: 200, height: 400 },
      measurements: [],
      auditIndex: 1,
      auditTotal: 1,
      elementSlug: "nav-header",
      triggerCtx: {
        pairingStatus: "matched", positionDeltaPx: 20, geometryDeltaPx: 20, comparisonComparable: true, textDelta: false, colorDelta: false,
        edgeMismatch: false, overlapDetected: false, stateWordsDiffer: false,
        elementType: "text", measurements: []
      }
    });

    expect(vi.mocked(auditorCaller)).toHaveBeenCalled();
  });
});
