import crypto from "node:crypto";
import type { Box, UiElement } from "../schemas/core.js";
import { intersect } from "../signals/geometry.js";
import { isUniqueDisplacementCandidate, type DisplacementCandidate } from "./displacement-search.js";

export interface DisplacementEvidence {
  pairId: string;
  expectedId: string;
  projectedActualId: string;
  projectedBox: Box;
  candidates: DisplacementCandidate[];
}

export interface DisplacementGroup {
  id: string;
  pairIds: string[];
  boundaryElementId?: string;
  label: string;
  dx: number;
  dy: number;
  confidence: number;
}

export interface DisplacementConsensusResult {
  groups: DisplacementGroup[];
  individuals: Map<string, DisplacementCandidate>;
}

export interface StructuralMismatchGroup {
  id: string;
  kind: "structural_region_mismatch";
  pairIds: string[];
  boundaryElementId: string;
  label: string;
}

interface CandidateEntry {
  evidence: DisplacementEvidence;
  candidate: DisplacementCandidate;
}

interface CandidateCluster {
  entries: CandidateEntry[];
  dx: number;
  dy: number;
}

function boxArea(box: Box): number {
  return box.width * box.height;
}

function stronglyCollides(a: Box, b: Box): boolean {
  const overlap = intersect(a, b);
  return overlap !== null && boxArea(overlap) / Math.min(boxArea(a), boxArea(b)) >= 0.7;
}

function translatedBox(entry: CandidateEntry): Box {
  return {
    ...entry.evidence.projectedBox,
    x: entry.evidence.projectedBox.x + entry.candidate.dx,
    y: entry.evidence.projectedBox.y + entry.candidate.dy
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : sorted[middle] ?? 0;
}

function stableGreedyAssignment(entries: CandidateEntry[]): CandidateEntry[] {
  const assigned: CandidateEntry[] = [];
  const usedPairs = new Set<string>();
  const translated: Box[] = [];
  for (const entry of [...entries].sort((a, b) => b.candidate.score - a.candidate.score || a.evidence.pairId.localeCompare(b.evidence.pairId))) {
    if (usedPairs.has(entry.evidence.pairId)) continue;
    const box = translatedBox(entry);
    if (translated.some(existing => stronglyCollides(existing, box))) continue;
    usedPairs.add(entry.evidence.pairId);
    translated.push(box);
    assigned.push(entry);
  }
  return assigned;
}

function clusterCandidates(evidence: DisplacementEvidence[], tolerance: number): CandidateCluster[] {
  const clusters: CandidateCluster[] = [];
  const entries = evidence.flatMap(item => item.candidates.map(candidate => ({ evidence: item, candidate })))
    .sort((a, b) => b.candidate.score - a.candidate.score || a.evidence.pairId.localeCompare(b.evidence.pairId));
  for (const entry of entries) {
    const cluster = clusters.find(candidate => Math.hypot(candidate.dx - entry.candidate.dx, candidate.dy - entry.candidate.dy) <= tolerance);
    if (cluster) {
      cluster.entries.push(entry);
      cluster.dx = median(cluster.entries.map(item => item.candidate.dx));
      cluster.dy = median(cluster.entries.map(item => item.candidate.dy));
    } else {
      clusters.push({ entries: [entry], dx: entry.candidate.dx, dy: entry.candidate.dy });
    }
  }
  return clusters;
}

function ancestorChain(element: UiElement | undefined, elements: Map<string, UiElement>): UiElement[] {
  const chain: UiElement[] = [];
  const visited = new Set<string>();
  let current = element;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.push(current);
    current = current.parentId ? elements.get(current.parentId) : undefined;
  }
  return chain;
}

function commonAncestor(ids: string[], elements: Map<string, UiElement>): UiElement | undefined {
  const chains = ids.map(id => ancestorChain(elements.get(id), elements));
  if (chains.length === 0) return undefined;
  return chains[0]?.find(candidate => chains.slice(1).every(chain => chain.some(element => element.id === candidate.id)));
}

function nearestBoundary(expectedId: string, elements: Map<string, UiElement>): UiElement | undefined {
  return ancestorChain(elements.get(expectedId), elements).slice(1)[0];
}

function boxGap(a: Box, b: Box): number {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  return Math.hypot(dx, dy);
}

function axisGap(aStart: number, aSize: number, bStart: number, bSize: number): number {
  return Math.max(0, Math.max(aStart, bStart) - Math.min(aStart + aSize, bStart + bSize));
}

function structurallyAdjacent(a: Box, b: Box, boundary: Box, maxGap: number): boolean {
  if (boxGap(a, b) <= maxGap) return true;
  const verticalGap = axisGap(a.y, a.height, b.y, b.height);
  const centerDelta = Math.abs((a.y + a.height / 2) - (b.y + b.height / 2));
  const sharesRow = verticalGap === 0 || centerDelta <= Math.max(8, Math.min(a.height, b.height));
  const horizontalGap = axisGap(a.x, a.width, b.x, b.width);
  return sharesRow && horizontalGap <= Math.max(maxGap, boundary.width * 0.9);
}

function connectedEvidence(entries: DisplacementEvidence[], boundary: Box, maxGap: number): DisplacementEvidence[][] {
  const remaining = new Set(entries);
  const groups: DisplacementEvidence[][] = [];
  while (remaining.size > 0) {
    const first = remaining.values().next().value as DisplacementEvidence;
    remaining.delete(first);
    const group = [first];
    for (let cursor = 0; cursor < group.length; cursor++) {
      const current = group[cursor]!;
      for (const candidate of [...remaining]) {
        if (!structurallyAdjacent(current.projectedBox, candidate.projectedBox, boundary, maxGap)) continue;
        remaining.delete(candidate);
        group.push(candidate);
      }
    }
    groups.push(group);
  }
  return groups;
}

