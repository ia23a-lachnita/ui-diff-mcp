import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAspectPreservingComparison } from "../../src/images/aspect-preserving-comparison.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("prepareAspectPreservingComparison", () => {
  it("keeps a circular source feature circular inside a square canvas", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-contain-"));
    tempDirs.push(dir);
    const sourcePath = path.join(dir, "source.png");
    const outputPath = path.join(dir, "contained.png");

    const circle = Buffer.alloc(100 * 200 * 4);
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 100; x++) {
        const index = (y * 100 + x) * 4;
        const inside = (x - 50) ** 2 + (y - 100) ** 2 <= 30 ** 2;
        circle[index] = inside ? 255 : 0;
        circle[index + 1] = 0;
        circle[index + 2] = 0;
        circle[index + 3] = 255;
      }
    }
    await sharp(circle, { raw: { width: 100, height: 200, channels: 4 } }).png().toFile(sourcePath);

    const result = await prepareAspectPreservingComparison({
      sourcePath,
      outputPath,
      targetSize: { width: 200, height: 200 }
    });
    const { data, info } = await sharp(outputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const redPixels: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const index = (y * info.width + x) * 4;
        if ((data[index] ?? 0) > 200 && (data[index + 3] ?? 0) > 200) redPixels.push({ x, y });
      }
    }
    const minX = Math.min(...redPixels.map(pixel => pixel.x));
    const maxX = Math.max(...redPixels.map(pixel => pixel.x));
    const minY = Math.min(...redPixels.map(pixel => pixel.y));
    const maxY = Math.max(...redPixels.map(pixel => pixel.y));

    expect(result.transform.mappingMode).toBe("uniform_contain");
    expect(result.transform.validRect).toEqual({ x: 50, y: 0, width: 100, height: 200 });
    expect(maxX - minX).toBeCloseTo(maxY - minY, 0);
  });
});
