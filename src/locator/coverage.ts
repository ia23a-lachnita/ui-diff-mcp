import type { LocatorCoverageStatus, UiElement } from "../schemas/core.js";

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageLocatorCoverageInput {
  elements: UiElement[];
  promptCount: number;
  imageSize: ImageSize;
  minQueryCoverageRatio?: number;
  minElementCount?: number;
}

export interface ImageLocatorCoverage {
  status: LocatorCoverageStatus;
  promptCount: number;
  usefulElementCount: number;
  queryCounts: Record<string, number>;
  queryCoverageRatio: number;
  rejectedElementCount: number;
  reasons: string[];
}

export function isUsefulLocatorBox(element: UiElement, imageSize: ImageSize): boolean {
  const imageArea = imageSize.width * imageSize.height;
  const boxArea = element.box.width * element.box.height;
  if (boxArea <= 0) return false;
  if (boxArea / imageArea > 0.8) return false;
  if (element.box.width < 3 || element.box.height < 3) return false;
  return true;
}

export function computeImageLocatorCoverage(input: ImageLocatorCoverageInput): ImageLocatorCoverage {
  const minQueryCoverageRatio = input.minQueryCoverageRatio ?? 0.75;
  const minElementCount = input.minElementCount ?? 12;
  const useful = input.elements.filter(e => isUsefulLocatorBox(e, input.imageSize));
  const queryCounts: Record<string, number> = {};

  for (const element of useful) {
    if (element.queryId) {
      queryCounts[element.queryId] = (queryCounts[element.queryId] ?? 0) + 1;
    }
  }

  const queryCoverageRatio = input.promptCount === 0
    ? 0
    : Math.min(1, Object.keys(queryCounts).length / input.promptCount);

  // cv_components is a whole-image deterministic lane — if it provides enough elements it
  // substitutes for the standard query-category coverage requirement, since it detects all
  // visible UI regions without being constrained to the 8 category prompts.
  const cvElementCount = queryCounts["cv_components"] ?? 0;
  const cvSubstitutesQueryCoverage = cvElementCount >= Math.ceil(minElementCount / 2);

  const reasons: string[] = [];

  if (input.promptCount === 0) reasons.push("no_locator_prompts");
  if (!cvSubstitutesQueryCoverage && queryCoverageRatio < minQueryCoverageRatio) reasons.push("query_coverage_below_threshold");
  if (useful.length < minElementCount) reasons.push("element_count_below_minimum");
  if (useful.length === 0 && input.elements.length > 0) reasons.push("all_elements_rejected_as_low_quality");

  let status: LocatorCoverageStatus = "complete";
  if (input.promptCount === 0) status = "not_run";
  else if (useful.length === 0) status = "failed";
  else if (reasons.length > 0) status = "weak";

  return {
    status,
    promptCount: input.promptCount,
    usefulElementCount: useful.length,
    queryCounts,
    queryCoverageRatio,
    rejectedElementCount: input.elements.length - useful.length,
    reasons
  };
}
