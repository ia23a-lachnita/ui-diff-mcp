import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import type { Box, ComparisonBoxRejectionReason } from "../schemas/core.js";
import { resolveComparisonExtraction } from "./comparison-geometry.js";

export interface CropResult {
  path: string;
  width: number;
  height: number;
}

export type ComparisonCropResult =
  | ({ status: "valid" } & CropResult)
  | { status: "rejected"; reason: ComparisonBoxRejectionReason };

export async function writeComparisonCrop(input: {
  imagePath: string;
  comparisonBox: Box;
  outPath: string;
  canvas: { width: number; height: number };
}): Promise<ComparisonCropResult> {
  const resolution = resolveComparisonExtraction({
    box: input.comparisonBox,
    sourceSpace: "comparison_expected_normalized",
    canvas: input.canvas
  });
  if (resolution.status === "rejected") return { status: "rejected", reason: resolution.reason };

  await fs.mkdir(path.dirname(input.outPath), { recursive: true });
  await sharp(input.imagePath)
    .extract(resolution.bounds)
    .png()
    .toFile(input.outPath);

  return { status: "valid", path: input.outPath, width: resolution.bounds.width, height: resolution.bounds.height };
}

export async function writeCrop(
  imagePath: string,
  box: Box,
  outPath: string,
  imageWidth: number,
  imageHeight: number
): Promise<CropResult> {
  if (
    box.x < 0 || box.y < 0 ||
    box.width <= 0 || box.height <= 0 ||
    box.x + box.width > imageWidth ||
    box.y + box.height > imageHeight
  ) {
    throw new Error(`Box {x:${box.x},y:${box.y},w:${box.width},h:${box.height}} exceeds image bounds ${imageWidth}x${imageHeight}`);
  }
  const result = await writeComparisonCrop({ imagePath, comparisonBox: box, outPath, canvas: { width: imageWidth, height: imageHeight } });
  if (result.status === "rejected") {
    throw new Error(`Box {x:${box.x},y:${box.y},w:${box.width},h:${box.height}} exceeds image bounds ${imageWidth}x${imageHeight}: ${result.reason}`);
  }
  return result;
}

export async function writeOverlay(
  baseImagePath: string,
  overlayImagePath: string,
  outPath: string
): Promise<string> {
  const overlayBuf = await sharp(overlayImagePath).png().toBuffer();
  await sharp(baseImagePath)
    .composite([{ input: overlayBuf, blend: "over" }])
    .png()
    .toFile(outPath);
  return outPath;
}

export async function writeJsonArtifact(
  outPath: string,
  data: unknown
): Promise<string> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(data, null, 2), "utf8");
  return outPath;
}
