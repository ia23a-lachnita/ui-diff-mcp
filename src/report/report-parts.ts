import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  DiffRecordSchema,
  DiffSummarySchema,
  ElementPairSchema,
  RunDebugSummarySchema,
  ScopeDiffSummarySchema,
  StructuralConsolidationDetailSchema,
  UiElementSchema,
  UnresolvedRegionSchema,
  UsageSummarySchema,
  type ReportPart,
  type UiDiffReport
} from "../schemas/core.js";
import { assertStructuralConsolidationAuthenticity } from "./structural-authenticity.js";

export const ElementsPartSchema = z.object({
  elements: z.object({
    expected: z.array(UiElementSchema),
    actual: z.array(UiElementSchema)
  })
});
export const PairsPartSchema = z.object({ pairs: z.array(ElementPairSchema) });
export const DiffsPartSchema = z.object({ diffs: z.array(DiffRecordSchema) });
export const BroadEvidencePartSchema = z.object({ broadEvidence: z.array(DiffRecordSchema) });
export const UnresolvedRegionsPartSchema = z.object({ unresolvedRegions: z.array(UnresolvedRegionSchema) });
export const DebugSummaryPartSchema = z.object({ debugSummary: RunDebugSummarySchema });
export const UsageSummaryPartSchema = z.object({ usageSummary: UsageSummarySchema });
export const ScopeSummaryPartSchema = z.object({ scopeSummaries: z.array(ScopeDiffSummarySchema) });
export const StructuralConsolidationPartSchema = z.object({
  ledger: StructuralConsolidationDetailSchema.shape.ledger,
  validation: StructuralConsolidationDetailSchema.shape.validation
}).strict();

type PartPayload = z.infer<typeof ElementsPartSchema>
  | z.infer<typeof PairsPartSchema>
  | z.infer<typeof DiffsPartSchema>
  | z.infer<typeof BroadEvidencePartSchema>
  | z.infer<typeof UnresolvedRegionsPartSchema>
  | z.infer<typeof DebugSummaryPartSchema>
  | z.infer<typeof UsageSummaryPartSchema>
  | z.infer<typeof ScopeSummaryPartSchema>
  | z.infer<typeof StructuralConsolidationPartSchema>;

type ReadFile = (path: string) => Promise<string | Buffer>;

export type RunInputComparability =
  | { status: "comparable" }
  | {
      status: "not_comparable";
      reason:
        | "missing_input_identity"
        | "expected_image_hash_mismatch"
        | "actual_image_hash_mismatch"
        | "cohort_not_declared"
        | "cohort_mismatch";
    };

export function compareRunInputs(
  left: Pick<UiDiffReport, "inputProvenance">,
  right: Pick<UiDiffReport, "inputProvenance">,
  cohorts: { leftCohort?: string; rightCohort?: string } = {}
): RunInputComparability {
  if (left.inputProvenance === undefined || right.inputProvenance === undefined) {
    return { status: "not_comparable", reason: "missing_input_identity" };
  }
  if (left.inputProvenance.identity.expected.sha256 !== right.inputProvenance.identity.expected.sha256) {
    return { status: "not_comparable", reason: "expected_image_hash_mismatch" };
  }
  if (left.inputProvenance.identity.actual.sha256 !== right.inputProvenance.identity.actual.sha256) {
    return { status: "not_comparable", reason: "actual_image_hash_mismatch" };
  }
  if (cohorts.leftCohort === undefined || cohorts.rightCohort === undefined) {
    return { status: "not_comparable", reason: "cohort_not_declared" };
  }
  if (cohorts.leftCohort !== cohorts.rightCohort) {
    return { status: "not_comparable", reason: "cohort_mismatch" };
  }
  return { status: "comparable" };
}

