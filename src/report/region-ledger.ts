import type { Box, ClaimDiagnostics, CoverageDecisionTrace, DiffRecord, UiArtifact, UnresolvedRegion, RecoveryComponentTrace, RecoveryRegionOutcome } from "../schemas/core.js";
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
  relatedBroadEvidenceIds?: string[];
  artifactPaths: UiArtifact[];
  relatedFindingIds?: string[];
  unresolvedDetail?: string;
  claimValidationDiagnostics?: ClaimDiagnostics;
  recoveryDeferredReason?: "deferred_broad_evidence_fragment";
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

    if (region.blockingRecoveryOutcome?.state === "unresolved") {
      const blockingCriterion = region.blockingRecoveryOutcome.criterion;
      if (!blockingCriterion) continue;
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

function appendUniqueArtifacts(existing: UiArtifact[], additions: UiArtifact[]): UiArtifact[] {
  const seen = new Set(existing.map(artifact => `${artifact.role}:${artifact.path}`));
  const result = [...existing];
  for (const artifact of additions) {
    const key = `${artifact.role}:${artifact.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(artifact);
  }
  return result;
}

/** Reopens any region whose coverage depended on an accepted finding escalated after consolidation. */
export function invalidateCoverageForEscalatedClaims(
  ledger: RegionLedger,
  escalatedFindings: readonly DiffRecord[],
  eligibleFindings: readonly DiffRecord[] = []
): void {
  if (escalatedFindings.length === 0) return;
  const ownerByInvalidatedId = new Map<string, DiffRecord>();
  for (const finding of escalatedFindings) {
    ownerByInvalidatedId.set(finding.id, finding);
    for (const childId of finding.childFindingIds ?? []) ownerByInvalidatedId.set(childId, finding);
  }
  const eligibleById = new Map(eligibleFindings.map(finding => [finding.id, finding]));
  const eligibleOwnerById = new Map<string, DiffRecord>();
  for (const finding of [...eligibleFindings].sort((a, b) => a.id.localeCompare(b.id))) {
    eligibleOwnerById.set(finding.id, finding);
    for (const childId of finding.childFindingIds ?? []) {
      if (!eligibleOwnerById.has(childId)) eligibleOwnerById.set(childId, finding);
    }
  }
  const traceByComponent = new Map(ledger.coverageTrace.map(trace => [trace.componentId, trace]));

  for (const region of ledger.regions) {
    const traces = region.sourceComponentIds.flatMap(componentId => {
      const trace = traceByComponent.get(componentId);
      return trace === undefined ? [] : [trace];
    });
    const associatedFindings = new Map<string, DiffRecord>();
    for (const findingId of [
      ...region.coveringFindingIds,
      ...traces.flatMap(trace => trace.coveringDiffId === undefined ? [] : [trace.coveringDiffId])
    ]) {
      const owner = ownerByInvalidatedId.get(findingId);
      if (owner !== undefined) associatedFindings.set(owner.id, owner);
    }
    if (associatedFindings.size === 0) continue;

    const associated = [...associatedFindings.values()].sort((a, b) => a.id.localeCompare(b.id));
    const associatedIds = new Set(associated.flatMap(finding => [finding.id, ...(finding.childFindingIds ?? [])]));
    const diagnostics = associated.find(finding => finding.claimValidationDiagnostics !== undefined)?.claimValidationDiagnostics;
    const artifacts = associated.flatMap(finding => finding.artifactPaths);

    const related = new Set([...(region.relatedFindingIds ?? []), ...associatedIds]);
    region.relatedFindingIds = [...related].sort((a, b) => a.localeCompare(b));
    region.artifactPaths = appendUniqueArtifacts(region.artifactPaths, artifacts);
    const traceCoverIds = traces.flatMap(trace => trace.coveringDiffId === undefined ? [] : [trace.coveringDiffId]);
    const remainingCoverIds = [...new Set([...region.coveringFindingIds, ...traceCoverIds])]
      .filter(id => !associatedIds.has(id))
      .flatMap(id => {
        const owner = eligibleOwnerById.get(id);
        return owner === undefined ? [] : [owner.id];
      })
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .sort((a, b) => a.localeCompare(b));
    region.coveringFindingIds = remainingCoverIds;

    if (remainingCoverIds.length > 0) {
      region.state = "covered";
      const remaining = eligibleById.get(remainingCoverIds[0]!);
      for (const trace of traces) {
        const rawId = trace.coveringDiffId;
        const eligibleOwner = rawId === undefined ? undefined : eligibleOwnerById.get(rawId);
        if (rawId !== undefined && !associatedIds.has(rawId) && eligibleOwner !== undefined) {
          trace.status = "covered_by_diff";
          trace.coveringDiffId = eligibleOwner.id;
          trace.coveringCriterion = eligibleOwner.criterion;
          delete trace.overlapRatio;
          continue;
        }
        trace.status = "covered_by_diff";
        trace.coveringDiffId = remainingCoverIds[0];
        if (remaining !== undefined) trace.coveringCriterion = remaining.criterion;
        delete trace.overlapRatio;
      }
      if (region.supersessionDetail !== undefined && (
        associatedIds.has(region.supersessionDetail.supersedingFindingId)
        || eligibleOwnerById.get(region.supersessionDetail.supersedingFindingId)?.id !== region.supersessionDetail.supersedingFindingId
      )) {
        delete region.supersessionDetail;
      }
      continue;
    }

    region.state = "unresolved";
    region.coveringFindingIds = [];
    delete region.supersessionDetail;
    delete region.blockingRecoveryOutcome;
    delete region.recoveryDeferredReason;
    region.unresolvedDetail = `unsupported_final_claim: ${[...associatedIds].sort((a, b) => a.localeCompare(b)).join(",")}`;
    if (diagnostics !== undefined) region.claimValidationDiagnostics = diagnostics;
    for (const trace of traces) {
      trace.status = "uncovered";
      delete trace.coveringDiffId;
      delete trace.coveringCriterion;
      delete trace.overlapRatio;
    }
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
    region.relatedBroadEvidenceIds = related;
    if (related.length === 0) continue;
    if (!region.unresolvedDetail?.includes("broad_vlm_evidence")) {
      region.unresolvedDetail = region.unresolvedDetail
        ? `${region.unresolvedDetail}; broad_vlm_evidence`
        : "broad_vlm_evidence";
    }
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
    if (outcome.state === "unresolved") {
      region.blockingRecoveryOutcome = outcome;
    } else {
      delete region.blockingRecoveryOutcome;
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
        : region.recoveryDeferredReason === "deferred_broad_evidence_fragment"
          ? "deferred_broad_evidence_fragment"
        : fullDetail?.startsWith("unsupported_recovery_claim:")
            ? "unsupported_recovery_claim"
          : fullDetail?.startsWith("unsupported_final_claim:")
            ? "unsupported_final_claim"
          : fullDetail?.startsWith("broad_vlm_evidence")
            ? "broad_vlm_evidence"
            : reason;
      return {
        id: region.id,
        location: region.box,
        pixelCount: region.pixelCount,
        sourceComponentIds: region.sourceComponentIds,
        relatedFindingIds: [...new Set([...(region.relatedFindingIds ?? []), ...region.coveringFindingIds])].sort((a, b) => a.localeCompare(b)),
        relatedBroadEvidenceIds: region.relatedBroadEvidenceIds ?? [],
        relation: region.coveringFindingIds.length > 0 || (region.relatedBroadEvidenceIds?.length ?? 0) > 0 ? "nearby_larger_finding" : "none",
        reason: resolvedReason,
        ...(region.blockingRecoveryOutcome?.diagnostics !== undefined ? { diagnostics: region.blockingRecoveryOutcome.diagnostics } : {}),
        ...(region.claimValidationDiagnostics !== undefined ? { diagnostics: region.claimValidationDiagnostics } : {}),
        ...(detail ? { detail } : {}),
        artifactPaths: region.artifactPaths
      };
    });
}
