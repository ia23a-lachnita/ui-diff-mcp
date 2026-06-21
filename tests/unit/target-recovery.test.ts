import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTargetRecovery } from "../../src/recovery/target-recovery.js";
import type { RecoveryBudget, RecoveryContext } from "../../src/recovery/target-recovery.js";
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
  const unlimitedBudget: RecoveryBudget = {
    maxComponents: 1000,
    maxModelCalls: 2000,
    deadlineMs: Date.now() + 300000,
    minComponentPixels: 1
  };

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
        coordinateFrame: "expected",
        box: { x: 10, y: 10, width: 80, height: 60 },
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
    expect(recovered[0]?.model).toBe("test-model");
    expect(unclassifiedCount).toBe(0);
    // coordinateFrame preserved in measurements
    const cfMeasurement = recovered[0]?.measurements.find(m => m.name === "coordinateFrame");
    expect(cfMeasurement?.value).toBe("expected");
    // location snapped to pixel-component's deterministic bounds
    expect(recovered[0]?.location).toEqual(component.box);
  });

  it("marks component unclassified when coordinateFrame is missing", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "geometry",
        severity: "medium",
        label: "Button",
        // coordinateFrame intentionally omitted
        box: { x: 10, y: 10, width: 80, height: 60 },
        evidence: ["shifted"]
      },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller });

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recovered).toHaveLength(0);
    expect(unclassifiedCount).toBe(1);
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

  it("rejects recovered box that is outside image bounds", async () => {
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
    expect(recovered).toHaveLength(0);
    expect(unclassifiedCount).toBe(1);
  });

  it("rejects recovered box that does not overlap the component", async () => {
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
    expect(recovered).toHaveLength(0);
    expect(unclassifiedCount).toBe(1);
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

  it("traces reviewer rejection", async () => {
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
    expect(result.trace[0]).toMatchObject({ status: "recovery_rejected", model: "recovery-model", reviewerModel: "review-model" });
  });

  it("traces skipped components caused by cap", async () => {
    const components = Array.from({ length: 3 }, (_, i) => ({ box: { x: i * 20, y: 0, width: 10, height: 10 }, pixelCount: 100 }));
    const result = await runTargetRecovery(components, makeCtx(), { maxComponents: 1, maxModelCalls: 10, deadlineMs: Date.now() + 300000, minComponentPixels: 1 });
    const skipped = result.trace.filter(t => t.status === "skipped_component_cap");
    expect(skipped).toHaveLength(2);
    expect(skipped.every(entry => entry.artifactPaths.length === 4)).toBe(true);
    await Promise.all(skipped.flatMap(entry => entry.artifactPaths).map(artifact => fs.access(artifact.path)));
    expect(result.cursor.nextRegionIndex).toBe(1);
    expect(result.cursor.remainingRegionIds).toHaveLength(2);
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

  it("caps recovery at maxComponents and reports skipped count", async () => {
    const ctx = makeCtx();
    const components: PixelComponent[] = Array.from({ length: 100 }, (_, i) => ({
      box: { x: i, y: i, width: 10, height: 10 },
      pixelCount: 100 + i
    }));
    const budget: RecoveryBudget = {
      maxComponents: 5,
      maxModelCalls: 1000,
      deadlineMs: Date.now() + 300000,
      minComponentPixels: 1
    };
    const result = await runTargetRecovery(components, ctx, budget);
    expect(result.attemptedComponents).toBe(5);
    expect(result.skippedComponents).toBe(95);
    // Capped components are unexamined, so stoppedReason must not be "none"
    // and unclassifiedCount must include all 95 capped entries.
    expect(result.stoppedReason).toBe("component_cap");
    expect(result.unclassifiedCount).toBeGreaterThanOrEqual(95);
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
    expect(unclassifiedCount).toBe(0);
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
      .mockResolvedValueOnce({ parsed: { classified: true, criterion: "geometry", label: "Button", box: { x: 10, y: 10, width: 80, height: 60 }, evidence: ["shifted"] }, rawContent: "", model: "m1", provider: "openrouter" });

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
