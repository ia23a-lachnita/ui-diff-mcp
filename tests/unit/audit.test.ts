import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { rubrics, selectTriggeredCriteria } from "../../src/audit/criteria.js";
import { buildAuditorPrompt, buildReviewerPrompt } from "../../src/audit/prompts.js";
import { auditElementPair } from "../../src/audit/audit-target.js";
import { reviewAndMergeFindings, hasUnsupportedCropBoundaryClaim } from "../../src/audit/review-findings.js";
import { UiCriterionSchema } from "../../src/schemas/core.js";
import type { ElementPair, UiElement, DiffRecord } from "../../src/schemas/core.js";
import type { VisionJsonCaller } from "../../src/models/vision-json.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";

describe("criteria rubrics", () => {
  it("has a rubric for every criterion", () => {
    for (const criterion of UiCriterionSchema.options) {
      expect(rubrics[criterion]).toBeDefined();
      expect(rubrics[criterion]?.jsonSchema).toBeDefined();
    }
  });
});

describe("selectTriggeredCriteria", () => {
  it("triggers geometry for a shifted button", () => {
    const criteria = selectTriggeredCriteria({
      pairingStatus: "matched",
      boxDeltaPx: 15,
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
      boxDeltaPx: 0,
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
      boxDeltaPx: 0,
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
    boxDeltaPx?: number;
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
      expectedElements: [expectedEl],
      actualElements: [{ ...expectedEl, id: "a1", box: { x: 10, y: 50 + (overrides.boxDeltaPx ?? 0), width: 80, height: 40 } }],
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
        boxDeltaPx: overrides.boxDeltaPx ?? 0,
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
      parsed: { hasDiff: true, severity: "high", title: "Button shifted down", evidence: ["actual y=65px, expected y=50px"] },
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
        boxDeltaPx: 15,
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

  it("removes diff when reviewer rejects it", async () => {
    const auditorCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { hasDiff: true, severity: "low", title: "Minor shift", evidence: ["actual y=52px, expected y=50px"] },
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
        boxDeltaPx: 2,
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
        boxDeltaPx: 0,
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
      parsed: { hasDiff: true, severity: "high", title: "Button shifted down", evidence: ["actual y=65px, expected y=50px"] },
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
        boxDeltaPx: 15,
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
    const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, reviewerCaller, boxDeltaPx: 15 }));
    expect(result.accepted).toHaveLength(0);
    expect(result.trace.some(t => t.status === "auditor_no_diff" && t.model === "audit-model")).toBe(true);
    expect(reviewerCaller).not.toHaveBeenCalled();
  });

  it("records empty_evidence when hasDiff true has no evidence", async () => {
    const auditorCaller = vi.fn().mockResolvedValue({ parsed: { hasDiff: true, title: "Bad" }, rawContent: "", model: "audit-model", provider: "nvidia" });
    const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, boxDeltaPx: 15 }));
    expect(result.trace.some(t => t.status === "empty_evidence")).toBe(true);
  });

  it("records reviewer_rejected with reason", async () => {
    const result = await auditElementPair(pair, makeAuditContext({
      auditorCaller: vi.fn().mockResolvedValue({ parsed: { hasDiff: true, evidence: ["visible"], title: "Shift" }, rawContent: "", model: "audit-model", provider: "nvidia" }),
      reviewerCaller: vi.fn().mockResolvedValue({ parsed: { decision: "rejected", reason: "not supported" }, rawContent: "", model: "review-model", provider: "nvidia" }),
      boxDeltaPx: 15
    }));
    expect(result.trace.some(t => t.status === "reviewer_rejected" && t.rejectionReason === "not supported")).toBe(true);
  });

  it("records criterion_not_triggered for criteria not selected by triggers", async () => {
    const auditorCaller = vi.fn().mockResolvedValue({ parsed: { hasDiff: false }, rawContent: "", model: "m", provider: "nvidia" });
    const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, boxDeltaPx: 0 }));
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
        boxDeltaPx: 15,
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

