import sharp from "sharp";
import type { Box } from "../schemas/core.js";
import { resolveComparisonExtraction, type ComparisonExtractionBounds } from "./comparison-geometry.js";

export function extractImageCropFromBounds(
  imageData: Uint8Array,
  imageWidth: number,
  bounds: ComparisonExtractionBounds
): Uint8Array {
  const croppedData = new Uint8Array(bounds.width * bounds.height * 4);
  for (let row = 0; row < bounds.height; row++) {
    for (let col = 0; col < bounds.width; col++) {
      const srcIdx = ((bounds.top + row) * imageWidth + (bounds.left + col)) * 4;
      const destIdx = (row * bounds.width + col) * 4;
      croppedData[destIdx] = imageData[srcIdx] ?? 0;
      croppedData[destIdx + 1] = imageData[srcIdx + 1] ?? 0;
      croppedData[destIdx + 2] = imageData[srcIdx + 2] ?? 0;
      croppedData[destIdx + 3] = imageData[srcIdx + 3] ?? 0;
    }
  }
  return croppedData;
}

export function extractImageCrop(
  imageData: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  box: Box
): Uint8Array {
  const resolution = resolveComparisonExtraction({
    box,
    sourceSpace: "comparison_expected_normalized",
    canvas: { width: imageWidth, height: imageHeight }
  });
  if (resolution.status === "rejected") throw new Error(resolution.reason);
  return extractImageCropFromBounds(imageData, imageWidth, resolution.bounds);
}

export async function resizeRgbaForComparison(
  input: { data: Uint8Array; width: number; height: number },
  width: number,
  height: number
): Promise<Uint8Array> {
  const resized = await sharp(Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength), {
    raw: { width: input.width, height: input.height, channels: 4 }
  })
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer();
  return new Uint8Array(resized);
}
