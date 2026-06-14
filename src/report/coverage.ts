import crypto from "node:crypto";
import type { DiffRecord, UiArtifact } from "../schemas/core.js";
import type { PixelComponent } from "../signals/pixel-diff.js";
import { intersect } from "../signals/geometry.js";

function componentOverlapsDiff(component: PixelComponent, diff: DiffRecord): boolean {
  const overlap = intersect(component.box, diff.location);
  if (!overlap) return false;
  const overlapArea = overlap.width * overlap.height;
  const componentArea = component.box.width * component.box.height;
  return overlapArea / componentArea >= 0.1;
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
