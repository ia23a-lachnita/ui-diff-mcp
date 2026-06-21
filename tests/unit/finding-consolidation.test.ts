import { describe, expect, it } from "vitest";
import { consolidateFindings } from "../../src/report/finding-consolidation.js";
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

    expect(result).toHaveLength(1);
    expect(result[0]?.childFindingIds).toHaveLength(5);
    expect(result[0]?.targetIds).toContain("chart");
    expect(result[0]?.artifactPaths).toHaveLength(5);
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
});
