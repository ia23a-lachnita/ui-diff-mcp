import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeCrop } from "../../src/images/artifacts.js";
import { loadNormalizedImage } from "../../src/images/normalize.js";
import { createImagePairTransform, projectExpectedBoxToActualSource, projectActualBoxToExpectedSource } from "../../src/images/coordinates.js";
import { assertSupportedImagePath } from "../../src/security/paths.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("assertSupportedImagePath", () => {
  it("allows .png", () => {
    expect(() => assertSupportedImagePath("image.png")).not.toThrow();
  });

  it("rejects .gif", () => {
    expect(() => assertSupportedImagePath("image.gif")).toThrow(/Unsupported image extension/);
  });

  it("rejects null byte", () => {
    expect(() => assertSupportedImagePath("image\0.png")).toThrow(/null byte/);
  });
});

describe("loadNormalizedImage", () => {
  it("normalizes a 100x100 PNG and returns correct dimensions", async () => {
    const srcPath = await writeSolidPng(tmpDir, "src.png", 100, 100, 128, 64, 32);
    const outPath = path.join(tmpDir, "out.png");
    const result = await loadNormalizedImage(srcPath, outPath);
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
    expect(result.channels).toBeGreaterThanOrEqual(3);
    expect(result.rgba.length).toBeGreaterThan(0);
  });

  it("resizes when targetSize is provided", async () => {
    const srcPath = await writeSolidPng(tmpDir, "src.png", 100, 100, 0, 0, 255);
    const outPath = path.join(tmpDir, "resized.png");
    const result = await loadNormalizedImage(srcPath, outPath, { width: 50, height: 50 });
    expect(result.width).toBe(50);
    expect(result.height).toBe(50);
  });
});

describe("loadNormalizedImage metadata", () => {
  it("records resizeMode=none when no targetSize given", async () => {
    const srcPath = await writeSolidPng(tmpDir, "src.png", 100, 100, 100, 100, 100);
    const outPath = path.join(tmpDir, "out.png");
    const result = await loadNormalizedImage(srcPath, outPath);
    expect(result.metadata.resizeMode).toBe("none");
    expect(result.metadata.scaleX).toBeCloseTo(1, 5);
    expect(result.metadata.scaleY).toBeCloseTo(1, 5);
    expect(result.metadata.anisotropicScaleDeltaPercent).toBeCloseTo(0, 5);
  });

  it("detects anisotropic scale when resizing 108x240 to 120x262", async () => {
    const srcPath = await writeSolidPng(tmpDir, "actual.png", 108, 240, 180, 180, 180);
    const outPath = path.join(tmpDir, "actual-norm.png");
    const result = await loadNormalizedImage(srcPath, outPath, { width: 120, height: 262 });
    expect(result.metadata.resizeMode).toBe("fill");
    expect(result.metadata.scaleX).toBeCloseTo(120 / 108, 3);
    expect(result.metadata.scaleY).toBeCloseTo(262 / 240, 3);
    expect(result.metadata.anisotropicScaleDeltaPercent).toBeGreaterThan(1.5);
  });
});

describe("writeCrop", () => {
  it("extracts a 40x40 region", async () => {
    const srcPath = await writeSolidPng(tmpDir, "src.png", 100, 100, 200, 100, 50);
    const outPath = path.join(tmpDir, "crop.png");
    const result = await writeCrop(srcPath, { x: 10, y: 10, width: 40, height: 40 }, outPath, 100, 100);
    expect(result.width).toBe(40);
    expect(result.height).toBe(40);
    const meta = await sharp(outPath).metadata();
    expect(meta.width).toBe(40);
    expect(meta.height).toBe(40);
  });

  it("throws when box exceeds image bounds", async () => {
    const srcPath = await writeSolidPng(tmpDir, "src.png", 100, 100, 0, 0, 0);
    const outPath = path.join(tmpDir, "bad-crop.png");
    await expect(
      writeCrop(srcPath, { x: 80, y: 80, width: 40, height: 40 }, outPath, 100, 100)
    ).rejects.toThrow(/exceeds image bounds/);
  });
});

