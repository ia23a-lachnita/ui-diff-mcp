import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFindingGroups, overlayStyleForImage, writeRegionContextOverlays } from "../../src/report/context-overlays.js";
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

function overlappingDiff(id: string): DiffRecord {
  return {
    ...diff(id),
    location: { x: 30, y: 45, width: 70, height: 45 },
    criterion: "color_appearance"
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
  it("groups overlapping final diffs and scales labels for tall screenshots", () => {
    const groups = buildFindingGroups([diff("diff-1"), overlappingDiff("diff-2")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.diffIds.sort()).toEqual(["diff-1", "diff-2"]);

    const style = overlayStyleForImage(1206, 2622);
    expect(style.fontSize).toBeGreaterThanOrEqual(18);
    expect(style.strokeWidth).toBeGreaterThanOrEqual(3);
    expect(style.diffFillOpacity).toBeLessThanOrEqual(0.06);
  });

  it("does not let screen-wide findings swallow localized finding groups", () => {
    const screen = {
      ...diff("screen"),
      location: { x: 0, y: 0, width: 1206, height: 2622 },
      criterion: "color_appearance" as const
    };
    const local = {
      ...diff("local"),
      location: { x: 75, y: 1808, width: 165, height: 168 },
      criterion: "geometry" as const
    };

    const groups = buildFindingGroups([screen, local]);

    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.diffIds)).toEqual(expect.arrayContaining([["screen"], ["local"]]));
  });

  it("writes final, unresolved, and combined full-screen context overlays", async () => {
    const actualComparisonPath = await writeSolidPng(tmpDir, "actual-comparison.png", 200, 400, 30, 30, 30);
    const directionalOverlayPath = await writeSolidPng(tmpDir, "directional-overlay.png", 200, 400, 10, 10, 10);
    const artifacts = await writeRegionContextOverlays({
      actualComparisonPath,
      directionalOverlayPath,
      artifactDir: tmpDir,
      diffs: [diff("diff-1"), overlappingDiff("diff-2")],
      unresolvedRegions: [region("region-1")],
      elements: [card()]
    });

    expect(artifacts.map(artifact => artifact.role).sort()).toEqual([
      "final_diff_groups_legend",
      "final_diff_groups_overlay",
      "final_diff_regions_overlay",
      "final_diff_zoom",
      "region_context_overlay",
      "unresolved_regions_overlay"
    ]);
    for (const artifact of artifacts) {
      await expect(fs.access(artifact.path)).resolves.toBeUndefined();
      if (!artifact.path.endsWith(".png")) continue;
      const metadata = await sharp(artifact.path).metadata();
      expect(metadata.width).toBeGreaterThan(0);
      expect(metadata.height).toBeGreaterThan(0);
    }

    const legendArtifact = artifacts.find(artifact => artifact.role === "final_diff_groups_legend");
    expect(legendArtifact).toBeDefined();
    const legend = JSON.parse(await fs.readFile(legendArtifact!.path, "utf8")) as {
      groups: Array<{ diffIds: string[]; zoomArtifact?: string }>;
    };
    expect(legend.groups).toHaveLength(1);
    expect(legend.groups[0]?.diffIds.sort()).toEqual(["diff-1", "diff-2"]);
    expect(legend.groups[0]?.zoomArtifact).toContain("final-diff-zoom-001.png");
  });
});
