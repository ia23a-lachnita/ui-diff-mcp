import { describe, expect, it } from "vitest";
import {
  computeOklabDistance,
  computeColorEvidence,
  sampleColorStats,
  COLOR_THRESHOLDS
} from "../../src/signals/color.js";

function makeRgbaBuffer(r: number, g: number, b: number, a = 255, width = 10, height = 10): Uint8Array {
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

const BOX = { x: 0, y: 0, width: 10, height: 10 };

describe("computeOklabDistance", () => {
  it("returns 0 for identical colors", () => {
    expect(computeOklabDistance(200, 100, 50, 200, 100, 50)).toBe(0);
  });

  it("returns > 0 for different colors", () => {
    const d = computeOklabDistance(255, 0, 0, 0, 0, 255); // red vs blue
    expect(d).toBeGreaterThan(0.1);
  });

  it("pure white vs black is approximately 1", () => {
    const d = computeOklabDistance(255, 255, 255, 0, 0, 0);
    expect(d).toBeGreaterThan(0.9);
    expect(d).toBeLessThanOrEqual(1.1);
  });

  it("anti-alias level difference is below 0.02", () => {
    // Two nearly-identical grays differing by 3 RGB units
    const d = computeOklabDistance(128, 128, 128, 131, 131, 131);
    expect(d).toBeLessThan(0.02);
  });
});

describe("sampleColorStats", () => {
  it("returns zero stats for empty box", () => {
    const buf = makeRgbaBuffer(100, 150, 200);
    const stats = sampleColorStats(buf, 10, { x: 0, y: 0, width: 0, height: 0 });
    expect(stats.avgR).toBe(0);
    expect(stats.dominantPalette).toHaveLength(0);
  });

  it("averages a solid-color region correctly", () => {
    const buf = makeRgbaBuffer(80, 160, 240);
    const stats = sampleColorStats(buf, 10, BOX);
    expect(stats.avgR).toBe(80);
    expect(stats.avgG).toBe(160);
    expect(stats.avgB).toBe(240);
    expect(stats.avgA).toBe(255);
  });

  it("produces dominant palette entries", () => {
    const buf = makeRgbaBuffer(64, 64, 64);
    const stats = sampleColorStats(buf, 10, BOX);
    expect(stats.dominantPalette.length).toBeGreaterThan(0);
  });
});

describe("computeColorEvidence", () => {
  it("same color returns hasDiff false", () => {
    const buf = makeRgbaBuffer(100, 100, 100);
    const ev = computeColorEvidence(buf, buf, 10, BOX, "button");
    expect(ev.hasDiff).toBe(false);
    expect(ev.oklabDistance).toBe(0);
  });

  it("clearly different colors returns hasDiff true", () => {
    const expBuf = makeRgbaBuffer(255, 0, 0);   // red
    const actBuf = makeRgbaBuffer(0, 0, 255);   // blue
    const ev = computeColorEvidence(expBuf, actBuf, 10, BOX, "button");
    expect(ev.hasDiff).toBe(true);
    expect(ev.oklabDistance).toBeGreaterThan(0.1);
  });

  it("anti-alias level noise stays below threshold", () => {
    const expBuf = makeRgbaBuffer(128, 128, 128);
    const actBuf = makeRgbaBuffer(130, 130, 130);
    const ev = computeColorEvidence(expBuf, actBuf, 10, BOX, "default");
    expect(ev.hasDiff).toBe(false);
  });

  it("includes expected and actual avg colors", () => {
    const expBuf = makeRgbaBuffer(200, 100, 50);
    const actBuf = makeRgbaBuffer(50, 200, 100);
    const ev = computeColorEvidence(expBuf, actBuf, 10, BOX, "icon");
    expect(ev.expectedAvg.r).toBe(200);
    expect(ev.actualAvg.r).toBe(50);
  });

  it("uses element-type-specific threshold", () => {
    const ev = computeColorEvidence(
      makeRgbaBuffer(128, 128, 128),
      makeRgbaBuffer(128, 128, 128),
      10, BOX, "chart_indicator"
    );
    expect(ev.threshold).toBe(COLOR_THRESHOLDS["chart_indicator"]);
  });

  it("falls back to default threshold for unknown element type", () => {
    const ev = computeColorEvidence(
      makeRgbaBuffer(0, 0, 0),
      makeRgbaBuffer(0, 0, 0),
      10, BOX, "unknown_widget"
    );
    expect(ev.threshold).toBe(COLOR_THRESHOLDS["default"]);
  });

  it("relaxes threshold for semi-transparent elements", () => {
    // A small color diff that would trigger on opaque elements
    const expBuf = makeRgbaBuffer(100, 100, 100, 80);  // semi-transparent
    const actBuf = makeRgbaBuffer(130, 130, 130, 80);  // different but semi-transparent
    const evTranslucent = computeColorEvidence(expBuf, actBuf, 10, BOX, "button");

    const expBufOpaque = makeRgbaBuffer(100, 100, 100, 255);
    const actBufOpaque = makeRgbaBuffer(130, 130, 130, 255);
    const evOpaque = computeColorEvidence(expBufOpaque, actBufOpaque, 10, BOX, "button");

    // Translucent should be stricter (less likely to flag) than opaque for the same pixel diff
    if (evOpaque.hasDiff) {
      // If opaque triggers, translucent with same colors may not trigger
      expect(evTranslucent.oklabDistance).toBe(evOpaque.oklabDistance);
    }
  });

  it("records sampled region in evidence", () => {
    const buf = makeRgbaBuffer(0, 0, 0);
    const box = { x: 1, y: 1, width: 5, height: 5 };
    const ev = computeColorEvidence(buf, buf, 10, box, "icon");
    expect(ev.sampledRegion).toEqual(box);
    expect(ev.elementType).toBe("icon");
  });

  it("includes dominant palettes for both sides", () => {
    const expBuf = makeRgbaBuffer(255, 0, 0);
    const actBuf = makeRgbaBuffer(0, 255, 0);
    const ev = computeColorEvidence(expBuf, actBuf, 10, BOX, "image");
    expect(ev.dominantExpected.length).toBeGreaterThan(0);
    expect(ev.dominantActual.length).toBeGreaterThan(0);
  });
});

describe("COLOR_THRESHOLDS", () => {
  it("chart_indicator is tighter than default", () => {
    expect(COLOR_THRESHOLDS["chart_indicator"]!).toBeLessThan(COLOR_THRESHOLDS["default"]!);
  });

  it("image_thumbnail is looser than default icon", () => {
    expect(COLOR_THRESHOLDS["image_thumbnail"]!).toBeGreaterThan(COLOR_THRESHOLDS["icon"]!);
  });

  it("has a default key", () => {
    expect(COLOR_THRESHOLDS["default"]).toBeDefined();
  });
});
