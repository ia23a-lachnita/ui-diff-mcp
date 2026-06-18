import type { ImageNormalizationMetadata, ViewportCompatibilityStatus } from "../schemas/core.js";

export type { ViewportCompatibilityStatus };

export function computeViewportCompatibility(
  expected: ImageNormalizationMetadata,
  actual: ImageNormalizationMetadata
): { status: ViewportCompatibilityStatus; reasons: string[] } {
  const reasons: string[] = [];
  if (actual.resizeMode === "fill" && actual.anisotropicScaleDeltaPercent > 1.5) {
    reasons.push(`actual image was anisotropically scaled by ${actual.anisotropicScaleDeltaPercent.toFixed(2)}%`);
  }
  if (actual.aspectRatioDeltaPercent > 1.5) {
    reasons.push(`actual source aspect ratio differs from expected by ${actual.aspectRatioDeltaPercent.toFixed(2)}%`);
  }
  const expAr = expected.source.aspectRatio;
  const actAr = actual.source.aspectRatio;
  if (expAr > 0 && actAr > 0) {
    const arDeltaPercent = Math.abs(actAr - expAr) / expAr * 100;
    if (arDeltaPercent > 1.5) {
      reasons.push(`actual source aspect ratio (${actAr.toFixed(3)}) differs from expected source aspect ratio (${expAr.toFixed(3)}) by ${arDeltaPercent.toFixed(2)}%`);
    }
  }
  return { status: reasons.length > 0 ? "mismatch" : "compatible", reasons };
}