function meaningfulLabel(entries: CandidateEntry[], boundary: UiElement | undefined, elements: Map<string, UiElement>): string {
  const candidates = [
    ...entries.map(entry => elements.get(entry.evidence.expectedId)),
    boundary
  ].filter((element): element is UiElement => element !== undefined);
  for (const element of candidates) {
    const value = element.label.trim();
    if (!value || /^cv-component-/i.test(value) || /^proj-/i.test(value)) continue;
    return value;
  }
  return "UI region";
}

function pairSet(cluster: CandidateCluster): Set<string> {
  return new Set(cluster.entries.map(entry => entry.evidence.pairId));
}

function meanScore(entries: CandidateEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.candidate.score, 0) / Math.max(1, entries.length);
}

export function resolveDisplacementConsensus(input: {
  evidence: DisplacementEvidence[];
  expectedElements: UiElement[];
  viewportWidth: number;
}): DisplacementConsensusResult {
  const tolerance = Math.max(8, input.viewportWidth * 0.015);
  const elements = new Map(input.expectedElements.map(element => [element.id, element]));
  const clusters = clusterCandidates(input.evidence, tolerance)
    .map(cluster => ({ ...cluster, entries: stableGreedyAssignment(cluster.entries) }))
    .filter(cluster => new Set(cluster.entries.map(entry => entry.evidence.pairId)).size >= 2);

  const ambiguousClusters = new Set<CandidateCluster>();
  for (let leftIndex = 0; leftIndex < clusters.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < clusters.length; rightIndex++) {
      const left = clusters[leftIndex]!;
      const right = clusters[rightIndex]!;
      const leftPairs = pairSet(left);
      const rightPairs = pairSet(right);
      const shared = [...leftPairs].filter(pairId => rightPairs.has(pairId)).length;
      if (shared === 0 || leftPairs.size !== rightPairs.size) continue;
      if (shared === leftPairs.size && Math.abs(meanScore(left.entries) - meanScore(right.entries)) < 0.05) {
        ambiguousClusters.add(left);
        ambiguousClusters.add(right);
      }
    }
  }

  const groups: DisplacementGroup[] = [];
  const groupedPairs = new Set<string>();
  for (const cluster of clusters.filter(item => !ambiguousClusters.has(item))) {
    const available = cluster.entries.filter(entry => !groupedPairs.has(entry.evidence.pairId));
    const uniquePairs = [...new Set(available.map(entry => entry.evidence.pairId))];
    if (uniquePairs.length < 2) continue;
    const boundary = commonAncestor(available.map(entry => entry.evidence.expectedId), elements);
    const dx = median(available.map(entry => entry.candidate.dx));
    const dy = median(available.map(entry => entry.candidate.dy));
    const id = `displacement-${crypto.createHash("sha1").update(`${uniquePairs.sort().join("|")}:${dx}:${dy}`).digest("hex").slice(0, 12)}`;
    groups.push({
      id,
      pairIds: uniquePairs,
      ...(boundary ? { boundaryElementId: boundary.id } : {}),
      label: meaningfulLabel(available, boundary, elements),
      dx,
      dy,
      confidence: Number(meanScore(available).toFixed(4))
    });
    uniquePairs.forEach(pairId => groupedPairs.add(pairId));
  }

  const individuals = new Map<string, DisplacementCandidate>();
  for (const item of input.evidence) {
    if (groupedPairs.has(item.pairId)) continue;
    const best = item.candidates[0];
    if (isUniqueDisplacementCandidate(best)) individuals.set(item.pairId, best);
  }
  return { groups, individuals };
}

export function resolveStructuralMismatchGroups(input: {
  evidence: DisplacementEvidence[];
  expectedElements: UiElement[];
  viewportWidth: number;
  viewportHeight: number;
}): StructuralMismatchGroup[] {
  const elements = new Map(input.expectedElements.map(element => [element.id, element]));
  const byBoundary = new Map<string, { boundary: UiElement; entries: DisplacementEvidence[] }>();
  for (const entry of input.evidence) {
    const boundary = nearestBoundary(entry.expectedId, elements);
    if (!boundary) continue;
    const bucket = byBoundary.get(boundary.id) ?? { boundary, entries: [] };
    bucket.entries.push(entry);
    byBoundary.set(boundary.id, bucket);
  }

  const groups: StructuralMismatchGroup[] = [];
  for (const { boundary, entries } of byBoundary.values()) {
    const maxGap = Math.max(24, Math.min(input.viewportHeight * 0.08, boundary.box.height * 0.2));
    for (const connected of connectedEvidence(entries, boundary.box, maxGap)) {
      if (connected.length < 2) continue;
      const pairIds = connected.map(entry => entry.pairId).sort();
      const id = `structural-${crypto.createHash("sha1").update(`${boundary.id}:${pairIds.join("|")}`).digest("hex").slice(0, 12)}`;
      groups.push({
        id,
        kind: "structural_region_mismatch",
        pairIds,
        boundaryElementId: boundary.id,
        label: meaningfulLabel(connected.map(entry => ({ entry, evidence: entry, candidate: entry.candidates[0] ?? {
          dx: 0, dy: 0, score: 0, edgeOverlap: 0, colorAgreement: 0, improvement: 0, runnerUpMargin: 0
        } })).map(item => ({ evidence: item.evidence, candidate: item.candidate })), boundary, elements)
      });
    }
  }
  return groups.sort((a, b) => a.id.localeCompare(b.id));
}
