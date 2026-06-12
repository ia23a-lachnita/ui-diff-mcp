import path from "node:path";
import sharp from "sharp";
import { assertSupportedImagePath } from "../security/paths.js";

export interface NormalizedImage {
  path: string;
  width: number;
  height: number;
  channels: number;
  rgba: Buffer;
}

export async function loadNormalizedImage(
  inputPath: string,
  outputPath: string,
  targetSize?: { width: number; height: number }
): Promise<NormalizedImage> {
  assertSupportedImagePath(inputPath);

  let pipeline = sharp(inputPath)
    .rotate()
    .toColorspace("srgb");

  if (targetSize) {
    pipeline = pipeline.resize(targetSize.width, targetSize.height, { fit: "fill" });
  }

  await pipeline.png().toFile(outputPath);

  const meta = await sharp(outputPath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const channels = meta.channels ?? 4;

  const { data } = await sharp(outputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { path: outputPath, width, height, channels, rgba: data };
}
