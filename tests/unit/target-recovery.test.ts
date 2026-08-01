import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTargetRecovery, computeRecoveryContextBox } from "../../src/recovery/target-recovery.js";
import type { RecoveryBudget, RecoveryContext } from "../../src/recovery/target-recovery.js";
import { createImagePairTransform } from "../../src/images/coordinates.js";
import type { PixelComponent } from "../../src/signals/pixel-diff.js";
import type { VisionJsonCaller } from "../../src/models/vision-json.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";
import { RecoveryComponentTraceSchema, RecoveryRegionOutcomeSchema } from "../../src/schemas/core.js";
import type { ReviewerHandle } from "../../src/audit/audit-target.js";
import { modelFamilyKey } from "../../src/models/model-registry.js";

let tmpDir: string;
let overlayPath: string;

function makeReviewerHandle(caller: VisionJsonCaller, provider: string, model: string): ReviewerHandle {
  return { caller, routes: [{ provider, model, familyKey: modelFamilyKey(model) }] };
}

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

type RecoveryTestOverrides = Omit<Partial<RecoveryContext>, "reviewerResolver"> & {
  reviewerCaller?: VisionJsonCaller;
  reviewerResolver?: RecoveryContext["reviewerResolver"];
};

function makeCtx(overrides: RecoveryTestOverrides = {}): RecoveryContext {
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
  const customReviewer = overrides.reviewerCaller;
  const reviewerResolver = overrides.reviewerResolver ?? (() => makeReviewerHandle(
    customReviewer ?? reviewerCaller,
    "openrouter",
    "test-reviewer"
  ));
  const { reviewerCaller: _reviewerCaller, reviewerResolver: _reviewerResolver, ...contextOverrides } = overrides;
  return {
    expectedRgba: makeRgba(200, 200),
    actualRgba: makeRgba(200, 200),
    pixelDiffMask: makeMask(200, 200),
    directionalOverlayPath: overlayPath,
    artifactDir: tmpDir,
    recoveryCaller,
    reviewerResolver,
    ...contextOverrides
  };
}

const component: PixelComponent = {
  box: { x: 10, y: 10, width: 80, height: 60 },
  pixelCount: 500
};

