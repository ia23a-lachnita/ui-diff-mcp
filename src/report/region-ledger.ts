import type { Box, CoverageDecisionTrace, DiffRecord, UiArtifact, UnresolvedRegion, RecoveryComponentTrace, RecoveryRegionOutcome } from "../schemas/core.js";
import type { PixelComponent } from "../signals/pixel-diff.js";
import { intersect } from "../signals/geometry.js";
import { clusterUncoveredComponentsWithMembers } from "./component-clustering.js";
import { traceCoverageDecisions } from "./coverage.js";

const MAX_UNRESOLVED_DETAIL_LENGTH = 200;
const TRUNCATED_UNRESOLVED_DETAIL_SUFFIX = "... [truncated]";

function emittedUnresolvedDetail(detail: string): string {
  if (detail.length <= MAX_UNRESOLVED_DETAIL_LENGTH) return detail;
  return `${detail.slice(0, MAX_UNRESOLVED_DETAIL_LENGTH - TRUNCATED_UNRESOLVED_DETAIL_SUFFIX.length)}${TRUNCATED_UNRESOLVED_DETAIL_SUFFIX}`;
}

export interface SupersessionDetail {
  supersedingFindingId: string;
  reason: "same_criterion_acceptance_overlap";
  overlapRatio: number;
}

export interface CanonicalRegion {
  id: string;
  box: Box;
  pixelCount: number;
  sourceComponentIds: string[];
  state: "unresolved" | "covered" | "recovered" | "noise";
  coveringFindingIds: string[];
  artifactPaths: UiArtifact[];
  unresolvedDetail?: string;
  blockingRecoveryOutcome?: RecoveryRegionOutcome;
  supersessionDetail?: SupersessionDetail;
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
  return Math.max(...(finding.coverageLocations ?? [finding.location]).map(location => {
    const overlap = intersect(box, location);
    if (!overlap) return 0;
    return (overlap.width * overlap.height) / (box.width * box.height);
  }));
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

    if (region.blockingRecoveryOutcome?.state === "unresolved" && region.blockingRecoveryOutcome.criterion) {
      const blockingCriterion = region.blockingRecoveryOutcome.criterion;
      const supersedingFinding = covering.find(finding =>
        finding.criterion === blockingCriterion
        && overlapRatio(region.box, finding) >= 0.9
        && finding.reviewerStatus === "accepted"
      );
      if (supersedingFinding) {
        const overlap = overlapRatio(region.box, supersedingFinding);
        region.state = "covered";
        region.coveringFindingIds = [supersedingFinding.id];
        region.supersessionDetail = {
          supersedingFindingId: supersedingFinding.id,
          reason: "same_criterion_acceptance_overlap",
          overlapRatio: overlap
        };
      }
      continue;
    }

    region.state = "covered";
    region.coveringFindingIds = [...new Set(covering.map(finding => finding.id))];
  }
}

export function annotateRecoveryTraceSupersessions(
  ledger: RegionLedger,
  trace: RecoveryComponentTrace[]
): RecoveryComponentTrace[] {
  const supersessions = new Map(
    ledger.regions
      .filter(region => region.supersessionDetail !== undefined)
      .map(region => [region.id, region.supersessionDetail!] as const)
  );
  return trace.map(entry => {
    if (entry.status !== "unsupported_recovery_claim") return entry;
    const supersession = supersessions.get(entry.componentId);
    if (!supersession) return entry;
    return {
      ...entry,
      supersededByFindingId: supersession.supersedingFindingId,
      supersessionReason: supersession.reason,
      supersessionOverlapRatio: supersession.overlapRatio
    };
  });
}

export function markBroadVlmEvidence(ledger: RegionLedger, findings: DiffRecord[]): void {
  for (const region of ledger.regions) {
    if (region.state !== "unresolved") continue;
    const related = findings.filter(finding => overlapRatio(region.box, finding) >= 0.1).map(finding => finding.id).sort();
    if (related.length === 0) continue;
    if (region.unresolvedDetail?.startsWith("unsupported_recovery_claim:")) {
      region.unresolvedDetail = `${region.unresolvedDetail}; broad_vlm_evidence: ${related.join(",")}`;
    } else {
      region.unresolvedDetail = region.unresolvedDetail?.startsWith("evidence_crop_rejected:")
        ? `${region.unresolvedDetail}; broad_vlm_evidence: ${related.join(",")}`
        : `broad_vlm_evidence: ${related.join(",")}`;
    }
    region.coveringFindingIds = related;
  }
}

export function applyRecoveryOutcomes(ledger: RegionLedger, outcomes: RecoveryRegionOutcome[]): void {
  const byId = new Map(ledger.regions.map(region => [region.id, region]));
  for (const outcome of outcomes) {
    const region = byId.get(outcome.regionId);
    if (!region) continue;
    region.artifactPaths = outcome.artifactPaths;
    region.state = outcome.state;
    region.unresolvedDetail = outcome.reason;
    if (outcome.findingId) region.coveringFindingIds = [outcome.findingId];
    if (outcome.state === "unresolved" && outcome.reason.startsWith("unsupported_recovery_claim:")) {
      region.blockingRecoveryOutcome = outcome;
    }
  }
}

export function unresolvedRegionsFromLedger(
  ledger: RegionLedger,
  reason: UnresolvedRegion["reason"]
): UnresolvedRegion[] {
  return ledger.regions
    .filter(region => region.state === "unresolved")
    .map(region => {
      const fullDetail = region.unresolvedDetail;
      const detail = fullDetail ? emittedUnresolvedDetail(fullDetail) : undefined;
      const resolvedReason = fullDetail?.startsWith("evidence_crop_rejected:")
        ? "evidence_crop_rejected"
        : fullDetail?.startsWith("broad_vlm_evidence:")
          ? "broad_vlm_evidence"
          : fullDetail?.startsWith("unsupported_recovery_claim:")
            ? "unsupported_recovery_claim"
            : reason;
      return {
        id: region.id,
        location: region.box,
        pixelCount: region.pixelCount,
        sourceComponentIds: region.sourceComponentIds,
        relatedFindingIds: region.coveringFindingIds,
        relation: region.coveringFindingIds.length > 0 ? "nearby_larger_finding" : "none",
        reason: resolvedReason,
        ...(region.blockingRecoveryOutcome?.diagnostics !== undefined ? { diagnostics: region.blockingRecoveryOutcome.diagnostics } : {}),
        ...(detail ? { detail } : {}),
        artifactPaths: region.artifactPaths
      };
    });
}
