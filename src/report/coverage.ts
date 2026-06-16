import crypto from "node:crypto";
import type { DiffRecord, UiArtifact, CoverageDecisionTrace } from "../schemas/core.js";
import type { PixelComponent } from "../signals/pixel-diff.js";
import { intersect } from "../signals/geometry.js";

function componentOverlapsDiff(component: PixelComponent, diff: DiffRecord): boolean {
  const overlap = intersect(component.box, diff.location);
  if (!overlap) return false;
  const overlapArea = overlap.width * overlap.height;
  const componentArea = component.box.width * component.box.height;
  return overlapArea / componentArea >= 0.1;
}

export function traceCoverageDecisions(
  components: PixelComponent[],
  diffs: DiffRecord[],
  minArea: number
): CoverageDecisionTrace[] {
  return components.map((component, index) => {
    const componentId = `component-${String(index + 1).padStart(4, "0")}`;
    if (component.pixelCount < minArea) {
      return { componentId, componentBox: component.box, pixelCount: component.pixelCount, status: "below_threshold" as const };
    }
    let best: { diff: DiffRecord; ratio: number } | undefined;
    for (const diff of diffs) {
      const overlap = intersect(component.box, diff.location);
      if (!overlap) continue;
      const ratio = (overlap.width * overlap.height) / (component.box.width * component.box.height);
      if (!best || ratio > best.ratio) best = { diff, ratio };
    }
    if (best && best.ratio >= 0.1) {
      return {
        componentId,
        componentBox: component.box,
        pixelCount: component.pixelCount,
        status: "covered_by_diff" as const,
        coveringDiffId: best.diff.id,
        coveringCriterion: best.diff.criterion,
        overlapRatio: Number(best.ratio.toFixed(4))
      };
    }
    return { componentId, componentBox: component.box, pixelCount: component.pixelCount, status: "uncovered" as const };
  });
}

export function findUncoveredComponents(
  components: PixelComponent[],
  diffs: DiffRecord[],
  minArea: number
): PixelComponent[] {
  return traceCoverageDecisions(components, diffs, minArea)
    .map((decision, index) => ({ decision, component: components[index]! }))
    .filter(({ decision }) => decision.status === "uncovered")
    .map(({ component }) => component);
}

export function assignDiffComponentsToRecords(
  components: PixelComponent[],
  diffs: DiffRecord[],
  minArea: number,
  pixelDiffArtifactPath?: string
): DiffRecord[] {
  const result = [...diffs];

  for (const component of components) {
    if (component.pixelCount < minArea) continue;

    const covered = diffs.some(d => componentOverlapsDiff(component, d));
    if (covered) continue;

    const id = crypto.randomBytes(6).toString("hex");
    const unclassified: DiffRecord = {
      id,
      criterion: "unclassified_visual_change",
      severity: "low",
      title: `Unclassified visual change at (${component.box.x}, ${component.box.y})`,
      location: component.box,
      evidence: [
        `Changed pixel component: ${component.pixelCount} pixels at box ` +
        `{x:${component.box.x}, y:${component.box.y}, w:${component.box.width}, h:${component.box.height}}`
      ],
      measurements: [
        { name: "pixelCount", value: component.pixelCount },
        { name: "componentArea", value: component.box.width * component.box.height, unit: "px²" }
      ],
      artifactPaths: pixelDiffArtifactPath ? [{ role: "pixel_diff" as UiArtifact["role"], path: pixelDiffArtifactPath }] : [],
      reviewerStatus: "not_reviewed"
    };

    result.push(unclassified);
  }

  return result;
}
