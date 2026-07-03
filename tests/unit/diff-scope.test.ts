import { describe, expect, it } from "vitest";
import { filterComponentsForScope, filterPairsForScope, normalizeDiffScope } from "../../src/pipeline/diff-scope.js";
import type { ElementPair, UiElement } from "../../src/schemas/core.js";

const elements: UiElement[] = [
  {
    id: "hero",
    label: "Calories ring",
    type: "chart",
    box: { x: 20, y: 120, width: 200, height: 200 },
    normalizedBox: { x: 0.05, y: 0.15, width: 0.55, height: 0.25 },
    confidence: 0.9,
    source: "locator",
    childIds: []
  },
  {
    id: "nav-scan",
    label: "Scan button",
    type: "button",
    box: { x: 150, y: 730, width: 60, height: 60 },
    normalizedBox: { x: 0.4, y: 0.91, width: 0.16, height: 0.07 },
    text: "Scan",
    confidence: 0.9,
    source: "locator",
    childIds: []
  }
];

const pairs: ElementPair[] = [
  { id: "pair-hero", expectedId: "hero", actualId: "hero", status: "matched", score: 0.9, reasons: [] },
  { id: "pair-nav", expectedId: "nav-scan", actualId: "nav-scan", status: "matched", score: 0.9, reasons: [] }
];

describe("diff scope filtering", () => {
  it("defaults missing scope to full", () => {
    expect(normalizeDiffScope(undefined)).toEqual({ kind: "full" });
  });

  it("screen scope selects no target pairs", () => {
    const result = filterPairsForScope({ kind: "screen" }, pairs, elements, elements, { width: 360, height: 800 });
    expect(result.pairs).toEqual([]);
    expect(result.summary.skippedByScope).toBe(2);
  });

  it("region scope selects only pairs whose center is in the selected region", () => {
    const result = filterPairsForScope({ kind: "regions", regions: ["nav"] }, pairs, elements, elements, { width: 360, height: 800 });
    expect(result.pairs.map(pair => pair.id)).toEqual(["pair-nav"]);
    expect(result.summary.selectedPairs).toBe(1);
  });

  it("target scope selects the best label or text match and warns when unresolved", () => {
    const scan = filterPairsForScope({ kind: "target", query: "scan" }, pairs, elements, elements, { width: 360, height: 800 });
    expect(scan.pairs.map(pair => pair.id)).toEqual(["pair-nav"]);
    expect(scan.summary.targetQuery).toBe("scan");

    const missing = filterPairsForScope({ kind: "target", query: "settings" }, pairs, elements, elements, { width: 360, height: 800 });
    expect(missing.pairs).toEqual([]);
    expect(missing.warning).toContain("Target query \"settings\" could not be resolved");
  });

  it("region scope restricts recovery components to selected regions", () => {
    const result = filterComponentsForScope(
      { kind: "regions", regions: ["nav"] },
      [
        { id: "hero-component", box: { x: 20, y: 150, width: 50, height: 50 }, pixelCount: 100 },
        { id: "nav-component", box: { x: 150, y: 730, width: 50, height: 50 }, pixelCount: 100 }
      ],
      { width: 360, height: 800 }
    );

    expect(result.components.map(component => component.id)).toEqual(["nav-component"]);
    expect(result.skippedOutsideScope).toBe(1);
  });
});
