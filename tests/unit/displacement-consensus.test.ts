import { describe, expect, it } from "vitest";
import {
  resolveDisplacementConsensus,
  resolveStructuralMismatchGroups,
  type DisplacementEvidence
} from "../../src/diff/displacement-consensus.js";
import type { UiElement } from "../../src/schemas/core.js";

function element(id: string, x: number, y: number, parentId?: string, label = `cv-component-${id}`): UiElement {
  return {
    id,
    label,
    type: "text",
    box: { x, y, width: 24, height: 24 },
    normalizedBox: { x: x / 1000, y: y / 2000, width: 0.024, height: 0.012 },
    confidence: 0.9,
    source: parentId ? "locator" : "merged",
    ...(parentId ? { parentId } : {}),
    childIds: []
  };
}

function evidence(pairId: string, expectedId: string, y: number, candidates: Array<{ dx: number; dy: number; score?: number; margin?: number }>): DisplacementEvidence {
  return {
    pairId,
    expectedId,
    projectedActualId: `proj-${expectedId}`,
    projectedBox: { x: 100, y, width: 24, height: 24 },
    candidates: candidates.map(candidate => ({
      dx: candidate.dx,
      dy: candidate.dy,
      score: candidate.score ?? 0.9,
      edgeOverlap: 0.85,
      colorAgreement: 0.8,
      improvement: 0.3,
      runnerUpMargin: candidate.margin ?? 0.02
    }))
  };
}

