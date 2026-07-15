import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runTargetRecovery } from "../../src/recovery/target-recovery.js";
import type { RecoveryBudget, RecoveryContext } from "../../src/recovery/target-recovery.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";
import type { PixelComponent } from "../../src/signals/pixel-diff.js";
import type { VisionJsonCaller } from "../../src/models/vision-json.js";
import { RecoveryComponentTraceSchema, RecoveryRegionOutcomeSchema } from "../../src/schemas/core.js";

let tmpDir: string;
let overlayPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claim-repair-test-"));
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

const unlimitedBudget: RecoveryBudget = {
  maxComponents: 1000,
  maxModelCalls: 2000,
  deadlineMs: Date.now() + 300000,
  minComponentPixels: 1
};

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

describe("claim-repair: recovery prompt overlay color discipline", () => {
  it("recovery prompt describes overlay colors as diagnostic annotation ink, not UI colors", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: false },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    await runTargetRecovery([component], makeCtx({ recoveryCaller }), unlimitedBudget);
    const prompt = vi.mocked(recoveryCaller).mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("diagnostic");
    expect(prompt).toContain("cyan");
    expect(prompt).toContain("magenta");
    expect(prompt).toContain("yellow");
    expect(prompt).not.toMatch(/\bcyan\b[^.]*\b(?:background|fill|color)\b/i);
  });

  it("recovery prompt directs appearance/content claims to source crops 1-2", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: false },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    await runTargetRecovery([component], makeCtx({ recoveryCaller }), unlimitedBudget);
    const prompt = vi.mocked(recoveryCaller).mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("1. EXPECTED crop");
    expect(prompt).toContain("2. ACTUAL");
  });

  it("recovery prompt requires named deterministic source-color measurement for exact colors", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: false },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    await runTargetRecovery([component], makeCtx({ recoveryCaller }), unlimitedBudget);
    const prompt = vi.mocked(recoveryCaller).mock.calls[0]?.[0].prompt ?? "";
    expect(prompt).toContain("Exact");
    expect(prompt).toContain("deterministic measurement");
  });
});

describe("claim-repair: recovery-reviewer prompt overlay color discipline", () => {
  it("recovery-reviewer prompt describes overlay colors as diagnostic annotation ink", async () => {
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", evidence: ["element shifted"] },
      rawContent: "",
      model: "test-model",
      provider: "openrouter"
    });
    await runTargetRecovery([component], makeCtx({ recoveryCaller, reviewerCaller }), unlimitedBudget);
    const reviewerPrompt = vi.mocked(reviewerCaller).mock.calls[0]?.[0].prompt ?? "";
    expect(reviewerPrompt).toContain("diagnostic");
    expect(reviewerPrompt).toContain("cyan");
    expect(reviewerPrompt).toContain("magenta");
    expect(reviewerPrompt).toContain("yellow");
  });
});

describe("claim-repair: validateClaim before reviewer", () => {
  it("valid candidate proceeds to reviewer without repair", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", evidence: ["element shifted"] },
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
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recoveryCaller).toHaveBeenCalledOnce();
    expect(reviewerCaller).toHaveBeenCalledOnce();
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.reviewerStatus).toBe("accepted");
  });

  it("invalid candidate does NOT reach reviewer on initial call", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: {
        classified: true,
        criterion: "color_appearance",
        severity: "medium",
        label: "Background",
        evidence: ["background color is #FF0000"]
      },
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
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    await runTargetRecovery([component], ctx, unlimitedBudget);
    // First call is recovery, second should be repair (not reviewer)
    expect(recoveryCaller).toHaveBeenCalledTimes(2);
    expect(reviewerCaller).not.toHaveBeenCalled();
  });
});

