import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { rubrics, selectTriggeredCriteria } from "../../src/audit/criteria.js";
import { buildAuditorPrompt, buildRecoveryPrompt, buildReviewerPrompt } from "../../src/audit/prompts.js";
import { auditElementPair } from "../../src/audit/audit-target.js";
import type { ReviewerHandle } from "../../src/audit/audit-target.js";
import { modelFamilyKey } from "../../src/models/model-registry.js";

function makeReviewerHandle(
  caller: VisionJsonCaller,
  provider = "test-reviewer-provider",
  model = "test-reviewer-model",
  additionalRoutes: ReviewerHandle["routes"] = []
): ReviewerHandle {
  return {
    caller,
    routes: [{ provider, model, familyKey: modelFamilyKey(model) }, ...additionalRoutes]
  };
}
import { reviewAndMergeFindings, hasUnsupportedCropBoundaryClaim, requiredAcceptedArtifactRoles } from "../../src/audit/review-findings.js";
import { UiCriterionSchema } from "../../src/schemas/core.js";
import type { ElementPair, UiElement, DiffRecord, UiArtifact } from "../../src/schemas/core.js";
import type { VisionJsonCaller } from "../../src/models/vision-json.js";
import { makeFallbackVisionCaller, RouteExhaustedError } from "../../src/models/fallback-caller.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";
import { summarizeAuditPairOutcomes } from "../../src/debug/run-debug.js";
import { createUniformContainImagePairTransform, createImagePairTransform } from "../../src/images/coordinates.js";
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
    expect(prompt).toContain("NORMALIZED actual comparison crop");
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
    const context = makeAuditContext({ auditorCaller });
    const result = await auditElementPair(pair, {
      ...context,
      triggerCtx: {
        ...context.triggerCtx,
        comparisonComparable: false
      }
    });

    expect(auditorCaller).not.toHaveBeenCalled();
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
    reviewerResolver?: (auditorProvider: string, auditorModel: string) => ReviewerHandle | null;
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
    const defaultReviewer: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "default-reviewer",
      provider: "nvidia"
    });
    const reviewerResolver = overrides.reviewerResolver ?? (() => makeReviewerHandle(defaultReviewer, "nvidia", "default-reviewer"));
    return {
      expectedImagePath: grayPng,
      actualImagePath: grayPng,
      expectedElements: overrides.expectedElements ?? [expectedEl],
      actualElements: [{ ...expectedEl, id: "a1", box: { x: 10, y: 50 + (overrides.positionDeltaPx ?? 0), width: 80, height: 40 } }],
      artifactDir: tmpDir,
      auditorCaller,
      reviewerResolver,
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
      reviewerResolver: () => makeReviewerHandle(reviewerCaller, "openrouter", "test-reviewer"),
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
      reviewerResolver: () => makeReviewerHandle(reviewerCaller, "openrouter", "test-reviewer"),
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
      reviewerResolver: () => makeReviewerHandle(reviewerCaller, "nvidia", "nvidia/nemotron-nano-12b-v2-vl"),
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
      reviewerResolver: () => makeReviewerHandle(reviewerCaller, "openrouter", "test-reviewer"),
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
    const defaultReviewer = vi.fn();
    const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, reviewerResolver: () => makeReviewerHandle(defaultReviewer, "nvidia", "default-reviewer"), positionDeltaPx: 15, geometryDeltaPx: 15 }));
    expect(result.accepted).toHaveLength(0);
    expect(result.trace.some(t => t.status === "auditor_no_diff" && t.model === "audit-model")).toBe(true);
    expect(defaultReviewer).not.toHaveBeenCalled();
  });

  it("records empty_evidence when hasDiff true has no evidence", async () => {
    const auditorCaller = vi.fn().mockResolvedValue({ parsed: { hasDiff: true, title: "Bad" }, rawContent: "", model: "audit-model", provider: "nvidia" });
    const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, positionDeltaPx: 15, geometryDeltaPx: 15 }));
    expect(result.trace.some(t => t.status === "empty_evidence")).toBe(true);
  });

  it("records reviewer_rejected with reason", async () => {
    const result = await auditElementPair(pair, makeAuditContext({
      auditorCaller: vi.fn().mockResolvedValue({ parsed: { hasDiff: true, evidence: ["visible"], title: "Shift" }, rawContent: "", model: "audit-model", provider: "nvidia" }),
      reviewerResolver: () => makeReviewerHandle(vi.fn().mockResolvedValue({ parsed: { decision: "rejected", reason: "not supported" }, rawContent: "", model: "review-model", provider: "nvidia" }), "nvidia", "review-model"),
      positionDeltaPx: 15,
      geometryDeltaPx: 15
    }));
    expect(result.trace.some(t => t.status === "reviewer_rejected" && t.rejectionReason === "not supported")).toBe(true);
  });

  it("persists reviewer reason on final accepted and escalated diff records", async () => {
    const accepted = await auditElementPair(pair, makeAuditContext({
      auditorCaller: vi.fn().mockResolvedValue({ parsed: { hasDiff: true, evidence: ["visible"], title: "Shift" }, rawContent: "", model: "audit-model", provider: "nvidia" }),
      reviewerResolver: () => makeReviewerHandle(vi.fn().mockResolvedValue({ parsed: { decision: "accepted", reason: "visible in overlay" }, rawContent: "", model: "review-model", provider: "nvidia" }), "nvidia", "review-model"),
      positionDeltaPx: 15,
      geometryDeltaPx: 15
    }));

    expect(accepted.accepted[0]).toMatchObject({
      reviewerStatus: "accepted",
      reviewerReason: "visible in overlay"
    });

    const escalated = await auditElementPair(pair, makeAuditContext({
      auditorCaller: vi.fn().mockResolvedValue({ parsed: { hasDiff: true, evidence: ["visible"], title: "Shift" }, rawContent: "", model: "audit-model", provider: "nvidia" }),
      reviewerResolver: () => makeReviewerHandle(vi.fn().mockResolvedValue({ parsed: { decision: "needs_escalation", reason: "crop is ambiguous" }, rawContent: "", model: "review-model", provider: "nvidia" }), "nvidia", "review-model"),
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
      reviewerResolver: () => makeReviewerHandle(reviewerCaller, "openrouter", "test-reviewer"),
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
    const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, positionDeltaPx: 15, geometryDeltaPx: 15 }));
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

  it("auditor prompt explains synthetic contain padding transparent bands", () => {
    const prompt = buildAuditorPrompt({
      criterion: "color_appearance",
      rubric: rubrics["color_appearance"],
      elementLabel: "Card",
      elementType: "card",
      pairingStatus: "matched",
      measurements: []
    });
    expect(prompt).toContain("Transparent bands or pixels in the normalized actual comparison crop are synthetic contain padding");
    expect(prompt).toContain("pillarbox/letterbox");
    expect(prompt).toContain("they are not missing UI and must not be reported as a difference");
  });

  it("reviewer prompt explains synthetic contain padding transparent bands", () => {
    const prompt = buildReviewerPrompt(
      "color_appearance",
      "Card",
      "Color shift",
      ["background changed"]
    );
    expect(prompt).toContain("Transparent bands or pixels in the normalized actual comparison crop are synthetic contain padding");
    expect(prompt).toContain("pillarbox/letterbox");
    expect(prompt).toContain("they are not missing UI and must not be reported as a difference");
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

    await auditElementPair(pair, {
      expectedImagePath: tmpDir,
      actualImagePath: tmpDir,
      expectedElements: [baseEl],
      actualElements: [projectedEl],
      artifactDir: tmpDir,
      auditorCaller,
      reviewerResolver: () => makeReviewerHandle(vi.fn(), "nvidia", "test-reviewer"),
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

describe("Task 5: Normalized Target Evidence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-task5-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- Helpers ---

  /** Real 200x400 expected RGBA: rows of solid red (255,0,0,255). */
  function makeExpectedRgba(): Uint8Array {
    const w = 200, h = 400;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 255; data[i * 4 + 1] = 0; data[i * 4 + 2] = 0; data[i * 4 + 3] = 255;
    }
    return data;
  }

  /** Real 300x600 actual RGBA: blue background with a green crop-box at x15,y75,w120,h60. */
  function makeActualRgba(): Uint8Array {
    const w = 300, h = 600;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inBox = x >= 15 && x < 15 + 120 && y >= 75 && y < 75 + 60;
        if (inBox) {
          data[i] = 0; data[i + 1] = 200; data[i + 2] = 0; data[i + 3] = 255;
        } else {
          data[i] = 0; data[i + 1] = 0; data[i + 2] = 255; data[i + 3] = 255;
        }
      }
    }
    return data;
  }

  const expectedElDef: UiElement = {
    id: "e1",
    label: "Card",
    type: "card",
    box: { x: 10, y: 50, width: 80, height: 40 },
    normalizedBox: { x: 0.05, y: 0.125, width: 0.4, height: 0.1 },
    confidence: 0.95,
    source: "locator",
    childIds: []
  };

  const pairDef: ElementPair = {
    id: "pair-t5",
    expectedId: "e1",
    actualId: "a1",
    status: "matched",
    score: 0.9,
    reasons: []
  };

  function makeTask5Context(overrides: {
    auditorCaller?: VisionJsonCaller;
    reviewerResolver?: (auditorProvider: string, auditorModel: string) => ReviewerHandle | null;
    expectedRgba?: Uint8Array;
    actualRgba?: Uint8Array;
    expectedWidth?: number;
    expectedHeight?: number;
    actualWidth?: number;
    actualHeight?: number;
    actualBox?: { x: number; y: number; width: number; height: number };
    expectedElements?: UiElement[];
    actualElements?: UiElement[];
    imagePairTransform?: import("../../src/images/coordinates.js").ImagePairTransform;
    auditIndex?: number;
  } = {}) {
    const expectedW = overrides.expectedWidth ?? 200;
    const expectedH = overrides.expectedHeight ?? 400;
    const actualW = overrides.actualWidth ?? 300;
    const actualH = overrides.actualHeight ?? 600;
    const expectedRgbaData = overrides.expectedRgba ?? makeExpectedRgba();
    const actualRgbaData = overrides.actualRgba ?? makeActualRgba();

    const auditorCaller: VisionJsonCaller = overrides.auditorCaller ?? vi.fn().mockResolvedValue({
      parsed: { hasDiff: true, severity: "medium", title: "Color shift", evidence: ["background changed"] },
      rawContent: "", model: "test-auditor", provider: "nvidia"
    });
    const defaultReviewer: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "", model: "test-reviewer", provider: "nvidia"
    });
    const reviewerResolver = overrides.reviewerResolver ?? (() => makeReviewerHandle(defaultReviewer, "nvidia", "test-reviewer"));

    // Expected box 80x40, actual box projected 120x60 (stretched via transform)
    const actualBox = overrides.actualBox ?? { x: 15, y: 75, width: 120, height: 60 };

    return {
      expectedImagePath: path.join(tmpDir, "expected.png"),
      actualImagePath: path.join(tmpDir, "actual.png"),
      expectedElements: overrides.expectedElements ?? [{ ...expectedElDef }],
      actualElements: overrides.actualElements ?? [{ ...expectedElDef, id: "a1", box: actualBox }],
      artifactDir: tmpDir,
      auditorCaller,
      reviewerResolver,
      expectedRgba: { data: expectedRgbaData, width: expectedW, height: expectedH },
      actualRgba: { data: actualRgbaData, width: actualW, height: actualH },
      imagePairTransform: overrides.imagePairTransform ?? createImagePairTransform({ width: expectedW, height: expectedH }, { width: actualW, height: actualH }),
      measurements: [],
      auditIndex: overrides.auditIndex ?? 1,
      auditTotal: 1,
      elementSlug: "card",
      triggerCtx: {
        pairingStatus: "matched" as const,
        positionDeltaPx: 0,
        geometryDeltaPx: 0,
        comparisonComparable: true,
        textDelta: false,
        colorDelta: true,
        edgeMismatch: false,
        overlapDetected: false,
        stateWordsDiffer: false,
        elementType: "card" as const,
        measurements: []
      }
    };
  }

  // --- Tests ---

  it("persist actual_comparison_crop artifact with pairId and native actual_crop retains native dimensions", async () => {
    const ctx = makeTask5Context();
    const result = await auditElementPair(pairDef, ctx);

    expect(result.accepted.length).toBeGreaterThanOrEqual(1);
    const diffRecord = result.accepted[0]!;

    const actualComparisonArtifact = diffRecord.artifactPaths.find(
      (a: UiArtifact) => a.role === "actual_comparison_crop"
    );
    expect(actualComparisonArtifact).toBeDefined();
    expect(actualComparisonArtifact!.pairId).toBe(pairDef.id);
    await expect(fs.access(actualComparisonArtifact!.path)).resolves.toBeUndefined();

    const nativeActualCropArtifact = diffRecord.artifactPaths.find(
      (a: UiArtifact) => a.role === "actual_crop"
    );
    expect(nativeActualCropArtifact).toBeDefined();
    expect(nativeActualCropArtifact!.pairId).toBe(pairDef.id);
    await expect(fs.access(nativeActualCropArtifact!.path)).resolves.toBeUndefined();

    // Native actual_crop reflects actual native box: 120x60
    const nativeMeta = await sharp(nativeActualCropArtifact!.path).metadata();
    expect(nativeMeta.width).toBe(120);
    expect(nativeMeta.height).toBe(60);

    // actual_comparison_crop matches expected crop dimensions: 80x40
    const cmpMeta = await sharp(actualComparisonArtifact!.path).metadata();
    expect(cmpMeta.width).toBe(80);
    expect(cmpMeta.height).toBe(40);
  });

  it("VLM slot 2 is the persisted actual_comparison_crop with same-run bytes", async () => {
    const capturedImages: string[][] = [];
    const auditorCaller: VisionJsonCaller = vi.fn().mockImplementation(async (req) => {
      capturedImages.push([...req.images]);
      return {
        parsed: { hasDiff: true, severity: "medium", title: "Shift", evidence: ["observed"] },
        rawContent: "", model: "test-auditor", provider: "nvidia"
      };
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "ok" },
      rawContent: "", model: "test-reviewer", provider: "nvidia"
    });

    const result = await auditElementPair(pairDef, makeTask5Context({ auditorCaller, reviewerResolver: () => makeReviewerHandle(reviewerCaller, "nvidia", "test-reviewer") }));

    expect(capturedImages.length).toBeGreaterThanOrEqual(1);
    const images = capturedImages[0]!;

    // Slot 1: expected crop 80x40, Slot 2: actual_comparison_crop 80x40
    expect(images.length).toBeGreaterThanOrEqual(2);

    const slot2B64 = images[1]!.replace(/^data:image\/png;base64,/, "");
    const slot2Buf = Buffer.from(slot2B64, "base64");
    const slot2Meta = await sharp(slot2Buf).metadata();
    expect(slot2Meta.width).toBe(80);
    expect(slot2Meta.height).toBe(40);

    // Decode slot2 and assert it contains the actual-source green pixel values (0,200,0).
    const slot2Rgba = await sharp(slot2Buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixelCount = slot2Meta.width! * slot2Meta.height!;
    const greenPixels = Array.from(slot2Rgba.data).reduce((count, _val, idx, arr) => {
      if (idx % 4 !== 0) return count;
      const r = arr[idx] ?? 0;
      const g = arr[idx + 1] ?? 0;
      const b = arr[idx + 2] ?? 0;
      // Within tiny tolerance of the fixture actual green (0, 200, 0)
      return (r <= 5 && g >= 195 && g <= 205 && b <= 5) ? count + 1 : count;
    }, 0);
    // The actual crop should be predominantly green pixels from the actual-source fixture.
    expect(greenPixels / pixelCount).toBeGreaterThan(0.8);

    // Prove the correct source coordinates were cropped: the actual image has a blue
    // background surrounding the green crop box. The native actual_crop (120x60) is
    // entirely within the green box, so it is all green. Spatial correctness is proven
    // by verifying: (a) comparison_crop is 80x40, (b) it is predominantly green from
    // the correct source region, and (c) the actual RGBA data has blue pixels outside
    // the crop region.
    const nativeActualCropArtifact = result.accepted[0]?.artifactPaths.find(
      (a: UiArtifact) => a.role === "actual_crop"
    );
    expect(nativeActualCropArtifact).toBeDefined();
    const nativeMeta = await sharp(nativeActualCropArtifact!.path).metadata();
    expect(nativeMeta.width).toBe(120);
    expect(nativeMeta.height).toBe(60);

    // Verify the actual RGBA data has blue pixels outside the crop region (proving
    // spatially distinct data, not a uniform-green image).
    // Top-left corner (0,0) is outside the green box at x15,y75 → should be blue
    const actualData = makeActualRgba();
    const tlIdx = 0;
    const rTL = actualData[tlIdx] ?? 0;
    const gTL = actualData[tlIdx + 1] ?? 0;
    const bTL = actualData[tlIdx + 2] ?? 0;
    expect(rTL).toBeLessThanOrEqual(5);
    expect(gTL).toBeLessThanOrEqual(5);
    expect(bTL).toBeGreaterThanOrEqual(250);

    const slot1B64 = images[0]!.replace(/^data:image\/png;base64,/, "");
    const slot1Buf = Buffer.from(slot1B64, "base64");
    const slot1Meta = await sharp(slot1Buf).metadata();
    expect(slot1Meta.width).toBe(80);
    expect(slot1Meta.height).toBe(40);

    // Same-run: slot 2 bytes match persisted actual_comparison_crop artifact
    const cmpArtifact = result.accepted[0]?.artifactPaths.find(
      (a: UiArtifact) => a.role === "actual_comparison_crop"
    );
    expect(cmpArtifact).toBeDefined();
    const persistedPng = await fs.readFile(cmpArtifact!.path);
    expect(slot2Buf.equals(persistedPng)).toBe(true);
  });

  it("imageRoles excludes actual_crop when comparison exists", async () => {
    const ctx = makeTask5Context();
    const result = await auditElementPair(pairDef, ctx);

    const relevantTraces = result.trace.filter(t => t.imageRoles.includes("expected_crop"));
    expect(relevantTraces.length).toBeGreaterThanOrEqual(1);
    for (const t of relevantTraces) {
      expect(t.imageRoles).toContain("actual_comparison_crop");
      expect(t.imageRoles).not.toContain("actual_crop");
    }
  });

  it("requiredAcceptedArtifactRoles includes actual_comparison_crop for vlm_reviewed target audit", () => {
    const roles = requiredAcceptedArtifactRoles({
      classificationSource: "vlm_reviewed",
      scopeKind: "target"
    });
    expect(roles).toContain("actual_comparison_crop");
    expect(roles).toContain("expected_crop");
    expect(roles).toContain("local_directional_overlay");
    expect(roles).toContain("local_pixel_diff_mask");
    expect(roles).toContain("context_crop");
  });

  it("UiArtifactSchema accepts actual_comparison_crop role", async () => {
    const { UiArtifactSchema } = await import("../../src/schemas/core.js");
    const artifact = {
      role: "actual_comparison_crop",
      path: "/tmp/test.png",
      pairId: "p1"
    };
    const result = UiArtifactSchema.safeParse(artifact);
    expect(result.success).toBe(true);
  });

  it("auditor prompt describes slot 2 as normalized actual comparison crop", () => {
    const prompt = buildAuditorPrompt({
      criterion: "geometry",
      rubric: rubrics["geometry"],
      elementLabel: "Card",
      elementType: "card",
      pairingStatus: "matched",
      measurements: []
    });
    expect(prompt).toContain("NORMALIZED actual comparison crop");
    expect(prompt).not.toMatch(/ACTUAL crop — the actual screenshot/);
  });

  it("reviewer prompt describes slot 2 as normalized actual comparison crop", () => {
    const prompt = buildReviewerPrompt(
      "geometry",
      "Card",
      "Card shifted",
      ["visible shift"]
    );
    expect(prompt).toContain("NORMALIZED actual comparison crop");
    expect(prompt).not.toMatch(/ACTUAL crop — the actual screenshot/);
  });

  it("auditor prompt includes synthetic padding explanation wording", () => {
    const prompt = buildAuditorPrompt({
      criterion: "presence",
      rubric: rubrics["presence"],
      elementLabel: "Card",
      elementType: "card",
      pairingStatus: "matched",
      measurements: []
    });
    expect(prompt).toContain("synthetic contain padding");
    expect(prompt).toContain("pillarbox/letterbox");
    expect(prompt).toContain("not missing UI");
  });

  it("reviewer prompt includes synthetic padding explanation wording", () => {
    const prompt = buildReviewerPrompt(
      "geometry",
      "Card",
      "Card shifted",
      ["visible shift"]
    );
    expect(prompt).toContain("synthetic contain padding");
    expect(prompt).toContain("pillarbox/letterbox");
    expect(prompt).toContain("not missing UI");
  });

  it("differing-aspect actual crops with transparent contain padding", async () => {
    // Actual source box 120x80 (taller than expected 80x40). Under uniform-contain
    // normalization the comparison_crop must be 80x40 with transparent padding on
    // the shorter axis and a green opaque center.
    const actualBox120x80 = { x: 15, y: 75, width: 120, height: 80 };
    const ctx = makeTask5Context({ actualBox: actualBox120x80 });
    const result = await auditElementPair(pairDef, ctx);

    expect(result.accepted.length).toBeGreaterThanOrEqual(1);
    const diffRecord = result.accepted[0]!;

    // Native actual_crop retains actual box dimensions: 120x80
    const nativeArtifact = diffRecord.artifactPaths.find(
      (a: UiArtifact) => a.role === "actual_crop"
    );
    expect(nativeArtifact).toBeDefined();
    const nativeMeta = await sharp(nativeArtifact!.path).metadata();
    expect(nativeMeta.width).toBe(120);
    expect(nativeMeta.height).toBe(80);

    // Comparison crop matches expected dimensions: 80x40
    const cmpArtifact = diffRecord.artifactPaths.find(
      (a: UiArtifact) => a.role === "actual_comparison_crop"
    );
    expect(cmpArtifact).toBeDefined();
    const cmpMeta = await sharp(cmpArtifact!.path).metadata();
    expect(cmpMeta.width).toBe(80);
    expect(cmpMeta.height).toBe(40);

    // Decode comparison crop: expect transparent padding at left/right edges
    // and opaque green center pixel.
    const cmpRgba = await sharp(cmpArtifact!.path)
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const cw = cmpMeta.width!;
    const ch = cmpMeta.height!;

    // Left column (x=0): should be transparent (alpha near 0) due to contain padding
    let transparentLeft = 0;
    for (let y = 0; y < ch; y++) {
      const li = (y * cw + 0) * 4;
      const alphaL = cmpRgba.data[li + 3] ?? 255;
      if (alphaL < 10) transparentLeft++;
    }
    expect(transparentLeft).toBeGreaterThan(0);

    // Center pixel (x=cw/2, y=ch/2): should be opaque green
    const ccx = Math.floor(cw / 2);
    const ccy = Math.floor(ch / 2);
    const ci = (ccy * cw + ccx) * 4;
    const rC = cmpRgba.data[ci] ?? 0;
    const gC = cmpRgba.data[ci + 1] ?? 0;
    const bC = cmpRgba.data[ci + 2] ?? 0;
    const aC = cmpRgba.data[ci + 3] ?? 0;
    expect(rC).toBeLessThanOrEqual(5);
    expect(gC).toBeGreaterThanOrEqual(195);
    expect(gC).toBeLessThanOrEqual(205);
    expect(bC).toBeLessThanOrEqual(5);
    expect(aC).toBeGreaterThanOrEqual(250);
  });
});

