import sharp from "sharp";
import { assertSupportedImagePath } from "../security/paths.js";
import type { ImageNormalizationMetadata } from "../schemas/core.js";

export type { ImageNormalizationMetadata };

export interface NormalizedImage {
  path: string;
  width: number;
  height: number;
  channels: number;
  rgba: Buffer;
  metadata: ImageNormalizationMetadata;
}

export async function loadNormalizedImage(
  inputPath: string,
  outputPath: string,
  targetSize?: { width: number; height: number }
): Promise<NormalizedImage> {
  assertSupportedImagePath(inputPath);

  const sourceMeta = await sharp(inputPath).metadata();
  const sourceWidth = sourceMeta.width ?? 0;
  const sourceHeight = sourceMeta.height ?? 0;
  const sourceAspectRatio = sourceHeight > 0 ? sourceWidth / sourceHeight : 1;

  let pipeline = sharp(inputPath)
    .rotate()
    .toColorspace("srgb");

  const resizeMode: "none" | "fill" = targetSize ? "fill" : "none";
  if (targetSize) {
    pipeline = pipeline.resize(targetSize.width, targetSize.height, { fit: "fill" });
  }

  await pipeline.png().toFile(outputPath);

  const meta = await sharp(outputPath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const channels = meta.channels ?? 4;
  const normalizedAspectRatio = height > 0 ? width / height : 1;

  const scaleX = sourceWidth > 0 ? width / sourceWidth : 1;
  const scaleY = sourceHeight > 0 ? height / sourceHeight : 1;
  const aspectRatioDeltaPercent = sourceAspectRatio > 0
    ? Math.abs(normalizedAspectRatio - sourceAspectRatio) / sourceAspectRatio * 100
    : 0;
  const maxScale = Math.max(scaleX, scaleY);
  const anisotropicScaleDeltaPercent = maxScale > 0
    ? Math.abs(scaleX - scaleY) / maxScale * 100
    : 0;

  const { data } = await sharp(outputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const imageMetadata: ImageNormalizationMetadata = {
    source: { width: sourceWidth, height: sourceHeight, aspectRatio: sourceAspectRatio },
    normalized: { width, height, aspectRatio: normalizedAspectRatio },
    resizeMode,
    scaleX,
    scaleY,
    aspectRatioDeltaPercent,
    anisotropicScaleDeltaPercent
  };

  return { path: outputPath, width, height, channels, rgba: data, metadata: imageMetadata };
}
