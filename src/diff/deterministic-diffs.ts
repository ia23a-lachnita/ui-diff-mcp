import crypto from "node:crypto";
import type { Box, DiffRecord, ElementPair, UiElement } from "../schemas/core.js";
import { type ImagePairTransform, projectActualBoxToExpectedSource } from "../images/coordinates.js";

export function unionBox(a: Box, b: Box): Box {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function buildDeterministicDiffs(input: {
  pairs: ElementPair[];
  expectedElements: UiElement[];
  actualElements: UiElement[];
  minMovePx: number;
  transform?: ImagePairTransform;
}): DiffRecord[] {
  const diffs: DiffRecord[] = [];
  for (const pair of input.pairs) {
    const expected = input.expectedElements.find(e => e.id === pair.expectedId);
    const actual = input.actualElements.find(e => e.id === pair.actualId);
    if (pair.status === "matched" && expected && actual) {
      // Normalize actual.box to expected coordinate space before computing deltas.
      // actual.box may be in native actual-image pixels; expected.box is always in expected-image pixels.
      const actualBoxNorm = input.transform
        ? projectActualBoxToExpectedSource(actual.box, input.transform)
        : actual.box;
      const dx = Math.round(actualBoxNorm.x - expected.box.x);
      const dy = Math.round(actualBoxNorm.y - expected.box.y);
      const dw = Math.round(actualBoxNorm.width - expected.box.width);
      const dh = Math.round(actualBoxNorm.height - expected.box.height);
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dw) + Math.abs(dh) >= input.minMovePx) {
        diffs.push({
          id: crypto.randomBytes(6).toString("hex"),
          pairId: pair.id,
          criterion: "geometry",
          severity: Math.abs(dx) + Math.abs(dy) >= 12 ? "high" : "medium",
          title: `${expected.label} geometry differs`,
          // Both boxes in expected-image coordinate space so the union covers the right region.
          location: unionBox(expected.box, actualBoxNorm),
          evidence: [
            `Expected box (expected-space) x=${expected.box.x}, y=${expected.box.y}, w=${expected.box.width}, h=${expected.box.height}.`,
            `Actual box (expected-space, normalized) x=${Math.round(actualBoxNorm.x)}, y=${Math.round(actualBoxNorm.y)}, w=${Math.round(actualBoxNorm.width)}, h=${Math.round(actualBoxNorm.height)}.`,
            `Delta dx=${dx}px, dy=${dy}px, dw=${dw}px, dh=${dh}px.`
          ],
          measurements: [
            { name: "deltaX", value: dx, unit: "px" },
            { name: "deltaY", value: dy, unit: "px" },
            { name: "deltaWidth", value: dw, unit: "px" },
            { name: "deltaHeight", value: dh, unit: "px" }
          ],
          artifactPaths: [],
          reviewerStatus: "not_reviewed",
          model: "deterministic",
          classificationSource: "deterministic_geometry"
        });
      }
    }
    if (pair.status === "missing" && expected) {
      diffs.push({
        id: crypto.randomBytes(6).toString("hex"),
        pairId: pair.id,
        criterion: "presence",
        severity: "high",
        title: `${expected.label} missing in actual screenshot`,
        location: expected.box,
        evidence: [`Expected element exists at x=${expected.box.x}, y=${expected.box.y}, w=${expected.box.width}, h=${expected.box.height}; no actual element was paired.`],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "not_reviewed",
        model: "deterministic",
        classificationSource: "deterministic_presence"
      });
    }
    if (pair.status === "extra" && actual) {
      diffs.push({
        id: crypto.randomBytes(6).toString("hex"),
        pairId: pair.id,
        criterion: "presence",
        severity: "medium",
        title: `${actual.label} extra in actual screenshot`,
        location: actual.box,
        evidence: [`Actual element exists at x=${actual.box.x}, y=${actual.box.y}, w=${actual.box.width}, h=${actual.box.height}; no expected element was paired.`],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "not_reviewed",
        model: "deterministic",
        classificationSource: "deterministic_presence"
      });
    }
  }
  return diffs;
}
