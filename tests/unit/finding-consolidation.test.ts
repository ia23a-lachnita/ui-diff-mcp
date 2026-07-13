import { describe, expect, it } from "vitest";
import { consolidateFindings, finalizeFindings, selectSuppressionParent } from "../../src/report/finding-consolidation.js";
import { createImagePairTransform } from "../../src/images/coordinates.js";
import type { DiffRecord, ElementPair, UiElement, UiElementType } from "../../src/schemas/core.js";

function element(id: string, type: UiElementType, x: number, y: number, width: number, height: number, parentId?: string, source: UiElement["source"] = "locator"): UiElement {
  return {
    id,
    label: id.replaceAll("-", " "),
    type,
    box: { x, y, width, height },
    normalizedBox: { x: x / 500, y: y / 500, width: width / 500, height: height / 500 },
    confidence: 0.9,
    source,
    ...(parentId ? { parentId } : {}),
    childIds: []
  };
}

function finding(id: string, pairId: string | undefined, criterion: DiffRecord["criterion"], x: number, y: number, width = 8, height = 8, source: DiffRecord["classificationSource"] = "vlm_reviewed"): DiffRecord {
  return {
    id,
    ...(pairId ? { pairId } : {}),
    criterion,
    severity: "medium",
    title: `${criterion} fragment`,
    location: { x, y, width, height },
    evidence: [`evidence for ${id}`],
    measurements: [],
    artifactPaths: [{ role: "expected_crop", path: `${id}-expected.png` }],
    reviewerStatus: "accepted",
    classificationSource: source
  };
}

function pair(id: string, expectedId: string): ElementPair {
  return { id, expectedId, status: "matched", score: 1, reasons: [] };
}