describe("deterministic projected mismatch record honesty", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-proj-mismatch-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const baseEl: UiElement = {
    id: "e1",
    label: "Navigation Header",
    type: "text",
    box: { x: 0, y: 0, width: 80, height: 40 },
    normalizedBox: { x: 0, y: 0, width: 0.4, height: 0.1 },
    confidence: 0.9,
    source: "locator",
    childIds: []
  };

  const projectedEl: UiElement = {
    ...baseEl,
    id: "a1",
    source: "projected",
    // different box size → triggers projection_dimension_mismatch
    box: { x: 0, y: 0, width: 40, height: 20 },
    normalizedBox: { x: 0, y: 0, width: 0.2, height: 0.05 },
    projectionMetadata: {
      mode: "expected_coordinate_projection",
      coordinateSpace: "actual_source_image",
      sourceElementId: "e1",
      scaleExpectedToActualX: 0.5,
      scaleExpectedToActualY: 0.5
    }
  };

  const pair: ElementPair = {
    id: "pair-proj-1",
    expectedId: "e1",
    actualId: "a1",
    status: "matched",
    score: 1.0,
    reasons: []
  };

  it("emits criterion=presence for deterministic projected mismatch", async () => {
    const auditorCaller: VisionJsonCaller = vi.fn();
    const reviewerCaller: VisionJsonCaller = vi.fn();
    const expRgba = new Uint8Array(200 * 400 * 4).fill(200);
    const actRgba = new Uint8Array(200 * 400 * 4).fill(10);

    const result = await auditElementPair(pair, {
      expectedImagePath: tmpDir,
      actualImagePath: tmpDir,
      expectedElements: [baseEl],
      actualElements: [projectedEl],
      artifactDir: tmpDir,
      auditorCaller,
      reviewerCaller,
      expectedRgba: { data: expRgba, width: 200, height: 400 },
      actualRgba: { data: actRgba, width: 200, height: 400 },
      measurements: [],
      auditIndex: 1,
      auditTotal: 1,
      elementSlug: "navigation-header",
      triggerCtx: {
        pairingStatus: "matched",
        boxDeltaPx: 0,
        textDelta: false,
        colorDelta: false,
        edgeMismatch: false,
        overlapDetected: false,
        stateWordsDiffer: false,
        elementType: "text",
        measurements: []
      }
    });

    expect(result.accepted).toHaveLength(1);
    const record = result.accepted[0]!;
    expect(record.criterion).toBe("presence");
    expect(record.classificationSource).toBe("deterministic_projected_mismatch");
    expect(record.title).toMatch(/projected location/i);
    expect(record.model).toBe("deterministic");
    expect(record.reviewerStatus).toBe("accepted");
    // VLM callers must not have been called — this is deterministic
    expect(vi.mocked(auditorCaller)).not.toHaveBeenCalled();
  });

  it("title does not mention implementation cause or app code", async () => {
    const result = await auditElementPair(pair, {
      expectedImagePath: tmpDir,
      actualImagePath: tmpDir,
      expectedElements: [baseEl],
      actualElements: [projectedEl],
      artifactDir: tmpDir,
      auditorCaller: vi.fn(),
      reviewerCaller: vi.fn(),
      expectedRgba: { data: new Uint8Array(200 * 400 * 4).fill(200), width: 200, height: 400 },
      actualRgba: { data: new Uint8Array(200 * 400 * 4).fill(10), width: 200, height: 400 },
      measurements: [],
      auditIndex: 1,
      auditTotal: 1,
      elementSlug: "navigation-header",
      triggerCtx: {
        pairingStatus: "matched", boxDeltaPx: 0, textDelta: false, colorDelta: false,
        edgeMismatch: false, overlapDetected: false, stateWordsDiffer: false,
        elementType: "text", measurements: []
      }
    });

    const record = result.accepted[0]!;
    const combined = [record.title, ...record.evidence].join(" ");
    expect(combined).not.toMatch(/fix|implement|config|root cause|app code/i);
  });

  it("record includes expected_crop and actual_crop artifacts", async () => {
    const result = await auditElementPair(pair, {
      expectedImagePath: tmpDir,
      actualImagePath: tmpDir,
      expectedElements: [baseEl],
      actualElements: [projectedEl],
      artifactDir: tmpDir,
      auditorCaller: vi.fn(),
      reviewerCaller: vi.fn(),
      expectedRgba: { data: new Uint8Array(200 * 400 * 4).fill(200), width: 200, height: 400 },
      actualRgba: { data: new Uint8Array(200 * 400 * 4).fill(10), width: 200, height: 400 },
      measurements: [],
      auditIndex: 1,
      auditTotal: 1,
      elementSlug: "navigation-header",
      triggerCtx: {
        pairingStatus: "matched", boxDeltaPx: 0, textDelta: false, colorDelta: false,
        edgeMismatch: false, overlapDetected: false, stateWordsDiffer: false,
        elementType: "text", measurements: []
      }
    });

    const record = result.accepted[0]!;
    const roles = record.artifactPaths.map(a => a.role);
    expect(roles).toContain("expected_crop");
    expect(roles).toContain("actual_crop");
  });

  it("projectionMismatchReason is set on the record", async () => {
    const result = await auditElementPair(pair, {
      expectedImagePath: tmpDir,
      actualImagePath: tmpDir,
      expectedElements: [baseEl],
      actualElements: [projectedEl],
      artifactDir: tmpDir,
      auditorCaller: vi.fn(),
      reviewerCaller: vi.fn(),
      expectedRgba: { data: new Uint8Array(200 * 400 * 4).fill(200), width: 200, height: 400 },
      actualRgba: { data: new Uint8Array(200 * 400 * 4).fill(10), width: 200, height: 400 },
      measurements: [],
      auditIndex: 1,
      auditTotal: 1,
      elementSlug: "navigation-header",
      triggerCtx: {
        pairingStatus: "matched", boxDeltaPx: 0, textDelta: false, colorDelta: false,
        edgeMismatch: false, overlapDetected: false, stateWordsDiffer: false,
        elementType: "text", measurements: []
      }
    });

    const record = result.accepted[0]!;
    expect(record.projectionMismatchReason).toBeDefined();
    expect(["expected_target_absent_at_projected_location", "projected_crop_low_overlap", "projected_crop_high_diff_mass", "projection_dimension_mismatch"])
      .toContain(record.projectionMismatchReason);
  });
});