describe("Task 6A: Runtime Independent Reviewer Routing", () => {
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
    id: "pair-ind",
    expectedId: "e1",
    actualId: "a1",
    status: "matched",
    score: 0.8,
    reasons: []
  };

  const shiftedElements = [{ ...expectedEl, id: "a1", box: { x: 10, y: 65, width: 80, height: 40 } }];

  function makeAuditResponse(model: string, provider: string) {
    return {
      parsed: { hasDiff: true, severity: "high" as const, title: "Shift", evidence: ["visible shift"] },
      rawContent: "",
      model,
      provider
    };
  }

  function makeReviewResponse(model: string, provider: string, decision: "accepted" | "rejected" | "needs_escalation" = "accepted", reason = "confirmed") {
    return {
      parsed: { decision, reason },
      rawContent: "",
      model,
      provider
    };
  }

  function makeTriggerCtx(overrides: Partial<{ positionDeltaPx: number; geometryDeltaPx: number; comparisonComparable: boolean }> = {}) {
    return {
      pairingStatus: "matched" as const,
      positionDeltaPx: overrides.positionDeltaPx ?? 15,
      geometryDeltaPx: overrides.geometryDeltaPx ?? 15,
      comparisonComparable: overrides.comparisonComparable ?? true,
      textDelta: false,
      colorDelta: false,
      edgeMismatch: false,
      overlapDetected: false,
      stateWordsDiffer: false,
      elementType: "button" as const,
      measurements: []
    };
  }

  function makeTask6AContext(overrides: {
    auditorCaller?: VisionJsonCaller;
    reviewerResolver?: (auditorProvider: string, auditorModel: string) => ReviewerHandle | null;
    positionDeltaPx?: number;
    geometryDeltaPx?: number;
    comparisonComparable?: boolean;
  } = {}) {
    const auditorCaller: VisionJsonCaller = overrides.auditorCaller ?? vi.fn().mockResolvedValue(
      makeAuditResponse("mistral-8b", "openrouter")
    );
    const defaultReviewer: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeReviewResponse("ministral-14b", "nvidia")
    );
    const reviewerResolver = overrides.reviewerResolver ?? (() => makeReviewerHandle(defaultReviewer, "nvidia", "ministral-14b"));
    return {
      expectedImagePath: grayPng,
      actualImagePath: grayPng,
      expectedElements: [expectedEl],
      actualElements: shiftedElements,
      artifactDir: tmpDir,
      auditorCaller,
      reviewerResolver,
      expectedRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      actualRgba: { data: new Uint8Array(200 * 400 * 4), width: 200, height: 400 },
      measurements: [],
      auditIndex: 1,
      auditTotal: 1,
      elementSlug: "submit-button",
      triggerCtx: makeTriggerCtx(overrides)
    };
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-task6a-"));
    grayPng = await writeSolidPng(tmpDir, "gray.png", 200, 400, 128, 128, 128);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves reviewer via reviewerResolver using actual auditor provider/model", async () => {
    const independentReviewer: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeReviewResponse("ministral-14b", "nvidia")
    );
    const reviewerResolver = vi.fn().mockReturnValue(makeReviewerHandle(independentReviewer, "nvidia", "ministral-14b"));
    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeAuditResponse("mistral-8b", "openrouter")
    );

    const result = await auditElementPair(pair, makeTask6AContext({ auditorCaller, reviewerResolver }));

    expect(reviewerResolver).toHaveBeenCalledWith("openrouter", "mistral-8b");
    expect(independentReviewer).toHaveBeenCalled();
    expect(result.accepted.length).toBeGreaterThanOrEqual(1);
    const reviewerTrace = result.trace.find(t => t.status === "reviewer_accepted");
    expect(reviewerTrace).toBeDefined();
    expect(reviewerTrace!.reviewerModel).toBe("ministral-14b");
  });

  it("passes the trusted auditor fallback route to the independent reviewer resolver", async () => {
    const firstAuditor: VisionJsonCaller = vi.fn().mockRejectedValue(new Error("HTTP 429: rate limited"));
    const secondAuditor: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeAuditResponse("spoofed-provider-model", "spoofed-provider")
    );
    const auditorCaller = makeFallbackVisionCaller([
      { caller: firstAuditor, provider: "nvidia", model: "auditor-first" },
      { caller: secondAuditor, provider: "openrouter", model: "auditor-second" }
    ]);
    const reviewer: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeReviewResponse("reviewer-independent", "nvidia")
    );
    const reviewerResolver = vi.fn().mockReturnValue(
      makeReviewerHandle(reviewer, "nvidia", "reviewer-independent")
    );

    const result = await auditElementPair(pair, makeTask6AContext({ auditorCaller, reviewerResolver }));

    expect(reviewerResolver).toHaveBeenCalledWith("openrouter", "auditor-second");
    expect(reviewer).toHaveBeenCalled();
    expect(result.trace.some(entry => entry.status === "reviewer_accepted")).toBe(true);
  });

  it("resolver is called after auditor response, not before", async () => {
    const callOrder: string[] = [];
    const auditorCaller: VisionJsonCaller = vi.fn().mockImplementation(async () => {
      callOrder.push("auditor");
      return makeAuditResponse("mistral-8b", "openrouter");
    });
    const independentReviewer: VisionJsonCaller = vi.fn().mockImplementation(async () => {
      callOrder.push("reviewer");
      return makeReviewResponse("ministral-14b", "nvidia");
    });
    const reviewerResolver = vi.fn().mockImplementation((_prov: string, _model: string) => {
      callOrder.push("resolver");
      return makeReviewerHandle(independentReviewer, "nvidia", "ministral-14b");
    });

    await auditElementPair(pair, makeTask6AContext({ auditorCaller, reviewerResolver, positionDeltaPx: 0 }));

    expect(callOrder).toEqual(["auditor", "resolver", "reviewer"]);
  });

  it("undefined exactly-one: one needs_escalation record + one independent_reviewer_unavailable trace per criterion", async () => {
    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeAuditResponse("mistral-8b", "openrouter")
    );
    const reviewerResolver = vi.fn().mockReturnValue(null);
    const triggerCtx = makeTriggerCtx();
    const triggeredCriteria = selectTriggeredCriteria(triggerCtx);

    const result = await auditElementPair(pair, makeTask6AContext({
      auditorCaller,
      reviewerResolver,
      positionDeltaPx: triggerCtx.positionDeltaPx,
      geometryDeltaPx: triggerCtx.geometryDeltaPx
    }));

    const needsEscalationRecords = result.accepted.filter(r => r.reviewerStatus === "needs_escalation");
    const unavailableTraces = result.trace.filter(t => t.status === "independent_reviewer_unavailable");
    expect(needsEscalationRecords).toHaveLength(triggeredCriteria.length);
    expect(unavailableTraces).toHaveLength(triggeredCriteria.length);
    const recordIds = needsEscalationRecords.map(record => record.id);
    const traceIds = unavailableTraces.map(trace => trace.diffId);
    expect(new Set(recordIds).size).toBe(triggeredCriteria.length);
    expect(traceIds.every(id => typeof id === "string")).toBe(true);
    expect(new Set(traceIds)).toEqual(new Set(recordIds));
    for (const recordId of recordIds) {
      expect(traceIds.filter(id => id === recordId)).toHaveLength(1);
    }
    expect(reviewerResolver).toHaveBeenCalled();
    // Escalation record has reviewerReason
    expect(needsEscalationRecords[0]!.reviewerReason).toBeDefined();
    expect(needsEscalationRecords[0]!.reviewerReason).toContain("No independent reviewer available");
  });

  it("same-family defense: different provider but same model family → needs_escalation", async () => {
    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeAuditResponse("mistral-8b:free", "openrouter")
    );
    const sameFamilyReviewer: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeReviewResponse("mistral-8b", "openrouter")
    );
    const reviewerResolver = vi.fn().mockReturnValue(makeReviewerHandle(sameFamilyReviewer, "openrouter", "mistral-8b"));

    const result = await auditElementPair(pair, makeTask6AContext({ auditorCaller, reviewerResolver }));

    expect(sameFamilyReviewer).not.toHaveBeenCalled();
    expect(result.accepted).toHaveLength(result.trace.filter(t => t.status === "independent_reviewer_unavailable").length);
    expect(result.accepted.length).toBeGreaterThan(0);
    expect(result.accepted[0]!.reviewerStatus).toBe("needs_escalation");
    const trace = result.trace.find(t => t.status === "independent_reviewer_unavailable");
    expect(trace).toBeDefined();
    expect(trace!.rejectionReason).toContain("not independent");
    expect(trace!.rejectionReason).toContain("openrouter/mistral-8b");
  });

  it("exact-route defense: same provider+model → needs_escalation + independent_reviewer_unavailable", async () => {
    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeAuditResponse("nvidia/nemotron-nano-12b", "nvidia")
    );
    const spoofedReviewer: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeReviewResponse("nvidia/nemotron-nano-12b", "nvidia")
    );
    const reviewerResolver = vi.fn().mockReturnValue(makeReviewerHandle(spoofedReviewer, "nvidia", "nvidia/nemotron-nano-12b"));

    const result = await auditElementPair(pair, makeTask6AContext({ auditorCaller, reviewerResolver }));

    expect(spoofedReviewer).not.toHaveBeenCalled();
    expect(result.accepted[0]!.reviewerStatus).toBe("needs_escalation");
    const trace = result.trace.find(t => t.status === "independent_reviewer_unavailable");
    expect(trace).toBeDefined();
    expect(trace!.rejectionReason).toContain("nvidia/nvidia/nemotron-nano-12b");
  });

  it("different-family accepted: different provider + different family → normal accepted path", async () => {
    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeAuditResponse("mistral-8b", "openrouter")
    );
    const independentReviewer: VisionJsonCaller = vi.fn().mockResolvedValue(
      makeReviewResponse("google/gemini-2.5-flash", "openrouter")
    );
    const reviewerResolver = vi.fn().mockReturnValue(makeReviewerHandle(independentReviewer, "openrouter", "google/gemini-2.5-flash"));

    const result = await auditElementPair(pair, makeTask6AContext({ auditorCaller, reviewerResolver }));

    expect(result.accepted.length).toBeGreaterThanOrEqual(1);
    expect(result.accepted[0]!.reviewerStatus).toBe("accepted");
    const reviewerTrace = result.trace.find(t => t.status === "reviewer_accepted");
    expect(reviewerTrace).toBeDefined();
    expect(reviewerTrace!.reviewerModel).toBe("google/gemini-2.5-flash");
  });

  it("independent_reviewer_unavailable is a failure in auditTraceHasFailure", async () => {
    const { auditTraceHasFailure } = await import("../../src/pipeline/stages.js");
    expect(auditTraceHasFailure([{ status: "independent_reviewer_unavailable" }])).toBe(true);
  });
});