describe("claim-repair: repair success for unsupported_exact_color", () => {
  it("repairs an unsupported_exact_color candidate by removing hex colors and reviewer accepts", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background color changed from light to dark"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "color difference confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.criterion).toBe("color_appearance");
    expect(result.recovered[0]?.reviewerStatus).toBe("accepted");
    expect(reviewerCaller).toHaveBeenCalledOnce();
  });

  it("repaired candidate trace includes repair metadata", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background color changed from light to dark"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "color difference confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    const trace = result.trace[0];
    expect(trace?.status).toBe("recovery_accepted");
    expect(trace?.repairAttempted).toBe(true);
    expect(trace?.repairModel).toBe("repair-model");
    expect(trace?.repairDurationMs).toBeGreaterThanOrEqual(0);
    expect(trace?.originalCandidateTitle).toBe("color_appearance in recovered region: Background");
    expect(trace?.originalCandidateEvidence).toEqual(["background color is #FF0000"]);
    expect(trace?.repairedCandidateTitle).toBe("color_appearance in recovered region: Background");
    expect(trace?.repairedCandidateEvidence).toEqual(["background color changed from light to dark"]);
  });
});

describe("claim-repair: repair success for unsupported_absence with source-grounded text", () => {
  it("repairs an unsupported_absence candidate when corrected text is source-grounded", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "presence",
          severity: "high",
          label: "Button",
          evidence: ["The actual screenshot is entirely blank."]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "presence",
          severity: "high",
          label: "Button",
          evidence: ["The button element is absent from the actual crop"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "absence confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.criterion).toBe("presence");
    expect(result.recovered[0]?.reviewerStatus).toBe("accepted");
  });

  it("rejects repaired absence claim that still contains unsupported global absence", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "presence",
          severity: "high",
          label: "Button",
          evidence: ["The actual screenshot is entirely blank."]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "presence",
          severity: "high",
          label: "Button",
          evidence: ["The entire image is empty and contains nothing"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(0);
    expect(result.statusCounts["still_invalid"]).toBe(1);
  });
});

describe("claim-repair: classified:false from repair", () => {
  it("repair returning classified:false remains unresolved", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
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
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(0);
    expect(result.unclassifiedCount).toBe(1);
    expect(result.statusCounts["repair_classified_false"]).toBe(1);
    expect(reviewerCaller).not.toHaveBeenCalled();
  });
});

describe("claim-repair: changed criterion from repair", () => {
  it("repair returning different criterion remains unresolved", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "geometry",
          severity: "medium",
          label: "Background",
          evidence: ["element shifted"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(0);
    expect(result.unclassifiedCount).toBe(1);
    expect(result.statusCounts["repair_criterion_change"]).toBe(1);
    expect(reviewerCaller).not.toHaveBeenCalled();
  });
});

describe("claim-repair: second invalid repair", () => {
  it("only one repair attempt is made; second failure remains unresolved", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #00FF00"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn();
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recoveryCaller).toHaveBeenCalledTimes(2);
    expect(reviewerCaller).not.toHaveBeenCalled();
    expect(result.recovered).toHaveLength(0);
    expect(result.statusCounts["still_invalid"]).toBe(1);
  });
});

describe("claim-repair: provider/schema failure during repair", () => {
  it("repair provider error remains unresolved", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockRejectedValueOnce(new Error("provider unavailable"));
    const reviewerCaller: VisionJsonCaller = vi.fn();
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(0);
    expect(result.unclassifiedCount).toBe(1);
    expect(result.statusCounts["repair_provider_failure"]).toBe(1);
    expect(reviewerCaller).not.toHaveBeenCalled();
  });

  it("repair schema error remains unresolved", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: { classified: "yes" },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn();
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(0);
    expect(result.unclassifiedCount).toBe(1);
    expect(result.statusCounts["repair_schema_failure"]).toBe(1);
    expect(reviewerCaller).not.toHaveBeenCalled();
  });
});

describe("claim-repair: no repair for valid candidate", () => {
  it("does not call repair for a candidate that passes validateClaim", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", evidence: ["element shifted"] },
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
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recoveryCaller).toHaveBeenCalledOnce();
    expect(reviewerCaller).toHaveBeenCalledOnce();
  });
});

describe("claim-repair: exactly one repair call", () => {
  it("makes at most one repair call per invalid candidate", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
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
      });
    const reviewerCaller: VisionJsonCaller = vi.fn();
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(recoveryCaller).toHaveBeenCalledTimes(2);
    expect(reviewerCaller).not.toHaveBeenCalled();
  });
});

describe("claim-repair: call budget accounting includes repair", () => {
  it("repair call counts toward model call budget", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background changed"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    // Budget of 3: 1 initial + 1 repair + 1 reviewer
    const result = await runTargetRecovery([component], ctx, {
      maxComponents: 100,
      maxModelCalls: 3,
      deadlineMs: Date.now() + 300000,
      minComponentPixels: 1
    });
    expect(result.recovered).toHaveLength(1);
    expect(result.cursor.remainingModelCalls).toBe(0);
  });
});

