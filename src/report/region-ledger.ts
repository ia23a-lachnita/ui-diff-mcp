import type { Box, CoverageDecisionTrace, DiffRecord, UiArtifact, UnresolvedRegion } from "../schemas/core.js";
import type { PixelComponent } from "../signals/pixel-diff.js";
import { intersect } from "../signals/geometry.js";
import { clusterUncoveredComponentsWithMembers } from "./component-clustering.js";
import { traceCoverageDecisions } from "./coverage.js";

export interface CanonicalRegion {
  id: string;
  box: Box;
  pixelCount: number;
  sourceComponentIds: string[];
  state: "unresolved" | "covered" | "recovered" | "noise";
  coveringFindingIds: string[];
  artifactPaths: UiArtifact[];
}

export interface RegionLedger {
  rawComponentCount: number;
  belowThresholdCount: number;
  regions: CanonicalRegion[];
  coverageTrace: CoverageDecisionTrace[];
}

export interface RegionLedgerOptions {
  minPixelCount: number;
  maxGapPx: number;
  maxClusterAreaRatio: number;
  imageWidth: number;
  imageHeight: number;
}

function overlapRatio(box: Box, finding: DiffRecord): number {
  const overlap = intersect(box, finding.location);
  if (!overlap) return 0;
  return (overlap.width * overlap.height) / (box.width * box.height);
}

export function buildRegionLedger(
  components: PixelComponent[],
  findings: DiffRecord[],
  options: RegionLedgerOptions
): RegionLedger {
  const coverageTrace = traceCoverageDecisions(components, findings, options.minPixelCount);
  const belowThresholdCount = coverageTrace.filter(decision => decision.status === "below_threshold").length;
  const coveredRegions: CanonicalRegion[] = coverageTrace.flatMap((decision, index) => {
    if (decision.status !== "covered_by_diff") return [];
    const component = components[index]!;
    return [{
      id: "",
      box: component.box,
      pixelCount: component.pixelCount,
      sourceComponentIds: [decision.componentId],
      state: "covered" as const,
      coveringFindingIds: decision.coveringDiffId ? [decision.coveringDiffId] : [],
      artifactPaths: []
    }];
  });
  const uncoveredEntries = coverageTrace.flatMap((decision, index) =>
    decision.status === "uncovered"
      ? [{ component: components[index]!, componentId: decision.componentId }]
      : []
  );
  const clusters = clusterUncoveredComponentsWithMembers(
    uncoveredEntries.map(entry => entry.component),
    options
  );
  const unresolvedRegions: CanonicalRegion[] = clusters.map(cluster => ({
    id: "",
    box: cluster.box,
    pixelCount: cluster.pixelCount,
    sourceComponentIds: cluster.sourceIndexes.map(index => uncoveredEntries[index]!.componentId),
    state: "unresolved",
    coveringFindingIds: [],
    artifactPaths: []
  }));
  const regions = [...coveredRegions, ...unresolvedRegions].map((region, index) => ({
    ...region,
    id: `region-${String(index + 1).padStart(4, "0")}`
  }));
  return { rawComponentCount: components.length, belowThresholdCount, regions, coverageTrace };
}

export function applyFindingCoverage(ledger: RegionLedger, findings: DiffRecord[]): void {
  for (const region of ledger.regions) {
    if (region.state !== "unresolved") continue;
    const covering = findings.filter(finding => overlapRatio(region.box, finding) >= 0.1);
    if (covering.length === 0) continue;
    region.state = "covered";
    region.coveringFindingIds = [...new Set(covering.map(finding => finding.id))];
  }
}

export function unresolvedRegionsFromLedger(
  ledger: RegionLedger,
  reason: UnresolvedRegion["reason"]
): UnresolvedRegion[] {
  return ledger.regions
    .filter(region => region.state === "unresolved")
    .map(region => ({
      id: region.id,
      location: region.box,
      pixelCount: region.pixelCount,
      sourceComponentIds: region.sourceComponentIds,
      reason,
      artifactPaths: region.artifactPaths
    }));
}
