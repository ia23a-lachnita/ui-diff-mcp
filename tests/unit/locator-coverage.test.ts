import { describe, expect, it } from "vitest";
import type { UiElement } from "../../src/schemas/core.js";
import { computeImageLocatorCoverage, isUsefulLocatorBox } from "../../src/locator/coverage.js";

function el(id: string, queryId: string, x: number, y: number, width: number, height: number): UiElement {
  return {
    id,
    label: id,
    type: "unknown",
    queryId,
    box: { x, y, width, height },
    normalizedBox: { x: x / 1000, y: y / 2000, width: width / 1000, height: height / 2000 },
    confidence: 0.9,
    source: "locator",
    childIds: []
  };
}

describe("computeImageLocatorCoverage", () => {
  it("marks coverage complete only when enough query ids have useful hits", () => {
    const result = computeImageLocatorCoverage({
      elements: [
        el("text", "text_labels", 10, 10, 100, 30),
        el("button", "buttons", 20, 100, 100, 50),
        el("icon", "icons", 40, 190, 40, 40),
        el("card", "cards_panels_containers", 0, 300, 400, 200),
        el("nav", "tab_bar_nav_elements", 0, 1800, 1000, 150),
        el("chart", "charts_indicators", 200, 600, 300, 300)
      ],
      promptCount: 8,
      imageSize: { width: 1000, height: 2000 },
      minQueryCoverageRatio: 0.75,
      minElementCount: 12
    });

    expect(result.status).toBe("weak");
    expect(result.reasons).toContain("element_count_below_minimum");
  });

  it("rejects a single full-screen box as useful coverage", () => {
    const box = el("giant", "text_labels", 0, 0, 1000, 2000);
    expect(isUsefulLocatorBox(box, { width: 1000, height: 2000 })).toBe(false);
  });
});
