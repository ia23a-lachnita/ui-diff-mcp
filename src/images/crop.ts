import sharp from "sharp";
import type { Box } from "../schemas/core.js";

export function extractImageCrop(
  imageData: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  box: Box
): Uint8Array {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(Math.round(box.width), imageWidth - x);
  const h = Math.min(Math.round(box.height), imageHeight - y);

  if (w <= 0 || h <= 0) {
    return new Uint8Array(4);
  }

  const croppedData = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const srcIdx = ((y + row) * imageWidth + (x + col)) * 4;
      const destIdx = (row * w + col) * 4;
      croppedData[destIdx] = imageData[srcIdx] ?? 0;
      croppedData[destIdx + 1] = imageData[srcIdx + 1] ?? 0;
      croppedData[destIdx + 2] = imageData[srcIdx + 2] ?? 0;
      croppedData[destIdx + 3] = imageData[srcIdx + 3] ?? 0;
    }
  }
  return croppedData;
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
