import crypto from "node:crypto";
import type { Box, DiffRecord, ElementPair, UiElement } from "../schemas/core.js";

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
}): DiffRecord[] {
  const diffs: DiffRecord[] = [];
  for (const pair of input.pairs) {
    const expected = input.expectedElements.find(e => e.id === pair.expectedId);
    const actual = input.actualElements.find(e => e.id === pair.actualId);
    if (pair.status === "matched" && expected && actual) {
      const dx = Math.round(actual.box.x - expected.box.x);
      const dy = Math.round(actual.box.y - expected.box.y);
      const dw = Math.round(actual.box.width - expected.box.width);
      const dh = Math.round(actual.box.height - expected.box.height);
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dw) + Math.abs(dh) >= input.minMovePx) {
        diffs.push({
          id: crypto.randomBytes(6).toString("hex"),
          pairId: pair.id,
          criterion: "geometry",
          severity: Math.abs(dx) + Math.abs(dy) >= 12 ? "high" : "medium",
          title: `${expected.label} geometry differs`,
          location: unionBox(expected.box, actual.box),
          evidence: [
            `Expected box x=${expected.box.x}, y=${expected.box.y}, w=${expected.box.width}, h=${expected.box.height}.`,
            `Actual box x=${actual.box.x}, y=${actual.box.y}, w=${actual.box.width}, h=${actual.box.height}.`,
            `Delta dx=${dx}px, dy=${dy}px, dw=${dw}px, dh=${dh}px.`
          ],
          measurements: [
            { name: "deltaX", value: dx, unit: "px" },
            { name: "deltaY", value: dy, unit: "px" },
            { name: "deltaWidth", value: dw, unit: "px" },
            { name: "deltaHeight", value: dh, unit: "px" }
          ],
          artifactPaths: [],
          reviewerStatus: "accepted",
          model: "deterministic"
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
        reviewerStatus: "accepted",
        model: "deterministic"
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
        reviewerStatus: "accepted",
        model: "deterministic"
      });
    }
  }
  return diffs;
}
