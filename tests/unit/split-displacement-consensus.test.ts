import { describe, expect, it } from "vitest";
import { assertNoSplitDisplacementConsensus } from "../helpers/split-displacement-consensus.js";
import type { DiffRecord, UiDiffReport, UiElement } from "../../src/schemas/core.js";

const VIEWPORT_WIDTH = 1000;
const VIEWPORT_HEIGHT = 2000;

function element(
  id: string,
  box: { x: number; y: number; width: number; height: number },
  parentId?: string
): UiElement {
  return {
    id,
    label: id,
    type: "text",
    box,
    normalizedBox: {
      x: box.x / VIEWPORT_WIDTH,
      y: box.y / VIEWPORT_HEIGHT,
      width: box.width / VIEWPORT_WIDTH,
      height: box.height / VIEWPORT_HEIGHT
    },
    confidence: 0.9,
    source: "locator",
    ...(parentId ? { parentId } : {}),
    childIds: []
  };
}

function shiftDiff(id: string, targetId: string, dx: number, dy: number): DiffRecord {
  return {
    id,
    criterion: "geometry",
    severity: "medium",
    title: `shift-${id}`,
    location: { x: 0, y: 0, width: 10, height: 10 },
    evidence: ["shift"],
    measurements: [
      { name: "horizontal_shift", value: dx },
      { name: "vertical_shift", value: dy }
    ],
    artifactPaths: [],
    childFindingIds: [],
    targetIds: [targetId],
    reviewerStatus: "not_reviewed",
    classificationSource: "deterministic_projected_mismatch"
  };
}

function makeReport(elements: UiElement[], diffs: DiffRecord[]): UiDiffReport {
  return {
    schemaVersion: "0.1",
    runId: "run-test-split-displacement",
    createdAt: new Date().toISOString(),
    status: "incomplete",
    visualClassificationStatus: "incomplete",
    locatorCoverageStatus: "not_run",
    expectedImagePath: "expected.png",
    actualImagePath: "actual.png",
    artifactRoot: "/tmp/split-displacement-consensus-test",
    elements: { expected: elements, actual: [] },
    pairs: [],
    diffs,
    broadEvidence: [],
    unresolvedRegions: [],
    modelHealth: [],
    runArtifacts: [],
    warnings: [],
    stages: [],
    comparisonSpace: {
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      actualResizeMode: "contain",
      sourceCropsPreserveOriginalPixels: true
    }
  };
}

describe("assertNoSplitDisplacementConsensus", () => {
  it("does not flag same-vector findings whose only common ancestor is a full-screen root", () => {
    const root = element("full-screen-root", { x: 0, y: 0, width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });
    const childA = element("child-a", { x: 100, y: 100, width: 50, height: 50 }, root.id);
    const childB = element("child-b", { x: 100, y: 1500, width: 50, height: 50 }, root.id);
    const report = makeReport(
      [root, childA, childB],
      [shiftDiff("diff-a", childA.id, 4, 140), shiftDiff("diff-b", childB.id, 5, 142)]
    );

    expect(() => assertNoSplitDisplacementConsensus(report)).not.toThrow();
  });

  it("still flags same-vector findings under a local shared ancestor below 30 percent area", () => {
    const localRoot = element("local-ancestor", { x: 0, y: 0, width: 400, height: 400 });
    const childA = element("local-child-a", { x: 50, y: 50, width: 20, height: 20 }, localRoot.id);
    const childB = element("local-child-b", { x: 50, y: 300, width: 20, height: 20 }, localRoot.id);
    const report = makeReport(
      [localRoot, childA, childB],
      [shiftDiff("diff-c", childA.id, 3, 90), shiftDiff("diff-d", childB.id, 4, 92)]
    );

    expect(() => assertNoSplitDisplacementConsensus(report)).toThrow();
  });
});