export async function writeReportPart<T extends PartPayload>(
  artifactRoot: string,
  role: ReportPart["role"],
  fileName: string,
  payload: T,
  schema: z.ZodType<T>
): Promise<ReportPart> {
  const partsDir = path.join(artifactRoot, "parts");
  await fs.mkdir(partsDir, { recursive: true });
  const validated = schema.parse(payload);
  const partPath = path.join(partsDir, fileName);
  const tmpPath = `${partPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(validated, null, 2), "utf8");
  await fs.rename(tmpPath, partPath);
  return { role, path: path.join("parts", fileName).replace(/\\/g, "/") };
}

export function assertReportPartsIntegrity(parts: readonly ReportPart[]): void {
  const roles = new Set<string>();
  const paths = new Set<string>();
  for (const part of parts) {
    const normalizedPath = path.posix.normalize(part.path.replaceAll("\\", "/"));
    if (roles.has(part.role)) throw new Error(`Duplicate report part role: ${part.role}`);
    if (paths.has(normalizedPath)) throw new Error(`Duplicate report part path: ${normalizedPath}`);
    roles.add(part.role);
    paths.add(normalizedPath);
  }
}

export async function writeReportParts(report: UiDiffReport): Promise<ReportPart[]> {
  assertReportReferenceIntegrity(report);
  assertReportPartsIntegrity(report.reportParts ?? []);
  const planned: ReportPart[] = [
    { role: "elements", path: "parts/elements.json" },
    { role: "pairs", path: "parts/pairs.json" },
    { role: "diffs", path: "parts/diffs.json" },
    { role: "broad_evidence", path: "parts/broad-evidence.json" },
    { role: "unresolved_regions", path: "parts/unresolved-regions.json" }
  ];
  const writers: Array<() => Promise<ReportPart>> = [
    () => writeReportPart(report.artifactRoot, "elements", "elements.json", { elements: report.elements }, ElementsPartSchema),
    () => writeReportPart(report.artifactRoot, "pairs", "pairs.json", { pairs: report.pairs }, PairsPartSchema),
    () => writeReportPart(report.artifactRoot, "diffs", "diffs.json", { diffs: report.diffs }, DiffsPartSchema),
    () => writeReportPart(report.artifactRoot, "broad_evidence", "broad-evidence.json", { broadEvidence: report.broadEvidence ?? [] }, BroadEvidencePartSchema),
    () => writeReportPart(report.artifactRoot, "unresolved_regions", "unresolved-regions.json", { unresolvedRegions: report.unresolvedRegions }, UnresolvedRegionsPartSchema)
  ];
  if (report.debugSummary !== undefined) {
    planned.push({ role: "debug_summary", path: "parts/debug-summary.json" });
    writers.push(() => writeReportPart(report.artifactRoot, "debug_summary", "debug-summary.json", { debugSummary: report.debugSummary! }, DebugSummaryPartSchema));
  }
  if (report.usageSummary !== undefined) {
    planned.push({ role: "usage_summary", path: "parts/usage-summary.json" });
    writers.push(() => writeReportPart(report.artifactRoot, "usage_summary", "usage-summary.json", { usageSummary: report.usageSummary! }, UsageSummaryPartSchema));
  }
  if (report.diffSummary !== undefined) {
    planned.push({ role: "scope_summary", path: "parts/scope-summary.json" });
    writers.push(() => writeReportPart(report.artifactRoot, "scope_summary", "scope-summary.json", { scopeSummaries: report.diffSummary!.scopeSummaries }, ScopeSummaryPartSchema));
  }
  if (report.structuralConsolidationDetail !== undefined) {
    planned.push({ role: "structural_consolidation", path: "parts/structural-consolidation.json" });
    writers.push(() => writeReportPart(report.artifactRoot, "structural_consolidation", "structural-consolidation.json", report.structuralConsolidationDetail!, StructuralConsolidationPartSchema));
  }
  assertReportPartsIntegrity(planned);
  const parts = [] as ReportPart[];
  for (const writer of writers) parts.push(await writer());
  assertReportPartsIntegrity(parts);
  return parts;
}

export function slimReportForParts(report: UiDiffReport, reportParts: ReportPart[]): UiDiffReport {
  assertReportPartsIntegrity(reportParts);
  return {
    ...report,
    reportParts,
    elements: { expected: [], actual: [] },
    pairs: [],
    diffs: [],
    broadEvidence: [],
    unresolvedRegions: [],
    debugSummary: undefined,
    usageSummary: undefined,
    diffSummary: report.diffSummary === undefined
      ? undefined
      : { ...report.diffSummary, scopeSummaries: [] }
    ,
    structuralConsolidationDetail: undefined
  };
}

function resolvePartPath(reportPath: string, partPath: string): string {
  const baseDir = path.dirname(path.resolve(reportPath));
  const resolved = path.resolve(baseDir, partPath);
  if (!(resolved === baseDir || resolved.startsWith(`${baseDir}${path.sep}`))) {
    throw new Error(`report part path escapes report directory: ${partPath}`);
  }
  return resolved;
}

async function readJsonPart<T>(reportPath: string, part: ReportPart, readFile: ReadFile, schema: z.ZodType<T>): Promise<T> {
  const raw = await readFile(resolvePartPath(reportPath, part.path));
  return schema.parse(JSON.parse(raw.toString()));
}

function notEvaluatedStructuralSummary(): NonNullable<UiDiffReport["structuralConsolidation"]> {
  return {
    status: "not_evaluated",
    candidateCount: 0,
    retainedCount: 0,
    suppressedCount: 0,
    broadExcludedCount: 0,
    violationCount: 0
  };
}

function assertReportLifecycle(report: Pick<UiDiffReport, "isCheckpoint" | "status">): void {
  if (report.isCheckpoint === true) {
    if (report.status !== "running" && report.status !== "interrupted") {
      throw new Error(`checkpoint status must be running or interrupted, got ${report.status}`);
    }
    return;
  }
  if (report.status === "running" || report.status === "interrupted") {
    throw new Error(`final report status cannot be ${report.status}`);
  }
}

export async function hydrateReportParts(
  report: UiDiffReport,
  reportPath: string,
  readFile: ReadFile = fs.readFile
): Promise<UiDiffReport> {
  assertReportLifecycle(report);
  const reportParts = report.reportParts ?? [];
  assertReportPartsIntegrity(reportParts);
  if (reportParts.length === 0) {
    if (!report.isCheckpoint) {
      if (report.structuralConsolidationDetail !== undefined) {
        assertStructuralConsolidationAuthenticity(report, report.structuralConsolidationDetail);
      } else if (report.structuralConsolidationContract === "v1") {
        throw new Error("structural consolidation authenticity: final report is missing structural part/detail");
      } else {
        return { ...report, structuralConsolidation: notEvaluatedStructuralSummary(), structuralConsolidationDetail: undefined };
      }
    }
    return report;
  }

  let hydrated: UiDiffReport = report;
  const findPart = (role: ReportPart["role"]) => reportParts.find(part => part.role === role);
  const structuralPart = findPart("structural_consolidation");
  const currentStructuralContract = report.structuralConsolidationContract === "v1" || structuralPart !== undefined;

  const elementsPart = findPart("elements");
  if (elementsPart !== undefined && report.elements.expected.length === 0 && report.elements.actual.length === 0) {
    const payload = await readJsonPart(reportPath, elementsPart, readFile, ElementsPartSchema);
    hydrated = { ...hydrated, elements: payload.elements };
  }

  const pairsPart = findPart("pairs");
  if (pairsPart !== undefined && report.pairs.length === 0) {
    const payload = await readJsonPart(reportPath, pairsPart, readFile, PairsPartSchema);
    hydrated = { ...hydrated, pairs: payload.pairs };
  }

  const diffsPart = findPart("diffs");
  if (diffsPart !== undefined && report.diffs.length === 0) {
    const payload = await readJsonPart(reportPath, diffsPart, readFile, DiffsPartSchema);
    hydrated = { ...hydrated, diffs: payload.diffs };
  }

  const broadEvidencePart = findPart("broad_evidence");
  if (broadEvidencePart !== undefined && (report.broadEvidence?.length ?? 0) === 0) {
    const payload = await readJsonPart(reportPath, broadEvidencePart, readFile, BroadEvidencePartSchema);
    hydrated = { ...hydrated, broadEvidence: payload.broadEvidence };
  }

  const unresolvedPart = findPart("unresolved_regions");
  if (unresolvedPart !== undefined && report.unresolvedRegions.length === 0) {
    const payload = await readJsonPart(reportPath, unresolvedPart, readFile, UnresolvedRegionsPartSchema);
    hydrated = { ...hydrated, unresolvedRegions: payload.unresolvedRegions };
  }

  const debugPart = findPart("debug_summary");
  if (debugPart !== undefined && report.debugSummary === undefined) {
    const payload = await readJsonPart(reportPath, debugPart, readFile, DebugSummaryPartSchema);
    hydrated = { ...hydrated, debugSummary: payload.debugSummary };
  }

  const usagePart = findPart("usage_summary");
  if (usagePart !== undefined && report.usageSummary === undefined) {
    const payload = await readJsonPart(reportPath, usagePart, readFile, UsageSummaryPartSchema);
    hydrated = { ...hydrated, usageSummary: payload.usageSummary };
  }

  const scopePart = findPart("scope_summary");
  if (scopePart !== undefined && (report.diffSummary?.scopeSummaries.length ?? 0) === 0) {
    const payload = await readJsonPart(reportPath, scopePart, readFile, ScopeSummaryPartSchema);
    hydrated = {
      ...hydrated,
      diffSummary: {
        finalDiffCount: hydrated.diffSummary?.finalDiffCount ?? hydrated.diffs.length,
        ...(hydrated.diffSummary?.finalGroupCount !== undefined
          ? { finalGroupCount: hydrated.diffSummary.finalGroupCount }
          : {}),
        unresolvedRegionCount: hydrated.diffSummary?.unresolvedRegionCount ?? hydrated.unresolvedRegions.length,
        bySeverity: hydrated.diffSummary?.bySeverity ?? {},
        byCriterion: hydrated.diffSummary?.byCriterion ?? {},
        byClassificationSource: hydrated.diffSummary?.byClassificationSource ?? {},
        scopeSummaries: payload.scopeSummaries
      }
    };
  }

  if (structuralPart !== undefined && hydrated.structuralConsolidationDetail === undefined) {
    const payload = await readJsonPart(reportPath, structuralPart, readFile, StructuralConsolidationPartSchema);
    hydrated = { ...hydrated, structuralConsolidationDetail: payload };
  }

  if (!hydrated.isCheckpoint) {
    if (hydrated.structuralConsolidationDetail !== undefined) {
      assertStructuralConsolidationAuthenticity(hydrated, hydrated.structuralConsolidationDetail);
    } else if (currentStructuralContract) {
      throw new Error("structural consolidation authenticity: final report is missing structural part/detail");
    } else {
      hydrated = { ...hydrated, structuralConsolidation: notEvaluatedStructuralSummary(), structuralConsolidationDetail: undefined };
    }
  }

  // Multipart reports written before the broad-evidence role used relatedFindingIds
  // for broad evidence. Enforce the split namespace only for the new contract.
  if (broadEvidencePart !== undefined) assertReportReferenceIntegrity(hydrated);
  return hydrated;
}

export function assertReportReferenceIntegrity(
  report: Pick<UiDiffReport, "diffs" | "broadEvidence" | "unresolvedRegions">
): void {
  const finalIds = new Set(report.diffs.map(diff => diff.id));
  const broadIds = new Set((report.broadEvidence ?? []).map(entry => entry.id));
  if (finalIds.size !== report.diffs.length) throw new Error("Duplicate final finding ID in report");
  if (broadIds.size !== (report.broadEvidence ?? []).length) throw new Error("Duplicate broad evidence ID in report");
  for (const id of finalIds) {
    if (broadIds.has(id)) throw new Error(`Dangling report reference namespace collision: ${id}`);
  }
  for (const region of report.unresolvedRegions) {
    for (const id of region.relatedFindingIds) {
      if (!finalIds.has(id)) throw new Error(`Dangling report reference from ${region.id} to final finding ${id}`);
    }
    for (const id of region.relatedBroadEvidenceIds ?? []) {
      if (!broadIds.has(id)) throw new Error(`Dangling report reference from ${region.id} to broad evidence ${id}`);
    }
  }
}
