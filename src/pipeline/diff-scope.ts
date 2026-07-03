import { DiffScopeSchema, type DiffScope, type ElementPair, type UiElement, type Box } from "../schemas/core.js";

export interface ScopeFilterSummary {
  scopeKind: DiffScope["kind"];
  totalPairs: number;
  selectedPairs: number;
  skippedByScope: number;
  targetQuery?: string;
  targetMatchedPairIds?: string[];
}

export interface ScopeFilterResult {
  pairs: ElementPair[];
  summary: ScopeFilterSummary;
  warning?: string;
}

export interface ScopedComponent {
  id: string;
  box: Box;
  pixelCount: number;
}

export interface ComponentScopeFilterResult {
  components: ScopedComponent[];
  skippedOutsideScope: number;
}

export function normalizeDiffScope(scope: DiffScope | undefined): DiffScope {
  return DiffScopeSchema.parse(scope);
}

function center(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function regionBoxes(width: number, height: number): Record<string, Box> {
  return {
    top: { x: 0, y: 0, width, height: height / 3 },
    middle: { x: 0, y: height / 3, width, height: height / 3 },
    bottom: { x: 0, y: (height * 2) / 3, width, height: height / 3 },
    header: { x: 0, y: 0, width, height: height * 0.18 },
    nav: { x: 0, y: height * 0.84, width, height: height * 0.16 },
    content: { x: 0, y: height * 0.18, width, height: height * 0.66 }
  };
}

function boxContainsPoint(box: Box, point: { x: number; y: number }): boolean {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
}

function elementForPair(pair: ElementPair, expectedElements: UiElement[], actualElements: UiElement[]): UiElement | undefined {
  return expectedElements.find(element => element.id === pair.expectedId)
    ?? actualElements.find(element => element.id === pair.actualId);
}

function targetScore(query: string, element: UiElement | undefined): number {
  if (!element) return 0;
  const q = query.trim().toLowerCase();
  const fields = [element.label, element.text, element.type].filter((value): value is string => value !== undefined)
    .map(value => value.toLowerCase());
  let score = 0;
  for (const field of fields) {
    if (field === q) score = Math.max(score, 1);
    else if (field.includes(q)) score = Math.max(score, 0.8);
    else {
      const qTokens = q.split(/\s+/).filter(Boolean);
      const matched = qTokens.filter(token => field.includes(token)).length;
      if (qTokens.length > 0) score = Math.max(score, matched / qTokens.length * 0.65);
    }
  }
  return score;
}

export function filterPairsForScope(
  scope: DiffScope,
  pairs: ElementPair[],
  expectedElements: UiElement[],
  actualElements: UiElement[],
  imageSize: { width: number; height: number }
): ScopeFilterResult {
  if (scope.kind === "full") {
    return {
      pairs,
      summary: { scopeKind: "full", totalPairs: pairs.length, selectedPairs: pairs.length, skippedByScope: 0 }
    };
  }

  if (scope.kind === "screen") {
    return {
      pairs: [],
      summary: { scopeKind: "screen", totalPairs: pairs.length, selectedPairs: 0, skippedByScope: pairs.length }
    };
  }

  if (scope.kind === "regions") {
    const boxes = regionBoxes(imageSize.width, imageSize.height);
    const selectedNames = scope.regions ?? ["top", "middle", "bottom", "nav"];
    const selectedBoxes = selectedNames.map(name => boxes[name]).filter((box): box is Box => box !== undefined);
    const selectedPairs = pairs.filter(pair => {
      const element = elementForPair(pair, expectedElements, actualElements);
      return element !== undefined && selectedBoxes.some(box => boxContainsPoint(box, center(element.box)));
    });
    return {
      pairs: selectedPairs,
      summary: {
        scopeKind: "regions",
        totalPairs: pairs.length,
        selectedPairs: selectedPairs.length,
        skippedByScope: pairs.length - selectedPairs.length
      }
    };
  }

  const scored = pairs
    .map(pair => ({ pair, score: targetScore(scope.query, elementForPair(pair, expectedElements, actualElements)) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const bestScore = scored[0]?.score ?? 0;
  const selectedPairs = scored.filter(entry => entry.score === bestScore).map(entry => entry.pair);
  const summary: ScopeFilterSummary = {
    scopeKind: "target",
    totalPairs: pairs.length,
    selectedPairs: selectedPairs.length,
    skippedByScope: pairs.length - selectedPairs.length,
    targetQuery: scope.query,
    targetMatchedPairIds: selectedPairs.map(pair => pair.id)
  };
  if (selectedPairs.length === 0) {
    return {
      pairs: [],
      summary,
      warning: `Target query "${scope.query}" could not be resolved by the locator.`
    };
  }
  return { pairs: selectedPairs, summary };
}

export function filterComponentsForScope(
  scope: DiffScope,
  components: ScopedComponent[],
  imageSize: { width: number; height: number }
): ComponentScopeFilterResult {
  if (scope.kind === "screen") {
    return { components: [], skippedOutsideScope: components.length };
  }
  if (scope.kind !== "regions") {
    return { components, skippedOutsideScope: 0 };
  }

  const boxes = regionBoxes(imageSize.width, imageSize.height);
  const selectedNames = scope.regions ?? ["top", "middle", "bottom", "nav"];
  const selectedBoxes = selectedNames.map(name => boxes[name]).filter((box): box is Box => box !== undefined);
  const selected = components.filter(component => selectedBoxes.some(box => boxContainsPoint(box, center(component.box))));
  return { components: selected, skippedOutsideScope: components.length - selected.length };
}
