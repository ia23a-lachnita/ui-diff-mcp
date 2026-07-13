import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTargetRecovery } from "../../src/recovery/target-recovery.js";
import type { RecoveryBudget, RecoveryContext } from "../../src/recovery/target-recovery.js";
import { createImagePairTransform } from "../../src/images/coordinates.js";
import type { PixelComponent } from "../../src/signals/pixel-diff.js";
import type { VisionJsonCaller } from "../../src/models/vision-json.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";

let tmpDir: string;
let overlayPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-test-"));
  overlayPath = await writeSolidPng(tmpDir, "overlay.png", 200, 200, 128, 128, 128);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRgba(width: number, height: number, r = 128, g = 128, b = 128): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function makeMask(width: number, height: number, value = 1): Uint8Array {
  return new Uint8Array(width * height).fill(value);
}

function makeCtx(overrides: Partial<RecoveryContext> = {}): RecoveryContext {
  const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
    parsed: { classified: false },
    rawContent: "",
    model: "test-model",
    provider: "openrouter"
  });
  const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
    parsed: { decision: "accepted", reason: "confirmed" },
    rawContent: "",
    model: "test-reviewer",
    provider: "openrouter"
  });
  return {
    expectedRgba: makeRgba(200, 200),
    actualRgba: makeRgba(200, 200),
    pixelDiffMask: makeMask(200, 200),
    directionalOverlayPath: overlayPath,
    artifactDir: tmpDir,
    recoveryCaller,
    reviewerCaller,
    ...overrides
  };
}

const component: PixelComponent = {
  box: { x: 10, y: 10, width: 80, height: 60 },
  pixelCount: 500
};