describe("runTargetRecovery", () => {
  it("requires a resolver and has no static reviewer field in RecoveryContext", () => {
    const completeContext = makeCtx();
    const { reviewerResolver: _resolver, ...withoutResolver } = completeContext;
    // @ts-expect-error RecoveryContext requires reviewerResolver.
    const omittedResolver: RecoveryContext = withoutResolver;
    // @ts-expect-error RecoveryContext does not accept reviewerCaller as a static fallback.
    const staticReviewer: RecoveryContext = { ...completeContext, reviewerCaller: vi.fn() };
    void omittedResolver;
    void staticReviewer;
  });

  it("fails closed when the required reviewer resolver returns null without calling a reviewer", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", evidence: ["shifted"] },
      rawContent: "",
      model: "recovery-model",
      provider: "mistral"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn();
    const result = await runTargetRecovery([component], makeCtx({
      recoveryCaller,
      reviewerCaller,
      reviewerResolver: () => null
    }), unlimitedBudget);

    expect(reviewerCaller).not.toHaveBeenCalled();
    expect(result.statusCounts["independent_reviewer_unavailable"]).toBe(1);
    expect(result.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "independent_reviewer_unavailable", provider: "mistral" })
    ]));
  });

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
    ["interior", { x: 16, y: 20, width: 1, height: 100 }, { x: 0, y: 20, width: 64, height: 100 }],
    ["right edge", { x: 199, y: 20, width: 1, height: 100 }, { x: 136, y: 20, width: 64, height: 100 }]
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
      expect(metadata.width).toBe(64);
      expect(metadata.height).toBe(100);
    }
  });

  it("projects actual evidence box to source resolution without re-expansion", async () => {
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
      evidenceBox: { x: 0, y: 20, width: 64, height: 100 },
      actualEvidenceBox: { x: 0, y: 10, width: 32, height: 50 },
      status: "recovery_accepted"
    });
    const expectedArtifact = result.recovered[0]!.artifactPaths.find(artifact => artifact.role === "recovery_expected_crop")!;
    const actualArtifact = result.recovered[0]!.artifactPaths.find(artifact => artifact.role === "recovery_actual_crop")!;
    const comparisonArtifact = result.recovered[0]!.artifactPaths.find(artifact => artifact.role === "recovery_actual_comparison_crop")!;
    await expect(sharp(expectedArtifact.path).metadata()).resolves.toMatchObject({ width: 64, height: 100 });
    await expect(sharp(actualArtifact.path).metadata()).resolves.toMatchObject({ width: 32, height: 50 });
    await expect(sharp(comparisonArtifact.path).metadata()).resolves.toMatchObject({ width: 64, height: 100 });
  });

  it("preserves source actual dimensions while sending an expected-sized comparison crop", async () => {
    const captured: { images: string[] }[] = [];
    const recoveryCaller: VisionJsonCaller = vi.fn().mockImplementation(async request => {
      captured.push({ images: request.images });
      return { parsed: { classified: false }, rawContent: "", model: "test-model", provider: "openrouter" };
    });
    const result = await runTargetRecovery([component], makeCtx({
      recoveryCaller,
      actualRgba: makeRgba(100, 100),
      imagePairTransform: createImagePairTransform({ width: 200, height: 200 }, { width: 100, height: 100 })
    }), unlimitedBudget);

    const artifacts = result.trace[0]!.artifactPaths;
    const sourceActual = artifacts.find(artifact => artifact.role === "recovery_actual_crop")!;
    const comparisonActual = artifacts.find(artifact => artifact.role === "recovery_actual_comparison_crop")!;
    await expect(sharp(sourceActual.path).metadata()).resolves.toMatchObject({ width: 40, height: 32 });
    await expect(sharp(comparisonActual.path).metadata()).resolves.toMatchObject({ width: 80, height: 64 });
    const imageMetadata = await Promise.all(captured[0]!.images.slice(0, 2).map(async dataUrl => {
      const buffer = Buffer.from(dataUrl.split(",")[1]!, "base64");
      return sharp(buffer).metadata();
    }));
    expect(imageMetadata[0]).toMatchObject({ width: 80, height: 64 });
    expect(imageMetadata[1]).toMatchObject({ width: 80, height: 64 });
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
        evidence: ["element visibly shifted"]
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
    expect(recovered[0]?.measurements).toEqual(expect.arrayContaining([
      { name: "changed_pixel_count", value: 500, unit: "pixels" },
      { name: "region_area_pixels", value: 4800, unit: "px²" },
      { name: "changed_pixel_percent", value: 10.42, unit: "%" },
      { name: "coordinateSource", value: "deterministic_pixel_component" }
    ]));
    // location snapped to pixel-component's deterministic bounds
    expect(recovered[0]?.location).toEqual(component.box);
  });

  it("passes identical deterministic measurements to recovery and reviewer prompts", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", evidence: ["shifted"] },
      rawContent: "", model: "recovery-model", provider: "openrouter"
    });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "", model: "review-model", provider: "openrouter"
    });
    await runTargetRecovery([component], makeCtx({ recoveryCaller, reviewerCaller }), unlimitedBudget);
    const recoveryPrompt = vi.mocked(recoveryCaller).mock.calls[0]?.[0].prompt ?? "";
    const reviewerPrompt = vi.mocked(reviewerCaller).mock.calls[0]?.[0].prompt ?? "";
    for (const prompt of [recoveryPrompt, reviewerPrompt]) {
      expect(prompt).toContain("changed_pixel_count: 500 pixels");
      expect(prompt).toContain("region_area_pixels: 4800 px²");
      expect(prompt).toContain("changed_pixel_percent: 10.42 %");
      expect(prompt).toContain("coordinateSource: deterministic_pixel_component");
    }
  });

  it("rejects reviewer-accepted unsupported claims as unresolved recovery evidence", async () => {
    const result = await runTargetRecovery([component], makeCtx({
      recoveryCaller: vi.fn()
        .mockResolvedValueOnce({
          parsed: { classified: true, criterion: "presence", severity: "high", label: "Button", evidence: ["The actual screenshot is entirely blank."] },
          rawContent: "", model: "recovery-model", provider: "openrouter"
        })
        .mockResolvedValueOnce({
          parsed: { classified: false },
          rawContent: "", model: "repair-model", provider: "openrouter"
        }),
      reviewerCaller: vi.fn().mockResolvedValue({
        parsed: { decision: "accepted", reason: "confirmed" },
        rawContent: "", model: "review-model", provider: "openrouter"
      })
    }), unlimitedBudget);

    expect(result.recovered).toHaveLength(0);
    expect(result.unclassifiedCount).toBe(1);
    // Repair flow: validateClaim catches unsupported_absence before reviewer,
    // repair mock returns classified:false → repair_classified_false
    expect(result.statusCounts["repair_classified_false"]).toBe(1);
    expect(result.trace[0]).toMatchObject({
      status: "repair_classified_false",
      artifactPaths: expect.arrayContaining([expect.objectContaining({ role: "recovery_expected_crop" })])
    });
    expect(result.regionOutcomes[0]).toMatchObject({
      state: "unresolved",
      reason: "repair_classified_false",
      artifactPaths: expect.arrayContaining([expect.objectContaining({ role: "recovery_pixel_diff_mask" })])
    });
  });

  it("bounds long candidate evidence before schema-parsing the actual trace and outcome", async () => {
    const result = await runTargetRecovery([component], makeCtx({
      recoveryCaller: vi.fn()
        .mockResolvedValueOnce({
          parsed: {
            classified: true,
            criterion: "presence",
            severity: "high",
            label: "Recovered target",
            evidence: ["The actual screenshot is entirely blank. " + "evidence ".repeat(40)]
          },
          rawContent: "",
          model: "recovery-model",
          provider: "openrouter"
        })
        .mockResolvedValueOnce({
          parsed: { classified: false },
          rawContent: "",
          model: "repair-model",
          provider: "openrouter"
        }),
      reviewerCaller: vi.fn().mockResolvedValue({
        parsed: { decision: "accepted", reason: "confirmed" },
        rawContent: "",
        model: "review-model",
        provider: "openrouter"
      })
    }), unlimitedBudget);

    const trace = RecoveryComponentTraceSchema.array().parse(result.trace);
    const outcomes = RecoveryRegionOutcomeSchema.array().parse(result.regionOutcomes);
    // Repair flow: validateClaim catches unsupported_absence before reviewer,
    // repair mock returns classified:false → repair_classified_false
    expect(trace[0]?.status).toBe("repair_classified_false");
    expect(trace[0]?.repairAttempted).toBe(true);
    expect(outcomes[0]?.state).toBe("unresolved");
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
        evidence: ["element is missing within the supplied crop"]
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

  it("writes 5 artifact PNG files for each component", async () => {
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
    expect(recoveryFiles.length).toBeGreaterThanOrEqual(5);
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
      }),
      reviewerResolver: (provider, model) => makeReviewerHandle(
        vi.fn().mockResolvedValue({
          parsed: { decision: "rejected", reason: "not supported" },
          rawContent: "", model: "review-model", provider: "nvidia"
        }),
        "nvidia",
        "review-model"
      )
    }), unlimitedBudget);
    expect(result.trace[0]).toMatchObject({
      status: "recovery_rejected",
      model: "recovery-model",
      reviewerModel: "review-model",
      rejectionReason: "not supported",
      candidateTitle: "geometry in recovered region: Button",
      candidateEvidence: ["visible"],
      candidateMeasurements: expect.arrayContaining([
        { name: "changed_pixel_count", value: 500, unit: "pixels" }
      ]),
      recoveryDurationMs: expect.any(Number),
      reviewerDurationMs: expect.any(Number),
      artifactPaths: expect.arrayContaining([
        expect.objectContaining({ role: "recovery_actual_crop" }),
        expect.objectContaining({ role: "recovery_actual_comparison_crop" })
      ])
    });
    expect(result.regionOutcomes[0]).toMatchObject({
      regionId: "component-0001",
      state: "unresolved",
      reason: "reviewer_rejected: not supported",
      rejectionReason: "not supported",
      candidateTitle: "geometry in recovered region: Button",
      candidateEvidence: ["visible"],
      candidateMeasurements: expect.arrayContaining([
        { name: "changed_pixel_count", value: 500, unit: "pixels" }
      ]),
      model: "recovery-model",
      reviewerModel: "review-model",
      recoveryDurationMs: expect.any(Number),
      reviewerDurationMs: expect.any(Number),
      artifactPaths: expect.arrayContaining([
        expect.objectContaining({ role: "recovery_actual_crop" }),
        expect.objectContaining({ role: "recovery_actual_comparison_crop" })
      ])
    });
    expect(result.trace[0]!.artifactPaths).toHaveLength(5);
    expect(result.regionOutcomes[0]!.artifactPaths).toHaveLength(5);
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
    expect(result.trace[0]?.artifactPaths).toHaveLength(5);
    expect(result.regionOutcomes[0]).toMatchObject({ state: "unresolved", reason: "deadline_exceeded" });
  });

  it("traces recovery_accepted for accepted diff", async () => {
    const result = await runTargetRecovery([component], makeCtx({
      recoveryCaller: vi.fn().mockResolvedValue({
        parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", coordinateFrame: "expected", box: component.box, evidence: ["element visibly shifted"] },
        rawContent: "", model: "recovery-model", provider: "nvidia"
      }),
      reviewerCaller: vi.fn().mockResolvedValue({
        parsed: { decision: "accepted", reason: "confirmed" },
        rawContent: "", model: "review-model", provider: "nvidia"
      }),
      reviewerResolver: (provider, model) => makeReviewerHandle(
        vi.fn().mockResolvedValue({
          parsed: { decision: "accepted", reason: "confirmed" },
          rawContent: "", model: "review-model", provider: "nvidia"
        }),
        "nvidia",
        "review-model"
      )
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
    // Escalation now remains unresolved per fail-closed recovery repair stage
    expect(recovered).toHaveLength(0);
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

  it("propagates explicit component IDs into trace and regionOutcomes for accepted regions", async () => {
    const components = [
      { id: "alpha-region", box: { x: 10, y: 10, width: 40, height: 40 }, pixelCount: 400 },
      { id: "beta-region", box: { x: 60, y: 60, width: 40, height: 40 }, pixelCount: 300 }
    ];
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: { classified: true, criterion: "geometry", severity: "medium", label: "A", evidence: ["a"] },
        rawContent: "", model: "m1", provider: "p1"
      })
      .mockResolvedValueOnce({
        parsed: { classified: true, criterion: "color_appearance", severity: "low", label: "B", evidence: ["b"] },
        rawContent: "", model: "m1", provider: "p1"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValue({ parsed: { decision: "accepted", reason: "ok" }, rawContent: "", model: "r1", provider: "p1" });

    const result = await runTargetRecovery(components, makeCtx({
      recoveryCaller,
      reviewerCaller,
      reviewerResolver: () => makeReviewerHandle(reviewerCaller, "p1", "r1")
    }), unlimitedBudget);

    expect(result.recovered).toHaveLength(2);
    expect(result.eligibleComponents).toBe(2);
    expect(result.completedComponents).toBe(2);
    expect(result.attemptedComponents).toBe(2);
    expect(result.skippedComponents).toBe(0);
    expect(result.remainingComponents).toBe(0);
    expect(result.unclassifiedCount).toBe(0);
    expect(result.stoppedReason).toBe("none");
    expect(result.statusCounts["recovery_accepted"]).toBe(2);
    expect(result.statusCounts["deferred_broad_evidence_fragment"] ?? 0).toBe(0);

    expect(result.trace[0]!.componentId).toBe("alpha-region");
    expect(result.trace[1]!.componentId).toBe("beta-region");
    expect(result.regionOutcomes[0]!.regionId).toBe("alpha-region");
    expect(result.regionOutcomes[1]!.regionId).toBe("beta-region");

    expect(result.regionOutcomes[0]!.findingId).toBe(result.recovered[0]!.id);
    expect(result.regionOutcomes[1]!.findingId).toBe(result.recovered[1]!.id);

    expect(result.recovered[0]!.id).toBeTruthy();
    expect(result.recovered[1]!.id).toBeTruthy();
    expect(result.recovered[0]!.id).not.toBe(result.recovered[1]!.id);
  });

  it("preserves exact summary counts when no deferred regions are present", async () => {
    const belowComponent: PixelComponent = { box: { x: 0, y: 0, width: 5, height: 5 }, pixelCount: 2 };
    const validComponent: PixelComponent = { box: { x: 10, y: 10, width: 80, height: 60 }, pixelCount: 500 };
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: false },
      rawContent: "", model: "m1", provider: "p1"
    });

    const budget: RecoveryBudget = { maxComponents: 100, maxModelCalls: 100, deadlineMs: Date.now() + 60000, minComponentPixels: 10 };
    const result = await runTargetRecovery([belowComponent, validComponent], makeCtx({ recoveryCaller }), budget);

    expect(result.statusCounts["below_threshold"]).toBe(1);
    expect(result.statusCounts["classified_false"]).toBe(1);
    expect(result.statusCounts["deferred_broad_evidence_fragment"] ?? 0).toBe(0);
    expect(result.eligibleComponents).toBe(1);
    expect(result.completedComponents).toBe(1);
    expect(result.attemptedComponents).toBe(1);
    expect(result.recovered.length).toBe(0);
    expect(result.unclassifiedCount).toBe(0);
  });
});

