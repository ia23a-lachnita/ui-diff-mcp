import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rubrics, selectTriggeredCriteria } from "../../src/audit/criteria.js";
import { buildAuditorPrompt, buildReviewerPrompt } from "../../src/audit/prompts.js";
import { auditElementPair } from "../../src/audit/audit-target.js";
import { reviewAndMergeFindings } from "../../src/audit/review-findings.js";
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
      imageWidth: 200,
      imageHeight: 400,
      measurements: [],
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
      imageWidth: 200,
      imageHeight: 400,
      measurements: [],
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
      imageWidth: 200,
      imageHeight: 400,
      measurements: [],
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
