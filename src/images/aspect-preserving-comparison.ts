import sharp from "sharp";
import {
  createUniformContainImagePairTransform,
  type ImagePairTransform
} from "./coordinates.js";

export interface PrepareAspectPreservingComparisonInput {
  sourcePath: string;
  outputPath: string;
  targetSize: { width: number; height: number };
}

export interface AspectPreservingComparisonResult {
  transform: ImagePairTransform;
}

export async function prepareAspectPreservingComparison(
  input: PrepareAspectPreservingComparisonInput
): Promise<AspectPreservingComparisonResult> {
  const metadata = await sharp(input.sourcePath).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    throw new Error(`Comparison source has invalid dimensions: ${width}x${height}.`);
  }

  const transform = createUniformContainImagePairTransform(
    input.targetSize,
    { width, height }
  );
  await sharp(input.sourcePath)
    .resize(input.targetSize.width, input.targetSize.height, {
      fit: "contain",
      position: "centre",
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toFile(input.outputPath);

  return { transform };
}