describe("computeRecoveryContextBox", () => {
  const canvas = { width: 400, height: 900 };

  it("expands 1x408 vertical border to 64x408 centered", () => {
    const box = { x: 50, y: 10, width: 1, height: 408 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result).toEqual({ x: 19, y: 10, width: 64, height: 408 });
  });

  it("expands 172x20 bar short axis to 64 centered", () => {
    const box = { x: 20, y: 100, width: 172, height: 20 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result).toEqual({ x: 20, y: 78, width: 172, height: 64 });
  });

  it("expands a thin interior region centered to 64 on short axis", () => {
    const box = { x: 16, y: 20, width: 1, height: 100 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result.width).toBe(64);
    expect(result.height).toBe(100);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.x + result.width).toBeLessThanOrEqual(canvas.width);
  });

  it("clamps at right edge without shrinking below 64", () => {
    const box = { x: 390, y: 20, width: 8, height: 100 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result).toEqual({ x: 336, y: 20, width: 64, height: 100 });
    expect(result.x + result.width).toBeLessThanOrEqual(canvas.width);
  });

  it("clamps at left edge without shrinking below 64", () => {
    const box = { x: 2, y: 20, width: 5, height: 100 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result).toEqual({ x: 0, y: 20, width: 64, height: 100 });
    expect(result.x).toBeGreaterThanOrEqual(0);
  });

  it("clamps at bottom edge without shrinking below 64", () => {
    const box = { x: 50, y: 860, width: 100, height: 38 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result).toEqual({ x: 50, y: 836, width: 100, height: 64 });
    expect(result.y + result.height).toBeLessThanOrEqual(canvas.height);
  });

  it("clamps at top edge without shrinking below 64", () => {
    const box = { x: 50, y: 5, width: 100, height: 10 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result).toEqual({ x: 50, y: 0, width: 100, height: 64 });
    expect(result.y).toBeGreaterThanOrEqual(0);
  });

  it("keeps long axis unexpanded for 1x408", () => {
    const box = { x: 50, y: 10, width: 1, height: 408 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result.height).toBe(408);
  });

  it("keeps long axis unexpanded for 172x20", () => {
    const box = { x: 20, y: 100, width: 172, height: 20 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result.width).toBe(172);
  });

  it("does not mutate the original box", () => {
    const box = { x: 50, y: 20, width: 1, height: 100 };
    const original = { ...box };
    computeRecoveryContextBox(box, canvas);
    expect(box).toEqual(original);
  });

  it("expands to viewport size when viewport is smaller than 64", () => {
    const smallCanvas = { width: 30, height: 200 };
    const box = { x: 5, y: 10, width: 2, height: 100 };
    const result = computeRecoveryContextBox(box, smallCanvas);
    expect(result.width).toBe(30);
    expect(result.height).toBe(100);
  });

  it("handles a box already larger than 64 without shrinking", () => {
    const box = { x: 10, y: 10, width: 100, height: 100 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result).toEqual({ x: 10, y: 10, width: 100, height: 100 });
  });

  it("clamps both axes simultaneously at corner", () => {
    const box = { x: 380, y: 870, width: 20, height: 30 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result.x + result.width).toBeLessThanOrEqual(canvas.width);
    expect(result.y + result.height).toBeLessThanOrEqual(canvas.height);
    expect(result.width).toBeGreaterThanOrEqual(20);
    expect(result.height).toBeGreaterThanOrEqual(30);
  });

  it("handles viewport exactly 64 wide", () => {
    const exactCanvas = { width: 64, height: 200 };
    const box = { x: 10, y: 20, width: 2, height: 80 };
    const result = computeRecoveryContextBox(box, exactCanvas);
    expect(result.width).toBe(64);
    expect(result.x).toBe(0);
  });

  it("handles box at origin", () => {
    const box = { x: 0, y: 0, width: 1, height: 1 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result).toEqual({ x: 0, y: 0, width: 64, height: 64 });
  });

  it("handles box spanning full canvas width", () => {
    const box = { x: 0, y: 10, width: 400, height: 50 };
    const result = computeRecoveryContextBox(box, canvas);
    expect(result.width).toBe(400);
    expect(result.height).toBe(64);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.y + result.height).toBeLessThanOrEqual(canvas.height);
  });

  it("uses per-axis clamping for non-square canvas with height below 64", () => {
    const tallNarrow = { width: 200, height: 40 };
    const box = { x: 50, y: 5, width: 10, height: 30 };
    const result = computeRecoveryContextBox(box, tallNarrow);
    expect(result.width).toBe(64);
    expect(result.height).toBe(40);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.x + result.width).toBeLessThanOrEqual(tallNarrow.width);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.y + result.height).toBeLessThanOrEqual(tallNarrow.height);
  });

  it("resolves fractional projected coordinates through comparison geometry", () => {
    const projectedBox = { x: 25, y: 5, width: 0.5, height: 204 };
    const contextBox = computeRecoveryContextBox(projectedBox, { width: 200, height: 450 });
    expect(contextBox.width).toBe(64);
    expect(contextBox.height).toBe(204);
    expect(contextBox.x).toBeGreaterThanOrEqual(0);
    expect(contextBox.y).toBeGreaterThanOrEqual(0);
  });
});