describe("claim-repair: reviewer receives repaired candidate", () => {
  it("reviewer prompt contains repaired evidence and original candidate context for semantic substitution detection", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background color changed from light to dark"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    await runTargetRecovery([component], ctx, unlimitedBudget);
    const reviewerPrompt = vi.mocked(reviewerCaller).mock.calls[0]?.[0].prompt ?? "";
    expect(reviewerPrompt).toContain("background color changed from light to dark");
    // Original evidence is included in ORIGINAL CANDIDATE section for semantic substitution detection
    expect(reviewerPrompt).toContain("#FF0000");
    expect(reviewerPrompt).toContain("ORIGINAL CANDIDATE");
    expect(reviewerPrompt).toContain("REPAIRED CANDIDATE");
  });
});

describe("claim-repair: same four images for repair", () => {
  it("repair call receives the same four images as the initial recovery call", async () => {
    const capturedImages: string[][] = [];
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockImplementation(async (req) => {
        capturedImages.push([...req.images]);
        if (capturedImages.length === 1) {
          return {
            parsed: {
              classified: true,
              criterion: "color_appearance",
              severity: "medium",
              label: "Background",
              evidence: ["color is #FF0000"]
            },
            rawContent: "",
            model: "recovery-model",
            provider: "openrouter"
          };
        }
        return {
          parsed: {
            classified: true,
            criterion: "color_appearance",
            severity: "medium",
            label: "Background",
            evidence: ["background changed"]
          },
          rawContent: "",
          model: "repair-model",
          provider: "openrouter"
        };
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(capturedImages).toHaveLength(2);
    expect(capturedImages[0]).toHaveLength(4);
    expect(capturedImages[1]).toHaveLength(4);
    expect(capturedImages[0]).toEqual(capturedImages[1]);
  });
});

describe("claim-repair: repair prompt contains diagnostic information", () => {
  it("repair prompt includes original candidate, diagnostic code/message/excerpt, and measurements", async () => {
    const capturedPrompts: string[] = [];
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockImplementation(async (req) => {
        capturedPrompts.push(req.prompt);
        if (capturedPrompts.length === 1) {
          return {
            parsed: {
              classified: true,
              criterion: "color_appearance",
              severity: "medium",
              label: "Background",
              evidence: ["color is #FF0000"]
            },
            rawContent: "",
            model: "recovery-model",
            provider: "openrouter"
          };
        }
        return {
          parsed: {
            classified: true,
            criterion: "color_appearance",
            severity: "medium",
            label: "Background",
            evidence: ["background changed"]
          },
          rawContent: "",
          model: "repair-model",
          provider: "openrouter"
        };
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    await runTargetRecovery([component], ctx, unlimitedBudget);
    const repairPrompt = capturedPrompts[1] ?? "";
    expect(repairPrompt).toContain("repair");
    expect(repairPrompt).toContain("unsupported_exact_color");
    expect(repairPrompt).not.toContain("#FF0000");
    expect(repairPrompt).toContain("changed_pixel_count");
  });
});

describe("claim-repair: schema round-trip of original/repaired diagnostics", () => {
  it("trace and outcome survive schema validation with repair fields", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background changed"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(() => RecoveryComponentTraceSchema.array().parse(result.trace)).not.toThrow();
    expect(() => RecoveryRegionOutcomeSchema.array().parse(result.regionOutcomes)).not.toThrow();
  });

  it("repair failure trace and outcome survive schema validation", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockRejectedValueOnce(new Error("timeout"));
    const reviewerCaller: VisionJsonCaller = vi.fn();
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(() => RecoveryComponentTraceSchema.array().parse(result.trace)).not.toThrow();
    expect(() => RecoveryRegionOutcomeSchema.array().parse(result.regionOutcomes)).not.toThrow();
  });
});

describe("claim-repair: reviewer rejection after repair remains unresolved", () => {
  it("reviewer rejection after repair stays unresolved", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background changed"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "rejected", reason: "not a real diff" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(0);
    expect(result.unclassifiedCount).toBe(1);
    expect(result.statusCounts["recovery_rejected"]).toBe(1);
  });
});

describe("claim-repair: reviewer escalation after repair remains unresolved", () => {
  it("reviewer escalation after repair stays unresolved", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["color is #FF0000"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Background",
          evidence: ["background changed"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "needs_escalation", reason: "ambiguous" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(0);
    expect(result.unclassifiedCount).toBe(1);
  });
});

describe("claim-repair: repair prompt decontamination for unsupported_exact_color (region-0085 style)", () => {
  it("repair prompt must not contain hex colors, original title, or evidence excerpt", async () => {
    const capturedPrompts: string[] = [];
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockImplementation(async (req) => {
        capturedPrompts.push(req.prompt);
        if (capturedPrompts.length === 1) {
          return {
            parsed: {
              classified: true,
              criterion: "color_appearance",
              severity: "medium",
              label: "Header background",
              evidence: ["background color is #1A2B3C", "fill is #445566"]
            },
            rawContent: "",
            model: "recovery-model",
            provider: "openrouter"
          };
        }
        return {
          parsed: {
            classified: true,
            criterion: "color_appearance",
            severity: "medium",
            label: "Header background",
            evidence: ["background color changed from dark to light"]
          },
          rawContent: "",
          model: "repair-model",
          provider: "openrouter"
        };
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    await runTargetRecovery([component], ctx, unlimitedBudget);
    const repairPrompt = capturedPrompts[1] ?? "";
    expect(repairPrompt).not.toContain("#1A2B3C");
    expect(repairPrompt).not.toContain("#445566");
    expect(repairPrompt).not.toContain("background color is #1A2B3C");
    expect(repairPrompt).not.toContain("fill is #445566");
    expect(repairPrompt).not.toContain("Header background is #1A2B3C");
    expect(repairPrompt).toContain("unsupported_exact_color");
    expect(repairPrompt).toContain("color_appearance");
    expect(repairPrompt).toContain("changed_pixel_count");
  });

  it("repaired valid candidate proceeds to reviewer and is accepted", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Header background",
          evidence: ["background color is #1A2B3C"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Header background",
          evidence: ["background color changed from dark to light"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "color difference confirmed" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.criterion).toBe("color_appearance");
    expect(result.recovered[0]?.reviewerStatus).toBe("accepted");
    const trace = result.trace.find(t => t.status === "recovery_accepted");
    expect(trace?.repairAttempted).toBe(true);
    expect(reviewerCaller).toHaveBeenCalledOnce();
  });
});

describe("claim-repair: reviewer continuity for gradient-vs-flat wording (region-0090 style)", () => {
  it("gradient-vs-flat original and uniform-color-replacement repaired candidate can be semantically continuous", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Header",
          evidence: ["gradient changed to flat color"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Header",
          evidence: ["fill appearance changed from gradient to uniform"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "accepted", reason: "same visual observation with reworded label" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(1);
    expect(result.recovered[0]?.criterion).toBe("color_appearance");
    expect(result.recovered[0]?.reviewerStatus).toBe("accepted");
  });

  it("true substitution (gradient-vs-flat to missing icon) remains rejectable", async () => {
    const recoveryCaller: VisionJsonCaller = vi.fn()
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "color_appearance",
          severity: "medium",
          label: "Header",
          evidence: ["gradient changed to flat color #AABBCC"]
        },
        rawContent: "",
        model: "recovery-model",
        provider: "openrouter"
      })
      .mockResolvedValueOnce({
        parsed: {
          classified: true,
          criterion: "presence",
          severity: "high",
          label: "Header",
          evidence: ["icon element is missing from actual"]
        },
        rawContent: "",
        model: "repair-model",
        provider: "openrouter"
      });
    const reviewerCaller: VisionJsonCaller = vi.fn().mockResolvedValue({
      parsed: { decision: "rejected", reason: "different visual observation" },
      rawContent: "",
      model: "test-reviewer",
      provider: "openrouter"
    });
    const ctx = makeCtx({ recoveryCaller, reviewerCaller });
    const result = await runTargetRecovery([component], ctx, unlimitedBudget);
    expect(result.recovered).toHaveLength(0);
    expect(result.statusCounts["repair_criterion_change"]).toBe(1);
  });
});
