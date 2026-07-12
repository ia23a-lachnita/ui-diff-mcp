import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeComparisonCrop } from "../../src/images/artifacts.js";
import { resolveComparisonExtraction } from "../../src/images/comparison-geometry.js";
import { createImagePairTransform } from "../../src/images/coordinates.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "crop-validation-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("comparison crop validation", () => {
  it("projects actual-source boxes before deriving fractional floor/ceil extraction bounds", () => {
    const transform = createImagePairTransform({ width: 200, height: 200 }, { width: 100, height: 100 });

    expect(resolveComparisonExtraction({
      box: { x: 49.2, y: 20.3, width: 1.1, height: 1.1 },
      sourceSpace: "actual_normalized",
      canvas: { width: 200, height: 200 },
      transform
    })).toMatchObject({
      status: "valid",
      bounds: { left: 98, top: 40, width: 3, height: 3 }
    });
  });

  it("uses floor left/top and ceil right/bottom for fractional canonical boxes", () => {
    expect(resolveComparisonExtraction({
      box: { x: 1.2, y: 2.7, width: 2.1, height: 2.1 },
      sourceSpace: "comparison_expected_normalized",
      canvas: { width: 100, height: 100 }
    })).toMatchObject({ status: "valid", bounds: { left: 1, top: 2, width: 3, height: 3 } });
  });

  it("clips a valid edge crop and writes exactly its clipped integer dimensions", async () => {
    const srcPath = await writeSolidPng(tmpDir, "source.png", 100, 100, 20, 30, 40);
    const outPath = path.join(tmpDir, "edge.png");

    const result = await writeComparisonCrop({
      imagePath: srcPath,
      comparisonBox: { x: 96.2, y: 96.2, width: 10, height: 10 },
      outPath,
      canvas: { width: 100, height: 100 }
    });

    expect(result).toMatchObject({ status: "valid", width: 4, height: 4 });
    await expect(sharp(outPath).metadata()).resolves.toMatchObject({ width: 4, height: 4 });
  });

  it.each([
    ["disjoint", { x: 101, y: 1, width: 5, height: 5 }, "disjoint"],
    ["nonfinite", { x: Number.NaN, y: 1, width: 5, height: 5 }, "non_finite"],
    ["sub-2x2", { x: 99, y: 99, width: 1, height: 1 }, "below_minimum_artifact_size"]
  ] as const)("rejects %s crops without writing a file", async (_name, comparisonBox, reason) => {
    const srcPath = await writeSolidPng(tmpDir, "source.png", 100, 100, 20, 30, 40);
    const outPath = path.join(tmpDir, `${_name}.png`);

    await expect(writeComparisonCrop({
      imagePath: srcPath,
      comparisonBox,
      outPath,
      canvas: { width: 100, height: 100 }
    })).resolves.toEqual({ status: "rejected", reason });
    await expect(fs.access(outPath)).rejects.toThrow();
  });
});
