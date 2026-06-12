import path from "node:path";
import fs from "node:fs/promises";
import sharp from "sharp";
import type { Box } from "../schemas/core.js";

export interface CropResult {
  path: string;
  width: number;
  height: number;
}

function clampBox(box: Box, imageWidth: number, imageHeight: number): Box {
  const x = Math.max(0, Math.min(Math.round(box.x), imageWidth - 1));
  const y = Math.max(0, Math.min(Math.round(box.y), imageHeight - 1));
  const width = Math.max(1, Math.min(Math.round(box.width), imageWidth - x));
  const height = Math.max(1, Math.min(Math.round(box.height), imageHeight - y));
  return { x, y, width, height };
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
    throw new Error(
      `Box {x:${box.x},y:${box.y},w:${box.width},h:${box.height}} exceeds image bounds ${imageWidth}x${imageHeight}`
    );
  }

  const clamped = clampBox(box, imageWidth, imageHeight);
  await sharp(imagePath)
    .extract({ left: clamped.x, top: clamped.y, width: clamped.width, height: clamped.height })
    .png()
    .toFile(outPath);

  return { path: outPath, width: clamped.width, height: clamped.height };
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
