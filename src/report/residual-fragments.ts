import type { CoverageDecisionTrace, DiffRecord } from "../schemas/core.js";
import { intersect } from "../signals/geometry.js";
import type { CanonicalRegion, RegionLedger } from "./region-ledger.js";

export interface ResidualFragmentOptions {
  maxDistancePx: number;
  maxResidualPixels: number;
  maxThinSidePx: number;
  minAreaMultiplier: number;
}

export interface ResidualFragmentDecision {
  regionId: string;
  state: "noise";
  coveringFindingId: string;
  coveringCriterion: DiffRecord["criterion"];
  relation: "inside_larger_finding" | "nearby_larger_finding";
  detail: string;
}

const DETERMINISTIC_SOURCES = new Set<DiffRecord["classificationSource"]>([
  "deterministic_projected_mismatch",
  "deterministic_geometry",
  "deterministic_presence"
]);

function area(box: { width: number; height: number }): number {
  return box.width * box.height;
}

function expanded(box: DiffRecord["location"], px: number): DiffRecord["location"] {
  return {
    x: Math.max(0, box.x - px),
    y: Math.max(0, box.y - px),
    width: box.width + px * 2,
    height: box.height + px * 2
  };
}

function contains(container: DiffRecord["location"], subject: DiffRecord["location"]): boolean {
  return (
    subject.x >= container.x &&
    subject.y >= container.y &&
    subject.x + subject.width <= container.x + container.width &&
    subject.y + subject.height <= container.y + container.height
  );
}

function residualEligible(region: CanonicalRegion, options: ResidualFragmentOptions): boolean {
  return (
    region.pixelCount <= options.maxResidualPixels ||
    Math.min(region.box.width, region.box.height) <= options.maxThinSidePx
  );
}

function findingEligible(finding: DiffRecord): boolean {
  return finding.reviewerStatus === "accepted" || DETERMINISTIC_SOURCES.has(finding.classificationSource);
}

function relationToFinding(
  region: CanonicalRegion,
  finding: DiffRecord,
  options: ResidualFragmentOptions
): ResidualFragmentDecision["relation"] | undefined {
  const locations = finding.coverageLocations ?? [finding.location];
  if (locations.some(location => contains(location, region.box))) return "inside_larger_finding";
  if (locations.some(location => contains(expanded(location, options.maxDistancePx), region.box))) {
    return "nearby_larger_finding";
  }
  return undefined;
}

export function classifyResidualFragments(
  regions: CanonicalRegion[],
  findings: DiffRecord[],
  options: ResidualFragmentOptions
): ResidualFragmentDecision[] {
  const decisions: ResidualFragmentDecision[] = [];

  for (const region of regions) {
    if (region.state !== "unresolved" || !residualEligible(region, options)) continue;
    const regionArea = Math.max(1, area(region.box));
    const candidates = findings
      .filter(findingEligible)
      .map(finding => ({
        finding,
        relation: relationToFinding(region, finding, options),
        findingArea: Math.max(...(finding.coverageLocations ?? [finding.location]).map(area))
      }))
      .filter((entry): entry is { finding: DiffRecord; relation: ResidualFragmentDecision["relation"]; findingArea: number } =>
        entry.relation !== undefined && entry.findingArea >= regionArea * options.minAreaMultiplier
      )
      .sort((a, b) => a.findingArea - b.findingArea);

    const best = candidates[0];
    if (!best) continue;

    decisions.push({
      regionId: region.id,
      state: "noise",
      coveringFindingId: best.finding.id,
      coveringCriterion: best.finding.criterion,
      relation: best.relation,
      detail: `residual fragment ${best.relation.replaceAll("_", " ")} ${best.finding.id}`
    });
  }

  return decisions;
}

export function applyResidualFragmentDecisions(
  ledger: RegionLedger,
  decisions: ResidualFragmentDecision[]
): void {
  if (decisions.length === 0) return;
  const byRegion = new Map(ledger.regions.map(region => [region.id, region]));
  const traceByComponent = new Map<string, CoverageDecisionTrace>(
    ledger.coverageTrace.map(trace => [trace.componentId, trace])
  );

  for (const decision of decisions) {
    const region = byRegion.get(decision.regionId);
    if (!region || region.state !== "unresolved") continue;
    region.state = decision.state;
    region.coveringFindingIds = [decision.coveringFindingId];
    region.unresolvedDetail = decision.detail;
    for (const componentId of region.sourceComponentIds) {
      const trace = traceByComponent.get(componentId);
      if (!trace) continue;
      trace.status = "noise_residual_fragment";
      trace.coveringDiffId = decision.coveringFindingId;
      trace.coveringCriterion = decision.coveringCriterion;
      trace.overlapRatio = intersect(trace.componentBox, region.box) ? 1 : 0;
    }
  }
}
