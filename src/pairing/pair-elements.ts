import crypto from "node:crypto";
import type { UiElement, ElementPair, PairingStatus } from "../schemas/core.js";
import { iou } from "../signals/geometry.js";

function geometryScore(a: UiElement, b: UiElement): number {
  return iou(a.box, b.box);
}

function textScore(a: UiElement, b: UiElement): number {
  const ta = a.text?.trim().toLowerCase() ?? "";
  const tb = b.text?.trim().toLowerCase() ?? "";
  if (!ta && !tb) return 0.5;
  if (!ta || !tb) return 0;
  if (ta === tb) return 1;
  const longer = Math.max(ta.length, tb.length);
  let matches = 0;
  for (let i = 0; i < Math.min(ta.length, tb.length); i++) {
    if (ta[i] === tb[i]) matches++;
  }
  return matches / longer;
}

function typeScore(a: UiElement, b: UiElement): number {
  return a.type === b.type ? 1 : 0;
}

function hierarchyScore(a: UiElement, b: UiElement): number {
  if (a.parentId !== undefined && a.parentId === b.parentId) return 1;
  if (a.parentId === undefined && b.parentId === undefined) return 0.5;
  return 0;
}

function pairScore(expected: UiElement, actual: UiElement): number {
  return (
    0.45 * geometryScore(expected, actual) +
    0.25 * textScore(expected, actual) +
    0.20 * typeScore(expected, actual) +
    0.10 * hierarchyScore(expected, actual)
  );
}

function makePairId(expectedId?: string, actualId?: string): string {
  const raw = `${expectedId ?? ""}:${actualId ?? ""}`;
  return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
}

export function pairElements(
  expectedElements: UiElement[],
  actualElements: UiElement[]
): ElementPair[] {
  const pairs: ElementPair[] = [];
  const matchedActual = new Set<string>();
  const matchedExpected = new Set<string>();

  const scored: Array<{ expectedIdx: number; actualIdx: number; score: number }> = [];

  for (let ei = 0; ei < expectedElements.length; ei++) {
    const exp = expectedElements[ei];
    if (!exp) continue;
    for (let ai = 0; ai < actualElements.length; ai++) {
      const act = actualElements[ai];
      if (!act) continue;
      const score = pairScore(exp, act);
      scored.push({ expectedIdx: ei, actualIdx: ai, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  for (const { expectedIdx, actualIdx, score } of scored) {
    const exp = expectedElements[expectedIdx];
    const act = actualElements[actualIdx];
    if (!exp || !act) continue;
    if (matchedExpected.has(exp.id) || matchedActual.has(act.id)) continue;

    let status: PairingStatus;
    if (score >= 0.62) {
      status = "matched";
    } else if (score >= 0.45) {
      status = "uncertain";
    } else {
      continue;
    }

    matchedExpected.add(exp.id);
    matchedActual.add(act.id);

    const reasons: string[] = [];
    reasons.push(`geometry=${geometryScore(exp, act).toFixed(2)}`);
    reasons.push(`text=${textScore(exp, act).toFixed(2)}`);
    reasons.push(`type=${typeScore(exp, act).toFixed(2)}`);

    pairs.push({
      id: makePairId(exp.id, act.id),
      expectedId: exp.id,
      actualId: act.id,
      status,
      score,
      reasons
    });
  }

  for (const exp of expectedElements) {
    if (!matchedExpected.has(exp.id)) {
      pairs.push({
        id: makePairId(exp.id, undefined),
        expectedId: exp.id,
        status: "missing",
        score: 0,
        reasons: ["no matching actual element found"]
      });
    }
  }

  for (const act of actualElements) {
    if (!matchedActual.has(act.id)) {
      pairs.push({
        id: makePairId(undefined, act.id),
        actualId: act.id,
        status: "extra",
        score: 0,
        reasons: ["no matching expected element found"]
      });
    }
  }

  return pairs;
}
