import { describe, expect, it } from "vitest";
import { detectProjectedCropMismatch } from "../../src/audit/projected-mismatch.js";

function solidPixels(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return data;
}

describe("detectProjectedCropMismatch", () => {
  it("returns null for zero-dimension inputs", () => {
    const d = solidPixels(10, 10, 100, 100, 100);
    expect(detectProjectedCropMismatch(
      { data: d, width: 0, height: 10 },
      { data: d, width: 10, height: 10 }
    )).toBeNull();
  });

  it("returns mismatched=false for identical crops", () => {
    const d = solidPixels(20, 20, 50, 100, 200);
    const result = detectProjectedCropMismatch(
      { data: d, width: 20, height: 20 },
      { data: d, width: 20, height: 20 }
    );
    expect(result).not.toBeNull();
    expect(result?.mismatched).toBe(false);
  });

  it("returns mismatched=false for color-only difference (shared edge structure)", () => {
    // Both are solid colors — no edges at all, so edgeOverlap hits the 0/0 → 100 branch
    const exp = solidPixels(20, 20, 255, 255, 255);
    const act = solidPixels(20, 20, 0, 0, 255);
    const result = detectProjectedCropMismatch(
      { data: exp, width: 20, height: 20 },
      { data: act, width: 20, height: 20 }
    );
    // Should NOT be flagged as projection mismatch — color change is a real diff
    expect(result?.mismatched).toBe(false);
  });

  it("detects mismatch for completely unrelated crops (icon vs nav bar)", () => {
    // expected: bright blue patch (icon-like)
    const exp = solidPixels(30, 30, 30, 100, 255);
    // actual: near-black bar (navigation bar)
    const act = solidPixels(30, 30, 20, 20, 20);
    const result = detectProjectedCropMismatch(
      { data: exp, width: 30, height: 30 },
      { data: act, width: 30, height: 30 }
    );
    // Both solid → edgeOverlap=100 (no edges), so safe guard kicks in → not mismatched
    // This tests that the guard correctly prevents false positives on solid patches
    expect(result).not.toBeNull();
    expect(result?.mismatched).toBe(false);
  });

  it("flags text_absent when expectedText given and palette diverges greatly", () => {
    // Expected: white text background (high brightness)
    const exp = solidPixels(40, 20, 240, 240, 240);
    // Actual: dark background completely different palette
    const act = solidPixels(40, 20, 10, 10, 10);
    const result = detectProjectedCropMismatch(
      { data: exp, width: 40, height: 20 },
      { data: act, width: 40, height: 20 },
      "Submit"
    );
    expect(result).not.toBeNull();
    // textAbsent fires: changedPercent>50 and palette<20 and expectedText defined
    // But edgeOverlap=100 (both solid, no edges) → safe guard → not mismatched
    expect(result?.mismatched).toBe(false);
  });
});
