import sharp from "sharp";

export interface Rgba {
  data: Uint8Array;
  width: number;
  height: number;
}

export async function createDirectionalDiffOverlay(
  expectedRgba: Rgba,
  actualRgba: Rgba,
  pixelDiffMask: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  outPath: string
): Promise<string> {
  const outputBuffer = Buffer.alloc(imageWidth * imageHeight * 4);

  const expectedData = expectedRgba.data;
  const actualData = actualRgba.data;

  const CYAN: readonly [number, number, number, number] = [0, 255, 255, 255];
  const MAGENTA: readonly [number, number, number, number] = [255, 0, 255, 255];
  const NEUTRAL_GRAY: readonly [number, number, number, number] = [128, 128, 128, 255];
  const YELLOW: readonly [number, number, number, number] = [255, 255, 0, 255];

  for (let y = 0; y < imageHeight; y++) {
    for (let x = 0; x < imageWidth; x++) {
      const i = y * imageWidth + x;
      const offset = i * 4;
      const diffMaskValue = pixelDiffMask[i] ?? 0;

      const er = expectedData[offset] ?? 0;
      const eg = expectedData[offset + 1] ?? 0;
      const eb = expectedData[offset + 2] ?? 0;
      const ar = actualData[offset] ?? 0;
      const ag = actualData[offset + 1] ?? 0;
      const ab = actualData[offset + 2] ?? 0;

      const isDiff = diffMaskValue > 0;
      const colorDiff = Math.abs(er - ar) > 10 || Math.abs(eg - ag) > 10 || Math.abs(eb - ab) > 10;

      let color: readonly [number, number, number, number] = NEUTRAL_GRAY;

      // Check for outline
      let isOutline = false;
      if (isDiff) {
        // Check neighbors (up, down, left, right)
        const neighbors = [
          (y > 0) ? pixelDiffMask[(y - 1) * imageWidth + x] : 0, // Up
          (y < imageHeight - 1) ? pixelDiffMask[(y + 1) * imageWidth + x] : 0, // Down
          (x > 0) ? pixelDiffMask[y * imageWidth + (x - 1)] : 0, // Left
          (x < imageWidth - 1) ? pixelDiffMask[y * imageWidth + (x + 1)] : 0 // Right
        ];
        if (neighbors.some(n => n === 0)) {
          isOutline = true;
        }
      }

      if (isOutline) {
        color = YELLOW;
      } else if (isDiff && colorDiff) {
        const expLuminance = 0.299 * er + 0.587 * eg + 0.114 * eb;
        const actLuminance = 0.299 * ar + 0.587 * ag + 0.114 * ab;
        color = expLuminance > actLuminance ? CYAN : MAGENTA;
      }

      outputBuffer[offset] = color[0];
      outputBuffer[offset + 1] = color[1];
      outputBuffer[offset + 2] = color[2];
      outputBuffer[offset + 3] = color[3];
    }
  }

  await sharp(outputBuffer, { raw: { width: imageWidth, height: imageHeight, channels: 4 } })
    .png()
    .toFile(outPath);

  return outPath;
}