describe("createImagePairTransform", () => {
  it("computes identity transform for equal-size images", () => {
    const t = createImagePairTransform({ width: 1200, height: 2400 }, { width: 1200, height: 2400 });
    expect(t.scaleExpectedToActualX).toBeCloseTo(1.0);
    expect(t.scaleExpectedToActualY).toBeCloseTo(1.0);
    expect(t.scaleActualToExpectedX).toBeCloseTo(1.0);
    expect(t.scaleActualToExpectedY).toBeCloseTo(1.0);
  });

  it("computes half-scale when actual is half the expected size", () => {
    const t = createImagePairTransform({ width: 1200, height: 2400 }, { width: 600, height: 1200 });
    expect(t.scaleExpectedToActualX).toBeCloseTo(0.5);
    expect(t.scaleExpectedToActualY).toBeCloseTo(0.5);
    expect(t.scaleActualToExpectedX).toBeCloseTo(2.0);
    expect(t.scaleActualToExpectedY).toBeCloseTo(2.0);
  });

  it("preserves size metadata", () => {
    const t = createImagePairTransform({ width: 300, height: 600 }, { width: 150, height: 300 });
    expect(t.expectedSize).toEqual({ width: 300, height: 600 });
    expect(t.actualSize).toEqual({ width: 150, height: 300 });
  });

  it("handles anisotropic scaling (different X and Y ratios)", () => {
    const t = createImagePairTransform({ width: 1000, height: 2000 }, { width: 500, height: 1500 });
    expect(t.scaleExpectedToActualX).toBeCloseTo(0.5);
    expect(t.scaleExpectedToActualY).toBeCloseTo(0.75);
  });
});

describe("projectExpectedBoxToActualSource", () => {
  it("doubles box dimensions when actual is twice expected", () => {
    const t = createImagePairTransform({ width: 600, height: 1200 }, { width: 1200, height: 2400 });
    const box = projectExpectedBoxToActualSource({ x: 100, y: 200, width: 50, height: 80 }, t);
    expect(box.x).toBeCloseTo(200);
    expect(box.y).toBeCloseTo(400);
    expect(box.width).toBeCloseTo(100);
    expect(box.height).toBeCloseTo(160);
  });

  it("halves box dimensions when actual is half expected", () => {
    const t = createImagePairTransform({ width: 1200, height: 2400 }, { width: 600, height: 1200 });
    const box = projectExpectedBoxToActualSource({ x: 100, y: 200, width: 80, height: 40 }, t);
    expect(box.x).toBeCloseTo(50);
    expect(box.y).toBeCloseTo(100);
    expect(box.width).toBeCloseTo(40);
    expect(box.height).toBeCloseTo(20);
  });

  it("actual source crop dimensions are not equal to expected source dimensions when sizes differ", () => {
    const t = createImagePairTransform({ width: 1200, height: 2400 }, { width: 600, height: 1200 });
    const expBox = { x: 0, y: 0, width: 200, height: 100 };
    const actBox = projectExpectedBoxToActualSource(expBox, t);
    // Actual crop is smaller (half the size), not stretched to expected dimensions
    expect(actBox.width).not.toBeCloseTo(expBox.width);
    expect(actBox.width).toBeCloseTo(100);
  });
});

describe("projectActualBoxToExpectedSource", () => {
  it("inverts projectExpectedBoxToActualSource for equal-size images", () => {
    const t = createImagePairTransform({ width: 800, height: 600 }, { width: 400, height: 300 });
    const original = { x: 40, y: 30, width: 80, height: 60 };
    const projected = projectExpectedBoxToActualSource(original, t);
    const backProjected = projectActualBoxToExpectedSource(projected, t);
    expect(backProjected.x).toBeCloseTo(original.x, 5);
    expect(backProjected.y).toBeCloseTo(original.y, 5);
    expect(backProjected.width).toBeCloseTo(original.width, 5);
    expect(backProjected.height).toBeCloseTo(original.height, 5);
  });
});