describe("resolveDisplacementConsensus", () => {
  it("groups six nutrition fragments that share a large translation", () => {
    const parent = element("nutrition-parent", 0, 500, undefined, "cv-component-0");
    const children = Array.from({ length: 6 }, (_, index) => element(`n-${index}`, 100, 600 + index * 120, parent.id));
    parent.childIds = children.map(child => child.id);
    const result = resolveDisplacementConsensus({
      evidence: children.map((child, index) => evidence(`pair-${index}`, child.id, child.box.y, [
        { dx: 4, dy: 146 + (index % 2), score: 0.91 },
        { dx: 4, dy: 310, score: 0.72 }
      ])),
      expectedElements: [parent, ...children],
      viewportWidth: 1000
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.pairIds).toHaveLength(6);
    expect(result.groups[0]?.boundaryElementId).toBe(parent.id);
    expect(result.groups[0]?.dy).toBeGreaterThanOrEqual(146);
    expect(result.groups[0]?.label).toBe("UI region");
  });

  it("keeps two coherent sections under the same generic parent separate by translation", () => {
    const parent = element("screen-parent", 0, 0);
    const children = [
      element("a-1", 100, 100, parent.id), element("a-2", 100, 150, parent.id),
      element("b-1", 100, 700, parent.id), element("b-2", 100, 750, parent.id)
    ];
    parent.childIds = children.map(child => child.id);
    const result = resolveDisplacementConsensus({
      evidence: [
        evidence("pa1", "a-1", 100, [{ dx: 0, dy: 90 }]),
        evidence("pa2", "a-2", 150, [{ dx: 1, dy: 92 }]),
        evidence("pb1", "b-1", 700, [{ dx: 0, dy: -130 }]),
        evidence("pb2", "b-2", 750, [{ dx: -1, dy: -128 }])
      ],
      expectedElements: [parent, ...children],
      viewportWidth: 1000
    });

    expect(result.groups).toHaveLength(2);
    expect(result.groups.map(group => Math.sign(group.dy)).sort()).toEqual([-1, 1]);
  });

  it("rejects tied repeated-target consensus", () => {
    const children = [element("dot-1", 100, 100), element("dot-2", 100, 200)];
    const result = resolveDisplacementConsensus({
      evidence: [
        evidence("p1", "dot-1", 100, [{ dx: 0, dy: 80, score: 0.9 }, { dx: 0, dy: 180, score: 0.9 }]),
        evidence("p2", "dot-2", 200, [{ dx: 0, dy: 80, score: 0.9 }, { dx: 0, dy: 180, score: 0.9 }])
      ],
      expectedElements: children,
      viewportWidth: 1000
    });

    expect(result.groups).toHaveLength(0);
    expect(result.individuals.size).toBe(0);
  });

  it("returns a uniquely strong single target as an individual", () => {
    const child = element("unique", 100, 100, undefined, "Submit");
    const result = resolveDisplacementConsensus({
      evidence: [evidence("p-unique", child.id, 100, [{ dx: 12, dy: 140, margin: 0.2 }])],
      expectedElements: [child],
      viewportWidth: 1000
    });

    expect(result.groups).toHaveLength(0);
    expect(result.individuals.get("p-unique")).toMatchObject({ dx: 12, dy: 140 });
  });

  it("uses cleaned element labels instead of raw locator text for group labels", () => {
    const parent = element("macro-card", 0, 100, undefined, "Hero macro card");
    const children = [
      element("protein", 100, 200, parent.id, "Protein row"),
      element("carbs", 100, 260, parent.id, "Carbs row")
    ];
    children[0]!.text = "<ref>tab bar bar and navigation elements</ref><box><0><0><1000><1000></box>";
    children[1]!.text = "<ref>raw malformed grounding</ref><box><0><0><1000><1000></box>";
    parent.childIds = children.map(child => child.id);

    const result = resolveDisplacementConsensus({
      evidence: [
        evidence("protein-pair", children[0]!.id, children[0]!.box.y, [{ dx: 0, dy: 80 }]),
        evidence("carbs-pair", children[1]!.id, children[1]!.box.y, [{ dx: 1, dy: 82 }])
      ],
      expectedElements: [parent, ...children],
      viewportWidth: 1000
    });

    expect(result.groups[0]?.label).toMatch(/^(Protein|Carbs) row$/);
    expect(result.groups[0]?.label).not.toContain("<ref>");
  });

  it("does not assign two targets to the same translated feature", () => {
    const children = [element("one", 100, 100), element("two", 102, 102)];
    const result = resolveDisplacementConsensus({
      evidence: [
        evidence("p-one", "one", 100, [{ dx: 0, dy: 100 }]),
        evidence("p-two", "two", 102, [{ dx: -2, dy: 98 }])
      ],
      expectedElements: children,
      viewportWidth: 1000
    });

    expect(result.groups).toHaveLength(0);
  });
});

describe("resolveStructuralMismatchGroups", () => {
  it("groups independently proven mismatches inside one bounded generic region", () => {
    const parent = element("nutrition-parent", 0, 300, undefined, "cv-component-0");
    parent.box = { x: 20, y: 300, width: 900, height: 1200 };
    const children = Array.from({ length: 6 }, (_, index) => element(`nutrition-${index}`, 100, 700 + index * 100, parent.id));
    parent.childIds = children.map(child => child.id);

    const groups = resolveStructuralMismatchGroups({
      evidence: children.map((child, index) => evidence(`nutrition-pair-${index}`, child.id, 650 + index * 90, [])),
      expectedElements: [parent, ...children],
      viewportWidth: 1000,
      viewportHeight: 2000
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.pairIds).toHaveLength(6);
    expect(groups[0]?.boundaryElementId).toBe(parent.id);
    expect(groups[0]?.kind).toBe("structural_region_mismatch");
  });

  it("splits spatially remote mismatch clusters under a screen-sized wrapper", () => {
    const parent = element("screen", 0, 0);
    parent.box = { x: 0, y: 0, width: 1000, height: 2000 };
    const children = [
      element("top-a", 50, 100, parent.id), element("top-b", 80, 140, parent.id),
      element("bottom-a", 50, 1500, parent.id), element("bottom-b", 80, 1540, parent.id)
    ];
    parent.childIds = children.map(child => child.id);
    const groups = resolveStructuralMismatchGroups({
      evidence: [
        evidence("top-pair-a", "top-a", 100, []), evidence("top-pair-b", "top-b", 140, []),
        evidence("bottom-pair-a", "bottom-a", 1500, []), evidence("bottom-pair-b", "bottom-b", 1540, [])
      ],
      expectedElements: [parent, ...children],
      viewportWidth: 1000,
      viewportHeight: 2000
    });

    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.pairIds.length)).toEqual([2, 2]);
  });

  it("connects same-row mismatches across a bounded region", () => {
    const parent = element("nutrition-parent", 0, 900, undefined, "cv-component-0");
    parent.box = { x: 20, y: 900, width: 920, height: 700 };
    const left = element("nutrition-left", 123, 1481, parent.id);
    const right = element("nutrition-right", 890, 1481, parent.id);
    parent.childIds = [left.id, right.id];
    const leftEvidence = evidence("left-pair", left.id, 1481, []);
    const rightEvidence = evidence("right-pair", right.id, 1481, []);
    leftEvidence.projectedBox = { x: 123, y: 1481, width: 25, height: 25 };
    rightEvidence.projectedBox = { x: 890, y: 1481, width: 51, height: 25 };

    const groups = resolveStructuralMismatchGroups({
      evidence: [leftEvidence, rightEvidence],
      expectedElements: [parent, left, right],
      viewportWidth: 1000,
      viewportHeight: 2000
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.pairIds).toEqual(["left-pair", "right-pair"]);
  });

  it("does not create a structural group from one mismatch", () => {
    const parent = element("parent", 0, 0);
    const child = element("child", 20, 20, parent.id);
    expect(resolveStructuralMismatchGroups({
      evidence: [evidence("single", child.id, 20, [])],
      expectedElements: [parent, child],
      viewportWidth: 1000,
      viewportHeight: 2000
    })).toHaveLength(0);
  });
});
