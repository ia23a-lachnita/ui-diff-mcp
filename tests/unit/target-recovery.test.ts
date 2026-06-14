import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTargetRecovery } from "../../src/recovery/target-recovery.js";
import type { RecoveryContext } from "../../src/recovery/target-recovery.js";
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
  it("returns empty when no components are provided", async () => {
    const ctx = makeCtx();
    const { recovered, unclassifiedCount } = await runTargetRecovery([], ctx);
    expect(recovered).toHaveLength(0);
    expect(unclassifiedCount).toBe(0);
  });

  it("marks component unclassified when VLM returns classified: false", async () => {
    const ctx = makeCtx();
    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx);
    expect(recovered).toHaveLength(0);
    expect(unclassifiedCount).toBe(1);
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

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.criterion).toBe("geometry");
    expect(recovered[0]?.reviewerStatus).toBe("accepted");
    expect(recovered[0]?.model).toBe("test-model");
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

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx);
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

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx);
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

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx);
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

    await runTargetRecovery([component], ctx);

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

    await runTargetRecovery([component], ctx);

    expect(captured[0]?.images).toHaveLength(4);
    for (const img of captured[0]?.images ?? []) {
      expect(img).toMatch(/^data:image\/png;base64,/);
    }
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

    const { recovered, unclassifiedCount } = await runTargetRecovery([component], ctx);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.reviewerStatus).toBe("needs_escalation");
    expect(unclassifiedCount).toBe(0);
  });
});
