import { expect } from "vitest";
import type { UiDiffReport } from "../../src/schemas/core.js";

// Matches src/report/finding-consolidation.ts MAX_REPAIR_PARENT_AREA_RATIO / isOversizedRepairParent.
const MAX_REPAIR_PARENT_AREA_RATIO = 0.3;

function isOversizedAncestor(normalizedBox: { width: number; height: number }): boolean {
  return normalizedBox.width * normalizedBox.height >= MAX_REPAIR_PARENT_AREA_RATIO;
}

export function assertNoSplitDisplacementConsensus(report: UiDiffReport): void {
  const elementMap = new Map(report.elements.expected.map(element => [element.id, element]));
  const ancestors = (diff: UiDiffReport["diffs"][number]): Set<string> => {
    const result = new Set<string>();
    for (const targetId of diff.targetIds ?? []) {
      let element = elementMap.get(targetId);
      const visited = new Set<string>();
      while (element && !visited.has(element.id)) {
        visited.add(element.id);
        if (!isOversizedAncestor(element.normalizedBox)) {
          result.add(element.id);
        }
        element = element.parentId ? elementMap.get(element.parentId) : undefined;
      }
    }
    return result;
  };
  const shifted = report.diffs.flatMap(diff => {
    const dx = diff.measurements.find(measurement => measurement.name === "horizontal_shift")?.value;
    const dy = diff.measurements.find(measurement => measurement.name === "vertical_shift")?.value;
    return typeof dx === "number" && typeof dy === "number" ? [{ diff, dx, dy, ancestors: ancestors(diff) }] : [];
  });
  const width = report.comparisonSpace?.width ?? report.imageNormalization?.actual.source.width ?? 1000;
  const tolerance = Math.max(8, width * 0.015);
  for (let leftIndex = 0; leftIndex < shifted.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < shifted.length; rightIndex++) {
      const left = shifted[leftIndex]!;
      const right = shifted[rightIndex]!;
      const sharedAncestor = [...left.ancestors].some(id => right.ancestors.has(id));
      const sameVector = Math.hypot(left.dx - right.dx, left.dy - right.dy) <= tolerance;
      expect(sharedAncestor && sameVector,
        `same-vector findings ${left.diff.id} and ${right.diff.id} share an ancestor but were not consolidated`).toBe(false);
    }
  }
}
