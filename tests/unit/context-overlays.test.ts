import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFindingGroups, buildSemanticHierarchy, overlayStyleForImage, selectZoomGroups, writeRegionContextOverlays } from "../../src/report/context-overlays.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";
import type { DiffRecord, GeometryDiagnosticReference, UiElement, UnresolvedRegion } from "../../src/schemas/core.js";

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
    targetIds: ["card-1"],
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

function element(id: string, label: string, type: UiElement["type"], box: UiElement["box"], parentId?: string): UiElement {
  return {
    id,
    label,
    type,
    box,
    normalizedBox: { x: box.x / 200, y: box.y / 400, width: box.width / 200, height: box.height / 400 },
    confidence: 0.9,
    source: "locator",
    ...(parentId ? { parentId } : {}),
    childIds: []
  };
}

function card(): UiElement {
  return element("card-1", "Summary card", "card", { x: 10, y: 30, width: 120, height: 80 });
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

  it("groups equivalent local geometry across different or missing target IDs", () => {
    const geometry = { ...diff("geometry"), targetIds: ["card-a"] };
    const color = {
      ...diff("color"),
      criterion: "color_appearance" as const,
      targetIds: undefined,
      location: { x: 21, y: 40, width: 79, height: 50 }
    };

    const groups = buildFindingGroups([geometry, color], { width: 200, height: 400 });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.diffIds).toEqual(["color", "geometry"]);
    expect(groups[0]?.criteria).toEqual(["color_appearance", "geometry"]);
    expect(groups[0]?.label).toBe("G1");
  });

  it("does not group merely nested nearby boxes without ownership or displacement", () => {
    const parent = { ...diff("parent"), targetIds: [], location: { x: 20, y: 40, width: 80, height: 50 } };
    const child = { ...diff("child"), targetIds: [], location: { x: 25, y: 45, width: 60, height: 30 } };

    expect(buildFindingGroups([parent, child], { width: 200, height: 400 })).toHaveLength(2);
  });

  it("builds equivalent-geometry groups stably under input permutations", () => {
    const findings = [
      { ...diff("b"), targetIds: ["target-b"] },
      { ...diff("a"), targetIds: undefined, criterion: "color_appearance" as const },
      { ...diff("c"), targetIds: ["target-c"], criterion: "spacing_alignment" as const }
    ];

    const forward = buildFindingGroups(findings, { width: 200, height: 400 });
    const reversed = buildFindingGroups([...findings].reverse(), { width: 200, height: 400 });

    expect(reversed).toEqual(forward);
    expect(forward[0]?.diffIds).toEqual(["a", "b", "c"]);
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

  it("forms one repair group only for nearby coherent displacement evidence", () => {
    const nearby = [0, 1, 2].map(index => ({
      ...diff(`shift-${index}`),
      location: { x: 20 + index * 32, y: 40, width: 24, height: 20 },
      findingGroupId: "shifted-summary",
      findingGroupKind: "coherent_displacement" as const,
      measurements: [{ name: "horizontal_shift", value: 12, unit: "px" }]
    }));

    const groups = buildFindingGroups(nearby);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.diffIds).toEqual(["shift-0", "shift-1", "shift-2"]);
  });

  it("keeps separated cards in distinct repair groups despite a shared screen explanation", () => {
    const parent = {
      ...diff("screen-context"),
      location: { x: 0, y: 0, width: 200, height: 400 },
      scopeKind: "screen" as const
    };
    const topCard = { ...diff("top-card"), location: { x: 20, y: 40, width: 80, height: 60 }, targetIds: ["top-card"] };
    const bottomCard = { ...diff("bottom-card"), location: { x: 20, y: 280, width: 80, height: 60 }, targetIds: ["bottom-card"] };

    const groups = buildFindingGroups([parent, topCard, bottomCard]);

    expect(groups.map(group => group.diffIds)).toEqual([
      ["screen-context"],
      ["top-card"],
      ["bottom-card"]
    ]);
  });

  it("builds semantic hierarchy separately from visual diff groups", () => {
    const macro = element("macro", "Macro summary", "card", { x: 10, y: 80, width: 180, height: 180 });
    const circle = element("circle", "Macro circle", "chart", { x: 30, y: 100, width: 90, height: 90 }, macro.id);
    const protein = element("protein", "Protein", "card", { x: 130, y: 105, width: 50, height: 35 }, macro.id);
    macro.childIds = [circle.id, protein.id];

    const nodes = buildSemanticHierarchy([macro, circle, protein], 200, 400);

    expect(nodes[0]).toMatchObject({ id: "screen", label: "Screen", childNodeIds: ["macro"] });
    expect(nodes.find(node => node.id === "macro")).toMatchObject({
      parentNodeId: "screen",
      childNodeIds: ["circle", "protein"]
    });
    expect(nodes.find(node => node.id === "circle")).toMatchObject({ parentNodeId: "macro", type: "chart" });
  });

  it("skips near-full-screen nodes and re-parents their children to the screen", () => {
    const fullScreen = element("full", "buttons and tappable controls", "button", { x: 0, y: 20, width: 200, height: 370 });
    const inner = element("inner", "Summary card", "card", { x: 10, y: 40, width: 80, height: 60 }, fullScreen.id);
    fullScreen.childIds = [inner.id];

    const nodes = buildSemanticHierarchy([fullScreen, inner], 200, 400);

    expect(nodes.find(node => node.id === "full")).toBeUndefined();
    expect(nodes.find(node => node.id === "inner")).toMatchObject({ parentNodeId: "screen" });
    expect(nodes[0]?.childNodeIds).toEqual(["inner"]);
  });

  it("includes non-semantic containers with two or more children as hierarchy nodes", () => {
    const section = element("sec", "component-3", "unknown", { x: 0, y: 40, width: 200, height: 150 });
    const label1 = element("t1", "Protein", "text", { x: 10, y: 50, width: 60, height: 20 }, section.id);
    const label2 = element("t2", "96 g", "text", { x: 120, y: 50, width: 40, height: 20 }, section.id);
    section.childIds = [label1.id, label2.id];

    const nodes = buildSemanticHierarchy([section, label1, label2], 200, 400);

    expect(nodes.find(node => node.id === "sec")).toMatchObject({ parentNodeId: "screen", type: "unknown", nodeRole: "container" });
    expect(nodes.find(node => node.id === "t1")).toMatchObject({ parentNodeId: "sec", nodeRole: "leaf" });
    expect(nodes.find(node => node.id === "t2")).toMatchObject({ parentNodeId: "sec", nodeRole: "leaf" });
  });

  it("uses valid child geometry for locator text structural parents", () => {
    const parent = element("text-parent", "Nutrition card", "text", { x: 10, y: 40, width: 180, height: 100 });
    const icon = element("text-icon", "icon", "icon", { x: 20, y: 50, width: 20, height: 20 }, parent.id);
    const content = element("text-content", "96 g", "text", { x: 60, y: 50, width: 40, height: 20 }, parent.id);
    parent.childIds = [icon.id, content.id];
    const one = element("one-child", "one", "text", { x: 10, y: 180, width: 80, height: 40 });
    const oneChild = element("one-child-leaf", "only", "icon", { x: 20, y: 190, width: 20, height: 20 }, one.id);
    one.childIds = [oneChild.id];
    const invalid = { ...element("invalid", "invalid", "icon", { x: 110, y: 190, width: 20, height: 20 }, parent.id), box: { x: 110, y: 190, width: 0, height: 20 } };
    const merged = { ...parent, id: "merged-parent", source: "merged" as const };
    const mergedIcon = { ...icon, id: "merged-icon", parentId: merged.id };
    const mergedContent = { ...content, id: "merged-content", parentId: merged.id };
    merged.childIds = [mergedIcon.id, mergedContent.id];
    const invalidParent = element("invalid-parent", "Invalid", "text", { x: 10, y: 260, width: 80, height: 40 });
    const invalidChild = { ...element("invalid-child", "bad", "icon", { x: 20, y: 270, width: 20, height: 20 }, invalidParent.id), box: { x: 20, y: 270, width: 0, height: 20 } };
    invalidParent.childIds = [invalidChild.id];
    const empty = element("empty-parent", "Empty", "text", { x: 110, y: 260, width: 80, height: 40 });
    const nodes = buildSemanticHierarchy([parent, icon, content, one, oneChild, invalid, merged, mergedIcon, mergedContent, invalidParent, invalidChild, empty], 200, 400);
    expect(nodes.find(node => node.id === parent.id)).toMatchObject({ nodeRole: "container" });
    expect(nodes.find(node => node.id === one.id)).toMatchObject({ nodeRole: "leaf" });
    expect(nodes.find(node => node.id === merged.id)).toMatchObject({ nodeRole: "leaf" });
    expect(nodes.find(node => node.id === invalidParent.id)).toMatchObject({ nodeRole: "leaf" });
    expect(nodes.find(node => node.id === empty.id)).toMatchObject({ nodeRole: "leaf" });
  });

  it("groups independent icon and content criteria under the local structural parent", () => {
    const findings = [
      { ...diff("icon"), criterion: "icon_image" as const, targetIds: ["parent", "icon"] },
      { ...diff("content"), criterion: "typography_content" as const, targetIds: ["parent", "content"] }
    ];
    const groups = buildFindingGroups(findings, { width: 200, height: 400 });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.diffIds).toEqual(["content", "icon"]);
    expect(groups[0]?.criteria).toEqual(["icon_image", "typography_content"]);
  });

  it("retains ordinary text and icon leaves beneath a card through a structural component", () => {
    const summary = element("summary", "<ref> Macro summary </ref><12,34,56,78>", "card", { x: 10, y: 40, width: 180, height: 160 });
    const component = element("component", "cv_component", "unknown", { x: 20, y: 60, width: 160, height: 120 }, summary.id);
    const title = element("title", "<box> Protein </box><1,2,3,4>", "text", { x: 30, y: 70, width: 70, height: 20 }, component.id);
    const icon = element("icon", "<ref> Macro icon </ref>", "icon", { x: 35, y: 105, width: 20, height: 20 }, component.id);
    const value = element("value", "96 g", "text", { x: 65, y: 105, width: 50, height: 20 }, component.id);
    summary.childIds = [component.id];
    component.childIds = [title.id, icon.id, value.id];

    const nodes = buildSemanticHierarchy([summary, component, title, icon, value], 200, 400);

    expect(nodes.find(node => node.id === "summary")).toMatchObject({ nodeRole: "container", parentNodeId: "screen" });
    expect(nodes.find(node => node.id === "component")).toMatchObject({ nodeRole: "container", parentNodeId: "summary" });
    for (const id of [title.id, icon.id, value.id]) {
      expect(nodes.find(node => node.id === id)).toMatchObject({ nodeRole: "leaf", parentNodeId: component.id });
    }
    expect(nodes.map(node => node.label).join(" ")).not.toMatch(/<\/?(?:ref|box)>|<\d+(?:\s*,\s*\d+)*>/);
    expect(nodes.every(node => node.coordinateSpace === "comparison_expected_normalized")).toBe(true);
  });

  it("keeps multiple macro cards under a structural container in deterministic order", () => {
    const section = element("section", "Macro section", "unknown", { x: 0, y: 40, width: 200, height: 180 });
    const carbs = element("carbs", "Carbs", "card", { x: 10, y: 55, width: 80, height: 120 }, section.id);
    const protein = element("protein", "Protein", "card", { x: 110, y: 55, width: 80, height: 120 }, section.id);
    section.childIds = [carbs.id, protein.id];

    const forward = buildSemanticHierarchy([section, carbs, protein], 200, 400);
    const reversed = buildSemanticHierarchy([protein, carbs, section], 200, 400);

    expect(forward).toEqual(reversed);
    expect(forward.find(node => node.id === section.id)).toMatchObject({
      nodeRole: "container",
      childNodeIds: ["carbs", "protein"]
    });
  });

  it("suppresses hidden or disjoint parents without dropping reachable descendants", () => {
    const diagnostics: GeometryDiagnosticReference[] = [];
    const outer = element("outer", "Dashboard", "card", { x: 0, y: 50, width: 200, height: 300 });
    const fullScreen = element("full", "Visible controls", "unknown", { x: 0, y: 20, width: 200, height: 370 }, outer.id);
    const hiddenText = element("hidden-text", "Daily target", "text", { x: 20, y: 60, width: 80, height: 20 }, fullScreen.id);
    const disjoint = element("disjoint", "Offscreen card", "card", { x: 220, y: 40, width: 40, height: 40 }, outer.id);
    const disjointIcon = element("disjoint-icon", "Target icon", "icon", { x: 30, y: 100, width: 20, height: 20 }, disjoint.id);
    outer.childIds = [fullScreen.id, disjoint.id];
    fullScreen.childIds = [hiddenText.id];
    disjoint.childIds = [disjointIcon.id];

    const nodes = buildSemanticHierarchy(
      [outer, fullScreen, hiddenText, disjoint, disjointIcon],
      200,
      400,
      diagnostics
    );

    expect(nodes.find(node => node.id === fullScreen.id)).toBeUndefined();
    expect(nodes.find(node => node.id === disjoint.id)).toBeUndefined();
    expect(nodes.find(node => node.id === hiddenText.id)).toMatchObject({ parentNodeId: outer.id, nodeRole: "leaf" });
    expect(nodes.find(node => node.id === disjointIcon.id)).toMatchObject({ parentNodeId: outer.id, nodeRole: "leaf" });
    expect(diagnostics).toContainEqual({ producer: "semantic_hierarchy", reason: "disjoint", reference: "element:disjoint" });
  });

  it("walks parenting through non-node ancestors to the nearest hierarchy node", () => {
    const outerCard = element("outer", "Hero card", "card", { x: 0, y: 40, width: 200, height: 200 });
    const textWrap = element("wrap", "text wrapper", "text", { x: 10, y: 60, width: 180, height: 100 }, outerCard.id);
    const chart = element("ring", "Macro ring", "chart", { x: 20, y: 70, width: 80, height: 80 }, textWrap.id);
    outerCard.childIds = [textWrap.id];
    textWrap.childIds = [chart.id];

    const nodes = buildSemanticHierarchy([outerCard, textWrap, chart], 200, 400);

    expect(nodes.find(node => node.id === "ring")).toMatchObject({ parentNodeId: "outer" });
    expect(nodes.find(node => node.id === "outer")?.childNodeIds).toContain("ring");
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
      "semantic_hierarchy_legend",
      "semantic_hierarchy_overlay",
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

    const hierarchyArtifact = artifacts.find(artifact => artifact.role === "semantic_hierarchy_legend");
    expect(hierarchyArtifact).toBeDefined();
    const hierarchy = JSON.parse(await fs.readFile(hierarchyArtifact!.path, "utf8")) as {
      nodes: Array<{ id: string; childNodeIds: string[] }>;
    };
    expect(hierarchy.nodes.some(node => node.id === "screen")).toBe(true);
  });

  it("records a rejected zoom without a PNG or zoom artifact", async () => {
    const actualComparisonPath = await writeSolidPng(tmpDir, "actual-comparison.png", 200, 400, 30, 30, 30);
    const directionalOverlayPath = await writeSolidPng(tmpDir, "directional-overlay.png", 200, 400, 10, 10, 10);
    const rejectedDiff = { ...diff("edge-diff"), location: { x: 400, y: 500, width: 10, height: 10 } };

    const geometryRejections: GeometryDiagnosticReference[] = [];
    const artifacts = await writeRegionContextOverlays({
      actualComparisonPath,
      directionalOverlayPath,
      artifactDir: tmpDir,
      diffs: [rejectedDiff],
      unresolvedRegions: [],
      elements: [],
      geometryRejections
    });

    expect(artifacts.some(artifact => artifact.role === "final_diff_zoom")).toBe(false);
    await expect(fs.readdir(tmpDir)).resolves.not.toContain("final-diff-zoom-001.png");
    const legendPath = artifacts.find(artifact => artifact.role === "final_diff_groups_legend")!.path;
    await expect(fs.readFile(legendPath, "utf8")).resolves.toContain('"zoomStatus": "rejected"');
    await expect(fs.readFile(legendPath, "utf8")).resolves.toContain('"zoomRejectionReason": "disjoint"');
  });

  it("uses pipeline-canonical locations in group legends and keeps broad evidence standalone but out of zooms", async () => {
    const actualComparisonPath = await writeSolidPng(tmpDir, "actual-comparison.png", 200, 400, 30, 30, 30);
    const directionalOverlayPath = await writeSolidPng(tmpDir, "directional-overlay.png", 200, 400, 10, 10, 10);
    const projected = {
      ...diff("actual-source"),
      location: { x: 50, y: 100, width: 20, height: 20 },
      reviewerStatus: "not_reviewed" as const,
      classificationSource: "deterministic_projected_mismatch" as const,
      coordinateSpace: "comparison_expected_normalized" as const
    };
    const broad = {
      ...diff("broad-vlm"),
      location: { x: 0, y: 0, width: 200, height: 400 },
      targetIds: [],
      scopeKind: "screen" as const
    };

    const artifacts = await writeRegionContextOverlays({
      actualComparisonPath,
      directionalOverlayPath,
      artifactDir: tmpDir,
      diffs: [projected, broad],
      unresolvedRegions: [],
      elements: []
    });

    const legendPath = artifacts.find(artifact => artifact.role === "final_diff_groups_legend")!.path;
    const legend = JSON.parse(await fs.readFile(legendPath, "utf8")) as {
      groups: Array<{ box: DiffRecord["location"]; diffIds: string[]; zoomStatus: string; zoomSkippedReason?: string }>;
    };
    expect(legend.groups).toHaveLength(2);
    expect(legend.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        box: { x: 50, y: 100, width: 20, height: 20 },
        diffIds: ["actual-source"],
        coordinateSpace: "comparison_expected_normalized",
        zoomStatus: "valid"
      }),
      expect.objectContaining({
        box: { x: 0, y: 0, width: 200, height: 400 },
        diffIds: ["broad-vlm"],
        coordinateSpace: "comparison_expected_normalized",
        zoomStatus: "skipped",
        zoomSkippedReason: "broad_finding"
      })
    ]));
    expect(artifacts.filter(artifact => artifact.role === "final_diff_zoom")).toHaveLength(1);
  });

  it("references broad and local final diffs exactly once without merging them", () => {
    const broad = {
      ...diff("screen-layout"),
      location: { x: 0, y: 0, width: 200, height: 400 },
      scopeKind: "screen" as const,
      targetIds: []
    };
    const local = {
      ...diff("card-layout"),
      location: { x: 20, y: 40, width: 80, height: 50 }
    };

    const groups = buildFindingGroups([broad, local], { width: 200, height: 400 });
    const references = groups.flatMap(group => group.diffIds);

    expect(groups).toHaveLength(2);
    expect(references.sort()).toEqual(["card-layout", "screen-layout"]);
    expect(references.filter(id => id === "screen-layout")).toHaveLength(1);
    expect(references.filter(id => id === "card-layout")).toHaveLength(1);
  });

  it("keeps suppressed child evidence reachable through the repair-group legend", async () => {
    const actualComparisonPath = await writeSolidPng(tmpDir, "actual-comparison.png", 200, 400, 30, 30, 30);
    const directionalOverlayPath = await writeSolidPng(tmpDir, "directional-overlay.png", 200, 400, 10, 10, 10);
    const retainedParent = {
      ...diff("card-layout"),
      suppression: {
        reason: "duplicate_child_of_group" as const,
        retainedFindingIds: ["title-layout", "value-layout"]
      }
    };

    const artifacts = await writeRegionContextOverlays({
      actualComparisonPath,
      directionalOverlayPath,
      artifactDir: tmpDir,
      diffs: [retainedParent],
      unresolvedRegions: [],
      elements: []
    });

    const legendPath = artifacts.find(artifact => artifact.role === "final_diff_groups_legend")!.path;
    const legend = JSON.parse(await fs.readFile(legendPath, "utf8")) as {
      groups: Array<{ retainedFindingIds: string[]; suppressions: Array<{ reason: string; retainedFindingIds: string[] }> }>;
    };
    expect(legend.groups[0]).toMatchObject({
      retainedFindingIds: ["card-layout", "title-layout", "value-layout"],
      suppressions: [{ reason: "duplicate_child_of_group", retainedFindingIds: ["title-layout", "value-layout"] }]
    });
  });

  it("keeps every repair group in the legend when zoom output is capped", async () => {
    vi.stubEnv("UI_DIFF_MAX_CONTEXT_ZOOMS", "1");
    const actualComparisonPath = await writeSolidPng(tmpDir, "actual-comparison.png", 200, 400, 30, 30, 30);
    const directionalOverlayPath = await writeSolidPng(tmpDir, "directional-overlay.png", 200, 400, 10, 10, 10);
    const diffs = [20, 140, 260].map((y, index) => ({
      ...diff(`group-${index + 1}`),
      location: { x: 20, y, width: 40, height: 30 },
      targetIds: [`card-${index + 1}`]
    }));

    const artifacts = await writeRegionContextOverlays({
      actualComparisonPath,
      directionalOverlayPath,
      artifactDir: tmpDir,
      diffs,
      unresolvedRegions: [],
      elements: []
    });
    const legendPath = artifacts.find(artifact => artifact.role === "final_diff_groups_legend")!.path;
    const legend = JSON.parse(await fs.readFile(legendPath, "utf8")) as { groups: Array<{ zoomStatus: string; zoomSkippedReason?: string }> };

    expect(legend.groups).toHaveLength(3);
    expect(legend.groups.map(group => group.zoomStatus)).toEqual(["valid", "skipped", "skipped"]);
    expect(legend.groups.slice(1).every(group => group.zoomSkippedReason === "max_zooms_exceeded")).toBe(true);
  });

  it("selects the stable-ID equal-priority prebuilt group for the capped zoom", () => {
    const make = (id: string) => ({
      id,
      label: id,
      box: { x: 20, y: 40, width: 40, height: 30 },
      diffIds: [id],
      criteria: ["geometry"],
      severity: "medium" as const,
      retainedFindingIds: [id],
      suppressions: [],
      targetIds: [id],
      evidenceArea: 1_200,
      coherentDisplacementKey: undefined,
      broad: false
    });
    const aGroup = make("a-group");
    const zGroup = make("z-group");

    expect(selectZoomGroups([zGroup, aGroup], 1).map(group => group.id)).toEqual(["a-group"]);
    expect(selectZoomGroups([aGroup, zGroup], 1).map(group => group.id)).toEqual(["a-group"]);
  });
});
