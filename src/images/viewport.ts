import type { ImageNormalizationMetadata, ViewportCompatibilityStatus } from "../schemas/core.js";

export type { ViewportCompatibilityStatus };

export function computeViewportCompatibility(
  _expected: ImageNormalizationMetadata,
  actual: ImageNormalizationMetadata
): { status: ViewportCompatibilityStatus; reasons: string[] } {
  const reasons: string[] = [];
  if (actual.resizeMode === "fill" && actual.anisotropicScaleDeltaPercent > 1.5) {
    reasons.push(`actual image was anisotropically scaled by ${actual.anisotropicScaleDeltaPercent.toFixed(2)}%`);
  }
  if (actual.aspectRatioDeltaPercent > 1.5) {
    reasons.push(`actual source aspect ratio differs from expected by ${actual.aspectRatioDeltaPercent.toFixed(2)}%`);
  }
  return { status: reasons.length > 0 ? "mismatch" : "compatible", reasons };
}
