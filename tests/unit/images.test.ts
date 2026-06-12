import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeCrop } from "../../src/images/artifacts.js";
import { loadNormalizedImage } from "../../src/images/normalize.js";
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
