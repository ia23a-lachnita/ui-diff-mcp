import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeRegionContextOverlays } from "../../src/report/context-overlays.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";
import type { DiffRecord, UiElement, UnresolvedRegion } from "../../src/schemas/core.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "region-context-overlay-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function diff(id: string): DiffRecord {
  return {
    id,
    criterion: "geometry",
    severity: "medium",
    title: "Card shifted",
    location: { x: 20, y: 40, width: 80, height: 50 },
    evidence: ["card is shifted"],
    measurements: [],
    artifactPaths: [],
    reviewerStatus: "accepted",
    classificationSource: "vlm_reviewed"
  };
}

function region(id: string): UnresolvedRegion {
  return {
    id,
    location: { x: 120, y: 160, width: 3, height: 28 },
    pixelCount: 80,
    sourceComponentIds: ["component-1"],
    relatedFindingIds: [],
    relation: "none",
    reason: "not_classified",
    artifactPaths: []
  };
}

function card(): UiElement {
  return {
    id: "card-1",
    label: "Summary card",
    type: "card",
    box: { x: 10, y: 30, width: 120, height: 80 },
    normalizedBox: { x: 0.05, y: 0.075, width: 0.6, height: 0.2 },
    confidence: 0.9,
    source: "locator",
    childIds: []
  };
}

describe("writeRegionContextOverlays", () => {
  it("writes final, unresolved, and combined full-screen context overlays", async () => {
    const actualComparisonPath = await writeSolidPng(tmpDir, "actual-comparison.png", 200, 400, 30, 30, 30);
    const directionalOverlayPath = await writeSolidPng(tmpDir, "directional-overlay.png", 200, 400, 10, 10, 10);
    const artifacts = await writeRegionContextOverlays({
      actualComparisonPath,
      directionalOverlayPath,
      artifactDir: tmpDir,
      diffs: [diff("diff-1")],
      unresolvedRegions: [region("region-1")],
      elements: [card()]
    });

    expect(artifacts.map(artifact => artifact.role).sort()).toEqual([
      "final_diff_regions_overlay",
      "region_context_overlay",
      "unresolved_regions_overlay"
    ]);
    for (const artifact of artifacts) {
      await expect(fs.access(artifact.path)).resolves.toBeUndefined();
      const metadata = await sharp(artifact.path).metadata();
      expect(metadata.width).toBe(200);
      expect(metadata.height).toBe(400);
    }
  });
});