describe("runTargetRecovery", () => {
  it("retains an unresolved reason and skips model input for invalid recovery crops", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn();
    const invalidComponent: PixelComponent = { box: { x: 250, y: 10, width: 80, height: 60 }, pixelCount: 500 };

    const result = await runTargetRecovery([invalidComponent], makeCtx({ recoveryCaller }), unlimitedBudget);

    expect(recoveryCaller).not.toHaveBeenCalled();
    expect(result.statusCounts["evidence_crop_rejected"]).toBe(1);
    expect(result.regionOutcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "unresolved", reason: "evidence_crop_rejected: disjoint" })
    ]));
    await expect(fs.readdir(tmpDir)).resolves.not.toContain("recovery-component-0001-expected.png");
  });
  const unlimitedBudget: RecoveryBudget = {
    maxComponents: 1000,
    maxModelCalls: 2000,
    deadlineMs: Date.now() + 300000,
    minComponentPixels: 1
  };

  it.each([
    ["interior", { x: 16, y: 20, width: 1, height: 100 }, { x: 16, y: 20, width: 2, height: 100 }],
    ["right edge", { x: 199, y: 20, width: 1, height: 100 }, { x: 198, y: 20, width: 2, height: 100 }]
  ] as const)("expands a thin %s region for evidence while preserving its authoritative location", async (_label, box, expectedEvidenceBox) => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Thin border", evidence: ["vertical border differs"] },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    const result = await runTargetRecovery([{ box, pixelCount: 500 }], makeCtx({ recoveryCaller }), unlimitedBudget);

    expect(recoveryCaller).toHaveBeenCalledOnce();
    expect(result.unclassifiedCount).toBe(0);
    expect(result.recovered[0]?.location).toEqual(box);
    expect(result.trace[0]).toMatchObject({
      componentBox: box,
      evidenceBox: expectedEvidenceBox,
      actualEvidenceBox: expectedEvidenceBox,
      status: "recovery_accepted"
    });
    for (const artifact of result.recovered[0]!.artifactPaths) {
      const metadata = await sharp(artifact.path).metadata();
      expect(metadata.width).toBe(2);
      expect(metadata.height).toBe(100);
    }
  });

  it("independently expands a projected actual evidence box after downscaling", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Thin border", evidence: ["vertical border differs"] },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    const component = { box: { x: 10, y: 20, width: 1, height: 100 }, pixelCount: 500 };
    const result = await runTargetRecovery([component], makeCtx({
      recoveryCaller,
      actualRgba: makeRgba(100, 100),
      imagePairTransform: createImagePairTransform({ width: 200, height: 200 }, { width: 100, height: 100 })
    }), unlimitedBudget);

    expect(result.recovered[0]?.location).toEqual(component.box);
    expect(result.trace[0]).toMatchObject({
      componentBox: component.box,
      evidenceBox: { x: 10, y: 20, width: 2, height: 100 },
      actualEvidenceBox: { x: 5, y: 10, width: 2, height: 50 },
      status: "recovery_accepted"
    });
    const expectedArtifact = result.recovered[0]!.artifactPaths.find(artifact => artifact.role === "recovery_expected_crop")!;
    const actualArtifact = result.recovered[0]!.artifactPaths.find(artifact => artifact.role === "recovery_actual_crop")!;
    await expect(sharp(expectedArtifact.path).metadata()).resolves.toMatchObject({ width: 2, height: 100 });
    await expect(sharp(actualArtifact.path).metadata()).resolves.toMatchObject({ width: 2, height: 50 });
  });

  it("returns empty when no components are provided", async () => {
    const ctx = makeCtx();
    const { recovered, unclassifiedCount } = await runTargetRecovery([], ctx, unlimitedBudget);
    expect(recovered).toHaveLength(0);
    expect(unclassifiedCount).toBe(0);
  });

  it("treats classified:false as a valid no-regression verdict (not unclassified)", async () => {
    const ctx = makeCtx();
    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recovered).toHaveLength(0);
    expect(unclassifiedCount).toBe(0);
  });

  it("returns a DiffRecord when VLM classifies and reviewer accepts", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "geometry",
        severity: "medium",
        label: "Submit button",
        evidence: ["element shifted 15px"]
      },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "shift confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.criterion).toBe("geometry");
    expect(recovered[0]?.reviewerStatus).toBe("accepted");
    expect(recovered[0]).toMatchObject({ reviewerReason: "shift confirmed" });
    expect(recovered[0]?.model).toBe("test-model");
    expect(unclassifiedCount).toBe(0);
    // location snapped to pixel-component's deterministic bounds
    expect(recovered[0]?.location).toEqual(component.box);
  });

  it("does not require a crop-only VLM to invent screen coordinates", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "geometry",
        severity: "medium",
        label: "Button",
        evidence: ["shifted"]
      },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller });

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.location).toEqual(component.box);
    expect(unclassifiedCount).toBe(0);
  });

  it("marks component unclassified when reviewer rejects", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "color_appearance",
        severity: "low",
        label: "Background",
        coordinateFrame: "expected",
        box: { x: 10, y: 10, width: 80, height: 60 },
        evidence: ["background color changed"]
      },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "rejected", reason: "not a real diff" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recovered).toHaveLength(0);
    expect(unclassifiedCount).toBe(1);
  });

  it("ignores legacy VLM coordinates outside bounds and uses deterministic geometry", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "geometry",
        severity: "high",
        label: "Out-of-bounds element",
        coordinateFrame: "expected",
        box: { x: 150, y: 150, width: 200, height: 200 }, // exceeds 200x200
        evidence: ["element outside image"]
      },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller });

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.location).toEqual(component.box);
    expect(unclassifiedCount).toBe(0);
  });

  it("ignores legacy non-overlapping VLM coordinates and uses deterministic geometry", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "presence",
        severity: "high",
        label: "Unrelated element",
        coordinateFrame: "expected",
        box: { x: 140, y: 140, width: 50, height: 50 }, // far from component at (10,10)
        evidence: ["element missing"]
      },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller });

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.location).toEqual(component.box);
    expect(unclassifiedCount).toBe(0);
  });

  it("writes 4 artifact PNG files for each component", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: false },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller });

    await runTargetRecovery([component], ctx, unlimitedBudget);

    const files = await fs.readdir(tmpDir);
    const recoveryFiles = files.filter(f => f.startsWith("recovery-") && f.endsWith(".png"));
    expect(recoveryFiles.length).toBeGreaterThanOrEqual(4);
  });

  it("sends 4 images to recovery VLM", async () => {
    const captured: { images: string[] }[] = [];
    const recoveryCaller: VisionJsonCaller = vi.fn().mockImplementation(async (req) => {
      captured.push({ images: req.images });
      return {
        parsed: { classified: false },
        rawContent: "",
        model: "test-model",
        provider: "openrouter"
      };
    });
    const ctx = makeCtx({ recoveryCaller });

    await runTargetRecovery([component], ctx, unlimitedBudget);

    expect(captured[0]?.images).toHaveLength(4);
    for (const img of captured[0]?.images ?? []) {
      expect(img).toMatch(/^data:image\/png;base64,/);
    }
  });

  it("traces classified_false as an attempted no-regression verdict", async () => {
    const result = await runTargetRecovery([component], makeCtx(), unlimitedBudget);
    expect(result.trace[0]).toMatchObject({ status: "classified_false", pixelCount: component.pixelCount });
  });

  it("traces reviewer rejection and stores rejection reason", async () => {
    const result = await runTargetRecovery([component], makeCtx({
      recoveryCaller: vi.fn().mockResolvedValue({
        parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", coordinateFrame: "expected", box: component.box, evidence: ["visible"] },
        rawContent: "", model: "recovery-model", provider: "nvidia"
      }),
      reviewerCaller: vi.fn().mockResolvedValue({
        parsed: { decision: "rejected", reason: "not supported" },
        rawContent: "", model: "review-model", provider: "nvidia"
      })
    }), unlimitedBudget);
    expect(result.trace[0]).toMatchObject({
      status: "recovery_rejected",
      model: "recovery-model",
      reviewerModel: "review-model",
      rejectionReason: "not supported"
    });
    expect(result.regionOutcomes[0]).toMatchObject({
      regionId: "component-0001",
      state: "unresolved",
      reason: "reviewer_rejected: not supported",
      rejectionReason: "not supported"
    });
  });

  it("uses maxComponents as a batch size instead of skipping later components", async () => {
    const components = Array.from({ length: 3 }, (_, i) => ({ box: { x: i * 20, y: 0, width: 10, height: 10 }, pixelCount: 100 }));
    const result = await runTargetRecovery(components, makeCtx(), { maxComponents: 1, maxModelCalls: 10, deadlineMs: Date.now() + 300000, minComponentPixels: 1 });
    const skipped = result.trace.filter(t => t.status === "skipped_component_cap");
    expect(skipped).toHaveLength(0);
    expect(result.attemptedComponents).toBe(3);
    expect(result.batchCount).toBe(3);
    expect(result.cursor.nextRegionIndex).toBe(3);
    expect(result.cursor.remainingRegionIds).toHaveLength(0);
  });

  it("preserves artifacts and unresolved outcomes when deadline is already exhausted", async () => {
    const result = await runTargetRecovery([component], makeCtx(), {
      maxComponents: 10,
      maxModelCalls: 10,
      deadlineMs: Date.now() - 1,
      minComponentPixels: 1
    });
    expect(result.stoppedReason).toBe("deadline_exceeded");
    expect(result.trace[0]?.status).toBe("skipped_deadline");
    expect(result.trace[0]?.artifactPaths).toHaveLength(4);
    expect(result.regionOutcomes[0]).toMatchObject({ state: "unresolved", reason: "deadline_exceeded" });
  });

  it("traces recovery_accepted for accepted diff", async () => {
    const result = await runTargetRecovery([component], makeCtx({
      recoveryCaller: vi.fn().mockResolvedValue({
        parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", coordinateFrame: "expected", box: component.box, evidence: ["element shifted 15px"] },
        rawContent: "", model: "recovery-model", provider: "nvidia"
      }),
      reviewerCaller: vi.fn().mockResolvedValue({
        parsed: { decision: "accepted", reason: "confirmed" },
        rawContent: "", model: "review-model", provider: "nvidia"
      })
    }), unlimitedBudget);
    expect(result.trace[0]).toMatchObject({ status: "recovery_accepted", criterion: "geometry" });
    expect(result.trace[0]?.diffId).toBeTruthy();
  });

  it("processes all eligible regions across multiple batches", async () => {
    const ctx = makeCtx();
    const components: PixelComponent[] = Array.from({ length: 25 }, (_, i) => ({
      box: { x: (i % 5) * 35, y: Math.floor(i / 5) * 35, width: 20, height: 20 },
      pixelCount: 100 + i
    }));
    const budget: RecoveryBudget = {
      maxComponents: 12,
      maxModelCalls: 1000,
      deadlineMs: Date.now() + 300000,
      minComponentPixels: 1
    };
    const result = await runTargetRecovery(components, ctx, budget);
    expect(result.eligibleComponents).toBe(25);
    expect(result.attemptedComponents).toBe(25);
    expect(result.completedComponents).toBe(25);
    expect(result.remainingComponents).toBe(0);
    expect(result.batchCount).toBe(3);
    expect(result.skippedComponents).toBe(0);
    expect(result.stoppedReason).toBe("none");
    expect(result.statusCounts["skipped_component_cap"] ?? 0).toBe(0);
  });

  it("does not cap the default recovery budget below 25 eligible regions", async () => {
    vi.stubEnv("UI_DIFF_RECOVERY_BUDGET_MS", "300000");
    vi.stubEnv("UI_DIFF_MIN_RECOVERY_PIXELS", "1");
    const components: PixelComponent[] = Array.from({ length: 25 }, (_, i) => ({
      box: { x: (i % 5) * 35, y: Math.floor(i / 5) * 35, width: 20, height: 20 },
      pixelCount: 100 + i
    }));

    const result = await runTargetRecovery(components, makeCtx());

    expect(result.attemptedComponents).toBe(25);
    expect(result.remainingComponents).toBe(0);
    expect(result.stoppedReason).toBe("none");
  });

  it("preserves exact remaining region ids when model-call budget is exhausted", async () => {
    const components = Array.from({ length: 5 }, (_, index) => ({
      id: `region-${index + 1}`,
      box: { x: index * 30, y: 0, width: 20, height: 20 },
      pixelCount: 200 - index
    }));
    const result = await runTargetRecovery(components, makeCtx(), {
      maxComponents: 12,
      maxModelCalls: 2,
      deadlineMs: Date.now() + 300000,
      minComponentPixels: 1
    });

    expect(result.stoppedReason).toBe("model_call_cap");
    expect(result.attemptedComponents).toBe(2);
    expect(result.skippedComponents).toBe(3);
    expect(result.remainingComponents).toBe(3);
    expect(result.cursor.remainingRegionIds).toEqual(["region-3", "region-4", "region-5"]);
  });

  it("marks needs_escalation when reviewer throws", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "typography_content",
        severity: "medium",
        label: "Label text",
        coordinateFrame: "expected",
        box: { x: 10, y: 10, width: 80, height: 60 },
        evidence: ["text changed"]
      },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockRejectedValue(new Error("timeout"));
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.reviewerStatus).toBe("needs_escalation");
    expect(unclassifiedCount).toBe(1);
  });

  it("returns the recovery model name in the result", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "geometry",
        severity: "medium",
        label: "Submit button",
        coordinateFrame: "expected",
        box: { x: 10, y: 10, width: 80, height: 60 },
        evidence: ["element shifted 15px"]
      },
      rawContent: "",
      model: "test-model-123",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller });

    const { model } = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(model).toBe("test-model-123");
  });

  it("records statusCounts for each component outcome", async () => {
    const belowThresholdComponent: PixelComponent = { box: { x: 0, y: 0, width: 5, height: 5 }, pixelCount: 2 };
    const classifiedFalseComponent: PixelComponent = { box: { x: 10, y: 10, width: 80, height: 60 }, pixelCount: 500 };
    const missingFieldsComponent: PixelComponent = { box: { x: 10, y: 10, width: 80, height: 60 }, pixelCount: 600 };

    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({ parsed: { classified: false }, rawContent: "", model: "m1", provider: "openrouter" })
      .mockResolvedValueOnce({ parsed: { classified: true, criterion: "geometry", evidence: ["shifted"] }, rawContent: "", model: "m1", provider: "openrouter" });

    const budget: RecoveryBudget = { maxComponents: 100, maxModelCalls: 100, deadlineMs: Date.now() + 60000, minComponentPixels: 10 };
    const result = await runTargetRecovery(
      [belowThresholdComponent, classifiedFalseComponent, missingFieldsComponent],
      makeCtx({ recoveryCaller }),
      budget
    );

    expect(result.statusCounts["below_threshold"]).toBe(1);
    expect(result.statusCounts["classified_false"]).toBe(1);
    expect(result.statusCounts["missing_required_fields"]).toBe(1);
  });
});