describe("consolidateFindings", () => {
  it("consolidates chart child fragments under their semantic chart parent", () => {
    const chart = element("chart", "chart", 0, 0, 200, 150);
    const children = [
      element("dot-a", "icon", 10, 20, 8, 8, chart.id),
      element("dot-b", "icon", 30, 40, 8, 8, chart.id),
      element("dot-c", "icon", 50, 60, 8, 8, chart.id),
      element("bar-a", "unknown", 80, 30, 12, 60, chart.id),
      element("bar-b", "unknown", 110, 20, 12, 70, chart.id)
    ];
    chart.childIds = children.map(child => child.id);
    const pairs = children.map((child, index) => pair(`pair-${index}`, child.id));
    const diffs = children.map((child, index) => finding(`diff-${index}`, pairs[index]!.id, "color_appearance", child.box.x, child.box.y, child.box.width, child.box.height));

    const result = consolidateFindings(diffs, [chart, ...children], pairs);

    expect(result).toHaveLength(5);
  });

  it("keeps unrelated adjacent controls separate", () => {
    const first = element("first-button", "button", 0, 0, 40, 30);
    const second = element("second-button", "button", 42, 0, 40, 30);
    const pairs = [pair("pair-first", first.id), pair("pair-second", second.id)];
    const result = consolidateFindings([
      finding("diff-first", "pair-first", "geometry", 0, 0, 40, 30),
      finding("diff-second", "pair-second", "geometry", 42, 0, 40, 30)
    ], [first, second], pairs);

    expect(result).toHaveLength(2);
  });

  it("folds overlapping recovery evidence into an existing semantic parent finding", () => {
    const card = element("summary-card", "card", 10, 10, 150, 100);
    const label = element("summary-label", "text", 20, 20, 80, 20, card.id);
    card.childIds = [label.id];
    const result = consolidateFindings([
      finding("audited", "pair-label", "typography_content", 20, 20, 80, 20),
      finding("recovered", undefined, "typography_content", 18, 18, 90, 24, "target_recovery")
    ], [card, label], [pair("pair-label", label.id)]);

    expect(result).toHaveLength(1);
    expect(result[0]?.childFindingIds).toEqual(expect.arrayContaining(["audited", "recovered"]));
    expect(result[0]?.evidence).toEqual(expect.arrayContaining(["evidence for audited", "evidence for recovered"]));
  });

  it("keeps different criteria on the same parent separate", () => {
    const card = element("card", "card", 0, 0, 100, 100);
    const icon = element("icon", "icon", 10, 10, 20, 20, card.id);
    card.childIds = [icon.id];
    const result = consolidateFindings([
      finding("geometry", "pair-icon", "geometry", 10, 10, 20, 20),
      finding("color", "pair-icon", "color_appearance", 10, 10, 20, 20)
    ], [card, icon], [pair("pair-icon", icon.id)]);

    expect(result).toHaveLength(2);
  });

  it("does not use unknown or merged containers as consolidation parents", () => {
    const wrapper = element("wrapper", "unknown", 0, 0, 100, 100, undefined, "merged");
    const a = element("a", "icon", 10, 10, 10, 10, wrapper.id);
    const b = element("b", "icon", 60, 60, 10, 10, wrapper.id);
    wrapper.childIds = [a.id, b.id];
    const result = consolidateFindings([
      finding("a-diff", "pair-a", "geometry", 10, 10, 10, 10),
      finding("b-diff", "pair-b", "geometry", 60, 60, 10, 10)
    ], [wrapper, a, b], [pair("pair-a", a.id), pair("pair-b", b.id)]);

    expect(result).toHaveLength(2);
  });

  it("does not upgrade deterministic children to reviewer accepted", () => {
    const card = element("card", "card", 0, 0, 100, 100);
    const child = element("child", "icon", 10, 10, 20, 20, card.id);
    card.childIds = [child.id];
    const deterministic = finding(
      "deterministic",
      "pair-child",
      "geometry",
      10,
      10,
      20,
      20,
      "deterministic_geometry"
    );
    deterministic.reviewerStatus = "not_reviewed";

    const result = consolidateFindings([deterministic], [card, child], [pair("pair-child", child.id)]);

    expect(result[0]?.reviewerStatus).toBe("not_reviewed");
  });

  it("consolidates an explicit coherent displacement group under a generic parent", () => {
    const wrapper = element("wrapper", "text", 0, 0, 300, 500, undefined, "merged");
    const children = Array.from({ length: 6 }, (_, index) => element(`child-${index}`, "text", 20, 40 + index * 60, 20, 20, wrapper.id));
    wrapper.childIds = children.map(child => child.id);
    const pairs = children.map((child, index) => pair(`pair-${index}`, child.id));
    const diffs = children.map((child, index) => {
      const diff = finding(`grouped-${index}`, pairs[index]!.id, "geometry", child.box.x, child.box.y, 20, 120, "deterministic_projected_mismatch");
      diff.reviewerStatus = "not_reviewed";
      diff.findingGroupId = "displacement-nutrition";
      diff.findingGroupKind = "coherent_displacement";
      diff.groupLabel = "Nutrition summary";
      diff.coverageLocations = [child.box, { ...child.box, y: child.box.y + 100 }];
      diff.measurements = [
        { name: "horizontal_shift", value: 0, unit: "px" },
        { name: "vertical_shift", value: 100, unit: "px" }
      ];
      return diff;
    });

    const result = consolidateFindings(diffs, [wrapper, ...children], pairs);

    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Nutrition summary displaced from expected position");
    expect(result[0]?.childFindingIds).toHaveLength(6);
  });

  it("keeps different explicit displacement groups separate under one generic parent", () => {
    const wrapper = element("wrapper", "text", 0, 0, 300, 500, undefined, "merged");
    const children = [
      element("a-1", "text", 20, 40, 20, 20, wrapper.id),
      element("a-2", "text", 20, 80, 20, 20, wrapper.id),
      element("b-1", "text", 20, 300, 20, 20, wrapper.id),
      element("b-2", "text", 20, 340, 20, 20, wrapper.id)
    ];
    const pairs = children.map((child, index) => pair(`pair-explicit-${index}`, child.id));
    const diffs = children.map((child, index) => {
      const diff = finding(`explicit-${index}`, pairs[index]!.id, "geometry", child.box.x, child.box.y, 20, 80, "deterministic_projected_mismatch");
      diff.reviewerStatus = "not_reviewed";
      diff.findingGroupId = index < 2 ? "group-a" : "group-b";
      diff.findingGroupKind = "coherent_displacement";
      diff.groupLabel = index < 2 ? "Upper region" : "Lower region";
      return diff;
    });

    const result = consolidateFindings(diffs, [wrapper, ...children], pairs);

    expect(result).toHaveLength(2);
    expect(result.map(item => item.findingGroupId).sort()).toEqual(["group-a", "group-b"]);
  });

  it("folds target children into a larger scope finding for the same criterion", () => {
    const card = element("card", "card", 20, 100, 200, 180);
    const label = element("label", "text", 40, 130, 80, 20, card.id);
    card.childIds = [label.id];
    const scopeFinding = finding("region-layout", undefined, "geometry", 0, 80, 260, 260);
    scopeFinding.scopeId = "content";
    scopeFinding.scopeKind = "region";
    scopeFinding.scopeLabel = "Content";
    const childFinding = finding("label-layout", "pair-label", "geometry", 40, 130, 80, 20);

    const result = consolidateFindings([scopeFinding, childFinding], [card, label], [pair("pair-label", label.id)]);

    expect(result).toHaveLength(1);
    expect(result[0]?.childFindingIds).toEqual(expect.arrayContaining(["region-layout", "label-layout"]));
  });

  it("folds explicit projected structural groups into an overlapping scope finding for the same target and criterion", () => {
    const nav = element("nav", "nav", 0, 80, 500, 420);
    const tab = element("today-tab", "button", 40, 360, 80, 80, nav.id);
    nav.childIds = [tab.id];
    const scopeFinding = finding("nav-layout", undefined, "geometry", 0, 80, 500, 420);
    scopeFinding.scopeId = "nav";
    scopeFinding.scopeKind = "region";
    scopeFinding.scopeLabel = "Navigation";
    scopeFinding.targetIds = [nav.id, tab.id];
    const projected = finding(
      "projected-tab",
      "pair-tab",
      "geometry",
      50,
      370,
      70,
      70,
      "deterministic_projected_mismatch"
    );
    projected.reviewerStatus = "not_reviewed";
    projected.targetIds = [nav.id, tab.id];
    projected.findingGroupId = "structural-nav";
    projected.findingGroupKind = "structural_region_mismatch";
    projected.groupLabel = "Navigation tab";

    const result = consolidateFindings([projected, scopeFinding], [nav, tab], [pair("pair-tab", tab.id)]);

    expect(result).toHaveLength(1);
    expect(result[0]?.childFindingIds).toEqual(expect.arrayContaining(["nav-layout", "projected-tab"]));
  });

  it("does not fold projected groups into a screen-sized final finding created by child consolidation", () => {
    const nav = element("nav", "nav", 0, 0, 500, 500);
    const top = element("top-control", "button", 0, 0, 80, 80, nav.id);
    const bottom = element("bottom-control", "button", 0, 420, 80, 80, nav.id);
    const middle = element("middle-control", "button", 0, 220, 80, 80, nav.id);
    nav.childIds = [top.id, bottom.id, middle.id];
    const topFinding = finding("top-layout", undefined, "geometry", 0, 0, 80, 80);
    topFinding.scopeId = "nav";
    topFinding.scopeKind = "region";
    topFinding.targetIds = [nav.id];
    const bottomFinding = finding("bottom-layout", undefined, "geometry", 0, 420, 80, 80);
    bottomFinding.scopeId = "nav";
    bottomFinding.scopeKind = "region";
    bottomFinding.targetIds = [nav.id];
    const projected = finding(
      "projected-middle",
      "pair-middle",
      "geometry",
      0,
      220,
      80,
      80,
      "deterministic_projected_mismatch"
    );
    projected.reviewerStatus = "not_reviewed";
    projected.targetIds = [nav.id, middle.id];
    projected.findingGroupId = "structural-middle";
    projected.findingGroupKind = "structural_region_mismatch";

    const result = consolidateFindings(
      [topFinding, bottomFinding, projected],
      [nav, top, bottom, middle],
      [pair("pair-top", top.id), pair("pair-bottom", bottom.id), pair("pair-middle", middle.id)]
    );

    expect(result).toHaveLength(3);
    expect(result.map(item => item.id).sort()).toEqual(["bottom-layout", "projected-middle", "top-layout"]);
  });

  it("does not let a screen-sized nav parent swallow localized repair findings", () => {
    const nav = element("screen-nav", "nav", 0, 0, 500, 500);
    const top = element("top-control", "text", 40, 40, 80, 80, nav.id);
    const bottom = element("bottom-control", "text", 40, 380, 80, 80, nav.id);
    nav.childIds = [top.id, bottom.id];
    const topFinding = finding("top-layout", undefined, "geometry", 40, 40, 80, 80);
    topFinding.targetIds = [nav.id, top.id];
    const bottomFinding = finding("bottom-layout", undefined, "geometry", 40, 380, 80, 80);
    bottomFinding.targetIds = [nav.id, bottom.id];

    const result = consolidateFindings(
      [topFinding, bottomFinding],
      [nav, top, bottom],
      []
    );

    expect(result).toHaveLength(2);
    expect(result.map(item => item.id).sort()).toEqual(["bottom-layout", "top-layout"]);
  });

  it("does not crash when a scope finding has no overlap with semantic parents", () => {
    const card = element("card", "card", 20, 100, 200, 180);
    const scopeFinding = finding("screen-color", undefined, "color_appearance", 400, 800, 120, 120);
    scopeFinding.scopeId = "screen";
    scopeFinding.scopeKind = "screen";
    scopeFinding.scopeLabel = "Screen";

    const result = consolidateFindings([scopeFinding], [card], []);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("screen-color");
  });

  it("prefers locator parents over projected clones when consolidating shared targets", () => {
    const button = element("today-button", "button", 0, 100, 180, 40);
    const projectedButton = element("proj-today-button", "button", 0, 102, 160, 36, undefined, "projected");
    const text = element("today-text", "text", 60, 96, 90, 44, button.id);
    button.childIds = [text.id];

    const textFinding = finding("today-text-geometry", "pair-text", "geometry", 60, 96, 90, 44);
    textFinding.targetIds = [text.id, button.id];
    const buttonFinding = finding("today-button-geometry", "pair-button", "geometry", 0, 102, 180, 38);
    buttonFinding.targetIds = [button.id, projectedButton.id];

    const result = consolidateFindings(
      [textFinding, buttonFinding],
      [button, projectedButton, text],
      [pair("pair-text", text.id), pair("pair-button", button.id)]
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.targetIds).toContain(button.id);
    expect(result[0]?.childFindingIds).toEqual(expect.arrayContaining(["today-text-geometry", "today-button-geometry"]));
  });

  it("folds child layout diffs under a containing parent layout displacement across layout criteria", () => {
    const card = element("macro-card", "card", 20, 100, 300, 220);
    const label = element("protein-label", "text", 44, 130, 120, 28, card.id);
    const bar = element("protein-bar", "chart", 44, 180, 240, 20, card.id);
    card.childIds = [label.id, bar.id];
    const parent = finding("card-geometry", "pair-card", "geometry", 20, 100, 300, 220);
    parent.targetIds = [card.id];
    const labelSpacing = finding("label-spacing", "pair-label", "spacing_alignment", 44, 130, 120, 28);
    labelSpacing.targetIds = [label.id, card.id];
    const barGeometry = finding("bar-geometry", "pair-bar", "geometry", 44, 180, 240, 20);
    barGeometry.targetIds = [bar.id, card.id];

    const result = consolidateFindings(
      [parent, labelSpacing, barGeometry],
      [card, label, bar],
      [pair("pair-card", card.id), pair("pair-label", label.id), pair("pair-bar", bar.id)]
    );

    expect(result).toHaveLength(2);
    expect(result.find(item => item.criterion === "geometry")?.childFindingIds).toEqual(expect.arrayContaining(["card-geometry", "bar-geometry"]));
  });

  it("keeps child color and typography findings separate from parent layout displacement", () => {
    const card = element("recent-card", "card", 20, 100, 300, 220);
    const label = element("recent-title", "text", 44, 130, 120, 28, card.id);
    card.childIds = [label.id];
    const parent = finding("card-geometry", "pair-card", "geometry", 20, 100, 300, 220);
    parent.targetIds = [card.id];
    const color = finding("title-color", "pair-label", "color_appearance", 44, 130, 120, 28);
    color.targetIds = [label.id, card.id];
    const text = finding("title-text", "pair-label", "typography_content", 44, 130, 120, 28);
    text.targetIds = [label.id, card.id];

    const result = consolidateFindings(
      [parent, color, text],
      [card, label],
      [pair("pair-card", card.id), pair("pair-label", label.id)]
    );

    expect(result).toHaveLength(3);
    expect(result.map(item => item.id).sort()).toEqual(["card-geometry", "title-color", "title-text"]);
  });

  it("retains nested displaced-card children under one parent repair item with traceable suppression", () => {
    const card = element("summary-card", "card", 20, 80, 240, 180);
    const title = element("summary-title", "text", 44, 104, 140, 24, card.id);
    const value = element("summary-value", "text", 44, 144, 100, 36, card.id);
    card.childIds = [title.id, value.id];
    const parent = finding("card-displaced", "pair-card", "geometry", 20, 80, 240, 180);
    parent.targetIds = [card.id];
    const titleChild = finding("title-displaced", "pair-title", "geometry", 44, 104, 140, 24);
    titleChild.targetIds = [title.id, card.id];
    parent.evidence = ["same translated card evidence"];
    titleChild.evidence = ["same translated card evidence"];
    parent.measurements = [{ name: "horizontal_shift", value: 0, unit: "px" }, { name: "vertical_shift", value: 12, unit: "px" }];
    titleChild.measurements = [{ name: "horizontal_shift", value: 0, unit: "px" }, { name: "vertical_shift", value: 12, unit: "px" }];

    const result = consolidateFindings(
      [parent, titleChild],
      [card, title, value],
      [pair("pair-card", card.id), pair("pair-title", title.id)]
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "card-displaced",
      suppression: {
        reason: "duplicate_child_of_group",
        retainedFindingIds: ["title-displaced"]
      }
    });
  });

  it("canonicalizes actual-source final locations before retaining repair findings", () => {
    const actualFinding = finding(
      "projected-actual",
      undefined,
      "geometry",
      200,
      100,
      80,
      40,
      "deterministic_projected_mismatch"
    );
    actualFinding.reviewerStatus = "not_reviewed";

    const result = consolidateFindings(
      [actualFinding],
      [],
      [],
      {
        canvas: { width: 200, height: 400 },
        imagePairTransform: createImagePairTransform({ width: 200, height: 400 }, { width: 400, height: 800 })
      }
    );

    expect(result[0]?.location).toEqual({ x: 100, y: 50, width: 40, height: 20 });
  });

  it("keeps separated card repairs separate even when both are layout findings", () => {
    const topCard = element("top-card", "card", 20, 40, 160, 100);
    const bottomCard = element("bottom-card", "card", 20, 260, 160, 100);
    const top = finding("top-card-layout", "pair-top", "geometry", 20, 40, 160, 100);
    const bottom = finding("bottom-card-layout", "pair-bottom", "geometry", 20, 260, 160, 100);
    top.targetIds = [topCard.id];
    bottom.targetIds = [bottomCard.id];

    const result = consolidateFindings(
      [top, bottom],
      [topCard, bottomCard],
      [pair("pair-top", topCard.id), pair("pair-bottom", bottomCard.id)]
    );

    expect(result.map(item => item.id).sort()).toEqual(["bottom-card-layout", "top-card-layout"]);
  });

  it("marks a full-screen VLM finding broad and escalated instead of repair-local", () => {
    const broad = finding("screen-vlm", undefined, "geometry", 0, 0, 200, 400);

    const result = consolidateFindings([broad], [], [], { canvas: { width: 200, height: 400 } });

    expect(result[0]).toMatchObject({
      repairLocality: "broad",
      reviewerStatus: "needs_escalation",
      coordinateSpace: "comparison_expected_normalized"
    });
  });

  it("preserves one final record for a nonlocal explicit displacement group", () => {
    const first = finding("first", undefined, "geometry", 20, 20, 30, 30);
    const second = finding("second", undefined, "geometry", 20, 300, 30, 30);
    for (const item of [first, second]) {
      item.findingGroupId = "same-explicit-group";
      item.findingGroupKind = "coherent_displacement";
      item.measurements = [{ name: "vertical_shift", value: 12, unit: "px" }];
    }

    const result = consolidateFindings([first, second], [], [], { canvas: { width: 200, height: 400 } });

    expect(result).toHaveLength(1);
    expect(result[0]?.findingGroupId).toBe("same-explicit-group");
    expect(result[0]?.location).toEqual({ x: 20, y: 20, width: 30, height: 310 });
    expect(result[0]?.childFindingIds).toEqual(expect.arrayContaining(["first", "second"]));
  });

  it("consolidates nearby semantic children that share the real coherent displacement group shape", () => {
    const buttons = element("buttons", "button", 15, 449, 373, 289);
    const firstChild = element("first-child", "text", 325, 435, 26, 44, buttons.id);
    const secondChild = element("second-child", "text", 325, 505, 26, 44, buttons.id);
    buttons.childIds = [firstChild.id, secondChild.id];
    const first = finding("first-diff", "pair-first-child", "geometry", 325, 435, 26, 44, "deterministic_projected_mismatch");
    const second = finding("second-diff", "pair-second-child", "geometry", 325, 505, 26, 44, "deterministic_projected_mismatch");
    for (const [index, item] of [first, second].entries()) {
      item.reviewerStatus = "not_reviewed";
      item.findingGroupId = "displacement-a696d7dd3806";
      item.findingGroupKind = "coherent_displacement";
      item.groupLabel = "buttons";
      item.targetIds = [index === 0 ? firstChild.id : secondChild.id, buttons.id];
      item.measurements = [
        { name: "horizontal_shift", value: -15, unit: "px" },
        { name: "vertical_shift", value: -96, unit: "px" }
      ];
      item.artifactPaths = [{ role: "projected_group_directional_overlay", path: "shared-group-overlay.png" }];
    }

    const result = consolidateFindings(
      [first, second],
      [buttons, firstChild, secondChild],
      [pair("pair-first-child", firstChild.id), pair("pair-second-child", secondChild.id)]
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      findingGroupId: "displacement-a696d7dd3806",
      location: { x: 325, y: 435, width: 26, height: 114 }
    });
    expect(result[0]?.artifactPaths).toEqual([{ role: "projected_group_directional_overlay", path: "shared-group-overlay.png" }]);
    expect(result[0]?.childFindingIds).toEqual(expect.arrayContaining(["first-diff", "second-diff"]));
    expect(result[0]?.targetIds).toEqual(expect.arrayContaining([buttons.id, firstChild.id, secondChild.id]));
  });

  it("canonicalizes projected coverage locations into the comparison canvas", () => {
    const projected = finding(
      "projected-coverage",
      undefined,
      "geometry",
      540,
      1200,
      108,
      240,
      "deterministic_projected_mismatch"
    );
    projected.reviewerStatus = "not_reviewed";
    projected.coverageLocations = [
      { x: 540, y: 1200, width: 108, height: 240 },
      { x: 540, y: 960, width: 108, height: 240 }
    ];

    const result = consolidateFindings([projected], [], [], {
      canvas: { width: 402, height: 874 },
      imagePairTransform: createImagePairTransform({ width: 402, height: 874 }, { width: 1080, height: 2400 })
    });

    expect(result[0]?.coverageLocations).toHaveLength(2);
    expect(result[0]?.coverageLocations?.[0]).toMatchObject({
      x: expect.closeTo(201),
      y: expect.closeTo(437),
      width: expect.closeTo(40.2),
      height: expect.closeTo(87.4)
    });
    expect(result[0]?.coverageLocations?.[1]).toMatchObject({
      x: expect.closeTo(201),
      y: expect.closeTo(349.6),
      width: expect.closeTo(40.2),
      height: expect.closeTo(87.4)
    });
    expect(result[0]?.coverageLocations?.every(box =>
      box.x >= 0 && box.y >= 0 && box.x + box.width <= 402 && box.y + box.height <= 874
    )).toBe(true);
  });

  it("does not transform an already canonical projected finding twice", () => {
    const projected = finding(
      "already-canonical",
      undefined,
      "geometry",
      201,
      437,
      40.2,
      87.4,
      "deterministic_projected_mismatch"
    );
    projected.reviewerStatus = "not_reviewed";
    projected.coordinateSpace = "comparison_expected_normalized";
    projected.coverageLocations = [{ x: 201, y: 349.6, width: 40.2, height: 87.4 }];

    const result = consolidateFindings([projected], [], [], {
      canvas: { width: 402, height: 874 },
      imagePairTransform: createImagePairTransform({ width: 402, height: 874 }, { width: 1080, height: 2400 })
    });

    expect(result[0]?.location).toMatchObject({
      x: expect.closeTo(201),
      y: expect.closeTo(437),
      width: expect.closeTo(40.2),
      height: expect.closeTo(87.4)
    });
    expect(result[0]?.coverageLocations?.[0]).toMatchObject({
      x: expect.closeTo(201),
      y: expect.closeTo(349.6),
      width: expect.closeTo(40.2),
      height: expect.closeTo(87.4)
    });
  });

  it("retains a spatially contained child without semantic ancestry and equivalent displacement evidence", () => {
    const card = element("card", "card", 20, 60, 150, 160);
    const unrelated = element("unrelated", "text", 40, 100, 80, 20);
    const parent = finding("parent", "pair-card", "geometry", 20, 60, 150, 160);
    parent.targetIds = [card.id];
    parent.measurements = [{ name: "vertical_shift", value: 12, unit: "px" }];
    const child = finding("independent-child", "pair-unrelated", "geometry", 40, 100, 80, 20);
    child.targetIds = [unrelated.id];
    child.measurements = [{ name: "vertical_shift", value: 3, unit: "px" }];

    const result = consolidateFindings(
      [parent, child],
      [card, unrelated],
      [pair("pair-card", card.id), pair("pair-unrelated", unrelated.id)]
    );

    expect(result.map(item => item.id).sort()).toEqual(["independent-child", "parent"]);
  });

  it("produces stable final ordering and retained suppression metadata under permutations", () => {
    const card = element("card", "card", 20, 60, 150, 160);
    const child = element("child", "text", 40, 100, 80, 20, card.id);
    card.childIds = [child.id];
    const parent = finding("parent", "pair-card", "geometry", 20, 60, 150, 160);
    parent.targetIds = [card.id];
    parent.measurements = [{ name: "vertical_shift", value: 12, unit: "px" }];
    const childFinding = finding("child", "pair-child", "geometry", 40, 100, 80, 20);
    childFinding.targetIds = [child.id];
    childFinding.measurements = [{ name: "vertical_shift", value: 12, unit: "px" }];
    const context = { canvas: { width: 200, height: 400 } };

    const forward = consolidateFindings([parent, childFinding], [card, child], [pair("pair-card", card.id), pair("pair-child", child.id)], context);
    const reversed = consolidateFindings([childFinding, parent], [child, card], [pair("pair-child", child.id), pair("pair-card", card.id)], context);

    expect(reversed).toEqual(forward);
  });

  it("projects an extra deterministic-presence finding from actual space exactly once", () => {
    const actual = element("actual-extra", "button", 200, 100, 80, 40);
    const extra = finding("extra", "pair-extra", "presence", 200, 100, 80, 40, "deterministic_presence");
    extra.reviewerStatus = "not_reviewed";
    const result = finalizeFindings(
      [extra],
      [actual],
      [{ id: "pair-extra", actualId: actual.id, status: "extra", score: 1, reasons: [] }],
      { canvas: { width: 200, height: 400 }, imagePairTransform: createImagePairTransform({ width: 200, height: 400 }, { width: 400, height: 800 }) }
    );

    expect(result.diffs[0]?.location).toEqual({ x: 100, y: 50, width: 40, height: 20 });
    expect(result.diffs[0]?.coordinateSpace).toBe("comparison_expected_normalized");
  });

  it("consolidates an overlapping ancestry child when displacement evidence is absent", () => {
    const card = element("card", "card", 20, 60, 150, 160);
    const child = element("child", "text", 40, 100, 80, 20, card.id);
    const parent = finding("parent", "pair-card", "geometry", 20, 60, 150, 160);
    parent.targetIds = [card.id];
    parent.evidence = ["same"];
    const childFinding = finding("child", "pair-child", "geometry", 40, 100, 80, 20);
    childFinding.targetIds = [child.id];
    childFinding.evidence = ["same"];
    childFinding.measurements = [{ name: "deltaX", value: 0, unit: "px" }, { name: "deltaY", value: 12, unit: "px" }];

    const result = consolidateFindings([parent, childFinding], [card, child], [pair("pair-card", card.id), pair("pair-child", child.id)]);

    expect(result).toHaveLength(1);
    expect(result[0]?.childFindingIds).toEqual(expect.arrayContaining(["child", "parent"]));
  });

  it("preserves independent child evidence while consolidating an overlapping ancestry duplicate", () => {
    const card = element("card", "card", 20, 60, 150, 160);
    const child = element("child", "text", 40, 100, 80, 20, card.id);
    const parent = finding("parent", "pair-card", "geometry", 20, 60, 150, 160);
    parent.targetIds = [card.id];
    parent.evidence = [" Shared translated evidence "];
    parent.measurements = [{ name: "deltaX", value: 0, unit: "px" }, { name: "deltaY", value: 12, unit: "px" }];
    const childFinding = finding("child", "pair-child", "geometry", 40, 100, 80, 20);
    childFinding.targetIds = [child.id];
    childFinding.evidence = ["shared translated evidence", "independent icon defect"];
    childFinding.measurements = [{ name: "horizontal_shift", value: 0, unit: "px" }, { name: "vertical_shift", value: 12, unit: "px" }];

    const result = consolidateFindings([parent, childFinding], [card, child], [pair("pair-card", card.id), pair("pair-child", child.id)]);

    expect(result).toHaveLength(1);
    expect(result[0]?.evidence).toEqual(expect.arrayContaining([
      " Shared translated evidence ",
      "shared translated evidence",
      "independent icon defect"
    ]));
    expect(result[0]?.artifactPaths).toEqual(expect.arrayContaining([
      { role: "expected_crop", path: "parent-expected.png" },
      { role: "expected_crop", path: "child-expected.png" }
    ]));
  });

  it("consolidates the real full-gate header parent and contained component duplicate", () => {
    const nav = element("nav", "nav", 0, 0, 402, 874);
    const header = element("header", "text", 16.884, 52.44, 117.786, 14.858, nav.id);
    const component = element("component", "text", 119, 56, 14, 9, header.id);
    nav.childIds = [header.id];
    header.childIds = [component.id];
    const parent = finding("header-diff", "pair-header", "geometry", 16.884, 52.44, 117.786, 14.858);
    const child = finding("component-diff", "pair-component", "geometry", 119, 56, 14, 9);
    parent.targetIds = [header.id, nav.id];
    child.targetIds = [component.id, nav.id];
    parent.evidence = ["parent geometry evidence"];
    child.evidence = ["contained component evidence"];

    const result = consolidateFindings(
      [parent, child],
      [nav, header, component],
      [pair("pair-header", header.id), pair("pair-component", component.id)]
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.location).toMatchObject({
      x: expect.closeTo(16.884),
      y: expect.closeTo(52.44),
      width: expect.closeTo(117.786),
      height: expect.closeTo(14.858)
    });
    expect(result[0]?.evidence).toEqual(expect.arrayContaining(["parent geometry evidence", "contained component evidence"]));
    expect(result[0]?.artifactPaths).toEqual(expect.arrayContaining([
      { role: "expected_crop", path: "header-diff-expected.png" },
      { role: "expected_crop", path: "component-diff-expected.png" }
    ]));
    expect(result[0]?.childFindingIds).toEqual(expect.arrayContaining(["header-diff", "component-diff"]));
    expect(result[0]?.suppression).toEqual({
      reason: "duplicate_child_of_group",
      retainedFindingIds: [expect.stringMatching(/^(header|component)-diff$/)]
    });
  });

  it("selects equal-area fallback semantic parents stably under permutations", () => {
    const left = element("a-parent", "card", 0, 0, 100, 100);
    const right = element("z-parent", "card", 0, 0, 100, 100);
    const candidate = finding("fallback", undefined, "geometry", 20, 20, 20, 20);
    const summarize = (elements: UiElement[]) => consolidateFindings([candidate], elements, []).flatMap(item => item.targetIds ?? []);
    expect(summarize([right, left])).toEqual(summarize([left, right]));
  });

  it("selects equal-priority suppression parents stably under permutations", () => {
    const card = element("card", "card", 0, 0, 160, 160);
    const child = element("child", "text", 20, 20, 40, 20, card.id);
    const parentA = finding("a-parent", "pair-card", "geometry", 0, 0, 160, 160);
    const parentZ = { ...parentA, id: "z-parent" };
    const childFinding = finding("child", "pair-child", "geometry", 20, 20, 40, 20);
    for (const item of [parentA, parentZ, childFinding]) {
      item.evidence = ["same translated evidence"];
      item.measurements = [{ name: "deltaX", value: 0, unit: "px" }, { name: "deltaY", value: 8, unit: "px" }];
    }
    parentA.targetIds = [card.id];
    parentZ.targetIds = [card.id];
    childFinding.targetIds = [child.id];
    const pairs = [pair("pair-card", card.id), pair("pair-child", child.id)];
    const select = (parents: DiffRecord[]) => selectSuppressionParent(parents, childFinding, [card, child], pairs, 160_000)?.id;

    expect(select([parentZ, parentA])).toBe("a-parent");
    expect(select([parentA, parentZ])).toBe("a-parent");
  });
});
