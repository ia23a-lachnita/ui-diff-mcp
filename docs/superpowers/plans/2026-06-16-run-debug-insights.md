# Run Debug Insights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add machine-readable run diagnostics that explain why target-pair audit candidates and recovery candidates did or did not become final diff records.

**Architecture:** Keep the existing single-pass expected-first pipeline. Add compact trace objects at the audit, coverage, and recovery boundaries, write them as JSON artifacts, and surface roll-up counts in `report.json` and MCP output. Do not add manual inspection requirements, user-authored configs, root-cause explanations, or app-change advice.

**Tech Stack:** TypeScript ESM, Zod v4, Vitest, existing Sharp/pixelmatch artifact pipeline, existing MCP report writer.

---

## Problem

The latest persisted Calorix run showed `81` projected target pairs and the audit artifacts were visibly useful, but the report only retained the final diff records. That means the report cannot answer:

- how many criteria were triggered per target,
- how many auditor calls returned `hasDiff: false`,
- how many auditor calls failed parsing/provider/schema validation,
- how many proposed findings were dropped because evidence was empty,
- how many findings the reviewer rejected,
- why only one classified diff survived,
- which pixel-diff components were considered covered by a larger accepted diff,
- why recovery attempted only some uncovered components,
- why each recovery attempt returned no final diff.

The current artifacts prove that work happened, but not where evidence was lost. The next live run should produce enough structured diagnostics to explain the run without re-running models.

## File Structure

- Modify `src/schemas/core.ts`: add trace schemas, debug summary schema, and artifact roles for trace JSON.
- Create `src/debug/run-debug.ts`: trace builders, summary counters, artifact writer helpers, and stable status enums.
- Modify `src/audit/audit-target.ts`: return an `auditTrace` alongside accepted/rejected diffs.
- Modify `src/recovery/target-recovery.ts`: return per-component `recoveryTrace`.
- Modify `src/report/coverage.ts`: expose coverage decisions showing covered/uncovered reasons.
- Modify `src/report/report-writer.ts`: include debug artifacts in `index.json` and compact output.
- Modify `src/pipeline/run-ui-diff.ts`: aggregate traces, write debug artifacts, attach summary to report.
- Modify `src/schemas/tool-schemas.ts`: expose `debugSummary` in MCP structured output.
- Test `tests/unit/run-debug.test.ts`: summary aggregation and JSON artifact shape.
- Test `tests/unit/audit.test.ts`: audit trace outcomes for no-diff, auditor error, empty evidence, accepted, rejected.
- Test `tests/unit/target-recovery.test.ts`: recovery trace outcomes for classified false, schema failure, reviewer reject, caps, deadline.
- Test `tests/unit/coverage.test.ts`: coverage decisions name covering diff id and overlap ratio.
- Test `tests/e2e/compare-ui-images.test.ts`: full report contains debug artifacts and summary counts.
- Modify `docs/implementation-status.md`: track the implementation task and verification.
- Modify `docs/release/production-readiness-checklist.md`: add the debug-insight gate before the next Calorix sign-off.

## Debug Data Contract

Add these schemas in `src/schemas/core.ts`:

```ts
export const AuditDecisionStatusSchema = z.enum([
  "criterion_not_triggered",
  "auditor_has_diff",
  "auditor_no_diff",
  "auditor_error",
  "auditor_schema_error",
  "empty_evidence",
  "reviewer_accepted",
  "reviewer_rejected",
  "reviewer_needs_escalation",
  "reviewer_error"
]);

export const AuditCriterionTraceSchema = z.object({
  pairId: z.string().min(1),
  expectedId: z.string().optional(),
  actualId: z.string().optional(),
  targetLabel: z.string().min(1),
  targetType: UiElementTypeSchema,
  criterion: UiCriterionSchema.exclude(["unclassified_visual_change"]),
  status: AuditDecisionStatusSchema,
  model: z.string().optional(),
  reviewerModel: z.string().optional(),
  auditorDurationMs: z.number().int().min(0).optional(),
  reviewerDurationMs: z.number().int().min(0).optional(),
  evidenceCount: z.number().int().min(0).default(0),
  diffId: z.string().optional(),
  skipReason: z.string().max(500).optional(),
  rejectionReason: z.string().optional(),
  errorKind: z.enum(["provider", "schema", "unexpected"]).optional(),
  errorMessage: z.string().max(500).optional(),
  imageRoles: z.array(z.string()).default([]),
  artifactPaths: z.array(UiArtifactSchema).default([])
});
export type AuditCriterionTrace = z.infer<typeof AuditCriterionTraceSchema>;

export const CoverageDecisionStatusSchema = z.enum([
  "below_threshold",
  "covered_by_diff",
  "uncovered"
]);

export const CoverageDecisionTraceSchema = z.object({
  componentId: z.string().min(1),
  componentBox: BoxSchema,
  pixelCount: z.number().int().min(0),
  status: CoverageDecisionStatusSchema,
  coveringDiffId: z.string().optional(),
  coveringCriterion: UiCriterionSchema.optional(),
  overlapRatio: z.number().finite().min(0).max(1).optional()
});
export type CoverageDecisionTrace = z.infer<typeof CoverageDecisionTraceSchema>;

export const RecoveryDecisionStatusSchema = z.enum([
  "below_threshold",
  "skipped_component_cap",
  "skipped_model_call_cap",
  "skipped_deadline",
  "classified_false",
  "recovery_accepted",
  "recovery_needs_escalation",
  "recovery_rejected",
  "recovery_error",
  "recovery_schema_error",
  "missing_required_fields",
  "box_out_of_bounds",
  "box_no_component_overlap"
]);

export const RecoveryComponentTraceSchema = z.object({
  componentId: z.string().min(1),
  rank: z.number().int().min(0),
  componentBox: BoxSchema,
  pixelCount: z.number().int().min(0),
  status: RecoveryDecisionStatusSchema,
  model: z.string().optional(),
  reviewerModel: z.string().optional(),
  recoveryDurationMs: z.number().int().min(0).optional(),
  reviewerDurationMs: z.number().int().min(0).optional(),
  diffId: z.string().optional(),
  criterion: UiCriterionSchema.exclude(["unclassified_visual_change"]).optional(),
  errorKind: z.enum(["provider", "schema", "validation", "budget", "unexpected"]).optional(),
  errorMessage: z.string().max(500).optional(),
  artifactPaths: z.array(UiArtifactSchema).default([])
});
export type RecoveryComponentTrace = z.infer<typeof RecoveryComponentTraceSchema>;

export const RunDebugSummarySchema = z.object({
  auditPairs: z.number().int().min(0),
  auditCriterionCalls: z.number().int().min(0),
  auditAccepted: z.number().int().min(0),
  auditRejected: z.number().int().min(0),
  auditNoDiff: z.number().int().min(0),
  auditErrors: z.number().int().min(0),
  coverageComponents: z.number().int().min(0),
  coverageCovered: z.number().int().min(0),
  coverageUncovered: z.number().int().min(0),
  coverageBelowThreshold: z.number().int().min(0),
  recoveryAttempted: z.number().int().min(0),
  recoveryAccepted: z.number().int().min(0),
  recoveryRejected: z.number().int().min(0),
  recoveryClassifiedFalse: z.number().int().min(0),
  recoveryErrors: z.number().int().min(0),
  recoverySkipped: z.number().int().min(0)
});
export type RunDebugSummary = z.infer<typeof RunDebugSummarySchema>;
```

Add these artifact roles to `UiArtifactSchema`:

```ts
"audit_trace",
"coverage_trace",
"recovery_trace",
"debug_summary"
```

Add optional report field:

```ts
debugSummary: RunDebugSummarySchema.optional()
```

## Task 1: Trace Types And Summary Builder

**Files:**
- Modify: `src/schemas/core.ts`
- Create: `src/debug/run-debug.ts`
- Test: `tests/unit/run-debug.test.ts`

- [ ] **Step 1: Add the schemas**

Add the schemas from the Debug Data Contract to `src/schemas/core.ts`. Export all inferred types.

- [ ] **Step 2: Add summary aggregation**

Create `src/debug/run-debug.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AuditCriterionTrace,
  CoverageDecisionTrace,
  RecoveryComponentTrace,
  RunDebugSummary,
  UiArtifact
} from "../schemas/core.js";
import { RunDebugSummarySchema } from "../schemas/core.js";

export interface RunDebugTrace {
  audit: AuditCriterionTrace[];
  coverage: CoverageDecisionTrace[];
  recovery: RecoveryComponentTrace[];
}

export function summarizeRunDebug(trace: RunDebugTrace): RunDebugSummary {
  const summary: RunDebugSummary = {
    auditPairs: new Set(trace.audit.map(t => t.pairId)).size,
    auditCriterionCalls: trace.audit.filter(t => t.status !== "criterion_not_triggered").length,
    auditAccepted: trace.audit.filter(t => t.status === "reviewer_accepted" || t.status === "reviewer_needs_escalation").length,
    auditRejected: trace.audit.filter(t => t.status === "reviewer_rejected").length,
    auditNoDiff: trace.audit.filter(t => t.status === "auditor_no_diff").length,
    auditErrors: trace.audit.filter(t => t.status === "auditor_error" || t.status === "auditor_schema_error" || t.status === "reviewer_error" || t.status === "empty_evidence").length,
    coverageComponents: trace.coverage.length,
    coverageCovered: trace.coverage.filter(t => t.status === "covered_by_diff").length,
    coverageUncovered: trace.coverage.filter(t => t.status === "uncovered").length,
    coverageBelowThreshold: trace.coverage.filter(t => t.status === "below_threshold").length,
    recoveryAttempted: trace.recovery.filter(t => !t.status.startsWith("skipped_") && t.status !== "below_threshold").length,
    recoveryAccepted: trace.recovery.filter(t => t.status === "recovery_accepted" || t.status === "recovery_needs_escalation").length,
    recoveryRejected: trace.recovery.filter(t => t.status === "recovery_rejected").length,
    recoveryClassifiedFalse: trace.recovery.filter(t => t.status === "classified_false").length,
    recoveryErrors: trace.recovery.filter(t => [
      "recovery_error",
      "recovery_schema_error",
      "missing_required_fields",
      "box_out_of_bounds",
      "box_no_component_overlap"
    ].includes(t.status)).length,
    recoverySkipped: trace.recovery.filter(t => t.status.startsWith("skipped_") || t.status === "below_threshold").length
  };
  return RunDebugSummarySchema.parse(summary);
}

export async function writeRunDebugArtifacts(
  artifactDir: string,
  trace: RunDebugTrace
): Promise<{ summary: RunDebugSummary; artifacts: UiArtifact[] }> {
  await fs.mkdir(artifactDir, { recursive: true });
  const summary = summarizeRunDebug(trace);
  const files = [
    { role: "audit_trace" as const, path: path.join(artifactDir, "audit-trace.json"), data: trace.audit },
    { role: "coverage_trace" as const, path: path.join(artifactDir, "coverage-trace.json"), data: trace.coverage },
    { role: "recovery_trace" as const, path: path.join(artifactDir, "recovery-trace.json"), data: trace.recovery },
    { role: "debug_summary" as const, path: path.join(artifactDir, "debug-summary.json"), data: summary }
  ];
  for (const file of files) {
    await fs.writeFile(file.path, JSON.stringify(file.data, null, 2), "utf8");
  }
  return {
    summary,
    artifacts: files.map(f => ({ role: f.role, path: f.path }))
  };
}
```

- [ ] **Step 3: Add tests**

Create `tests/unit/run-debug.test.ts` with assertions:

```ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarizeRunDebug, writeRunDebugArtifacts } from "../../src/debug/run-debug.js";
import type { RunDebugTrace } from "../../src/debug/run-debug.js";

describe("run debug trace", () => {
  it("summarizes audit, coverage, and recovery outcomes", () => {
    const trace: RunDebugTrace = {
      audit: [
        { pairId: "p1", targetLabel: "card", targetType: "card", criterion: "geometry", status: "auditor_no_diff", evidenceCount: 0, imageRoles: [], artifactPaths: [] },
        { pairId: "p1", targetLabel: "card", targetType: "card", criterion: "color_appearance", status: "reviewer_accepted", evidenceCount: 2, diffId: "d1", imageRoles: [], artifactPaths: [] },
        { pairId: "p2", targetLabel: "label", targetType: "text", criterion: "typography_content", status: "reviewer_rejected", evidenceCount: 1, imageRoles: [], artifactPaths: [] }
      ],
      coverage: [
        { componentId: "c1", componentBox: { x: 0, y: 0, width: 10, height: 10 }, pixelCount: 100, status: "covered_by_diff", coveringDiffId: "d1", coveringCriterion: "color_appearance", overlapRatio: 1 },
        { componentId: "c2", componentBox: { x: 20, y: 0, width: 10, height: 10 }, pixelCount: 100, status: "uncovered" }
      ],
      recovery: [
        { componentId: "c2", rank: 0, componentBox: { x: 20, y: 0, width: 10, height: 10 }, pixelCount: 100, status: "classified_false", artifactPaths: [] }
      ]
    };
    const summary = summarizeRunDebug(trace);
    expect(summary.auditPairs).toBe(2);
    expect(summary.auditNoDiff).toBe(1);
    expect(summary.auditAccepted).toBe(1);
    expect(summary.auditRejected).toBe(1);
    expect(summary.coverageUncovered).toBe(1);
    expect(summary.recoveryClassifiedFalse).toBe(1);
  });

  it("writes four debug artifact files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-debug-"));
    const result = await writeRunDebugArtifacts(dir, { audit: [], coverage: [], recovery: [] });
    expect(result.artifacts.map(a => a.role).sort()).toEqual(["audit_trace", "coverage_trace", "debug_summary", "recovery_trace"]);
    await expect(fs.access(path.join(dir, "audit-trace.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "coverage-trace.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "recovery-trace.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "debug-summary.json"))).resolves.toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 4: Verify**

Run:

```powershell
npx vitest run tests/unit/run-debug.test.ts tests/unit/schemas.test.ts
```

Expected: both suites pass.

## Task 2: Audit Trace For Every Triggered Criterion

**Files:**
- Modify: `src/audit/audit-target.ts`
- Test: `tests/unit/audit.test.ts`

- [ ] **Step 1: Change return type**

Change `auditElementPair` to return:

```ts
Promise<{ accepted: DiffRecord[]; rejected: DiffRecord[]; trace: AuditCriterionTrace[] }>
```

Initialize `const trace: AuditCriterionTrace[] = [];` and return it in every early return.

- [ ] **Step 2: Record image roles once**

After the evidence images are assembled, define:

```ts
const imageRoles = [
  expectedCropB64 ? "expected_crop" : null,
  actualCropB64 ? "actual_crop" : null,
  localDirectionalOverlayB64 ? "local_directional_overlay" : null,
  localPixelDiffMaskB64 ? "local_pixel_diff_mask" : null,
  contextCropB64 ? "context_crop" : null
].filter((v): v is string => v !== null);
```

- [ ] **Step 3: Add a trace helper**

Inside `auditElementPair`, add:

```ts
function pushTrace(
  criterion: Exclude<UiCriterion, "unclassified_visual_change">,
  status: AuditCriterionTrace["status"],
  extra: Partial<AuditCriterionTrace> = {}
): void {
  trace.push({
    pairId: pair.id,
    ...(pair.expectedId !== undefined ? { expectedId: pair.expectedId } : {}),
    ...(pair.actualId !== undefined ? { actualId: pair.actualId } : {}),
    targetLabel: refEl.label,
    targetType: refEl.type,
    criterion,
    status,
    evidenceCount: 0,
    imageRoles,
    artifactPaths: auditArtifacts,
    ...extra
  });
}
```

Import `UiCriterion` and `AuditCriterionTrace` from `src/schemas/core.ts`.

- [ ] **Step 4: Record all loss points**

Before the criterion loop, record criteria that were not selected by deterministic triggers:

```ts
const triggeredCriteria = new Set(criteria);
const allClassifiableCriteria = UiCriterionSchema.options.filter(
  (c): c is Exclude<UiCriterion, "unclassified_visual_change"> => c !== "unclassified_visual_change"
);
for (const criterion of allClassifiableCriteria) {
  if (!triggeredCriteria.has(criterion)) {
    pushTrace(criterion, "criterion_not_triggered", {
      skipReason: "criterion not selected by deterministic trigger signals"
    });
  }
}
```

For each triggered criterion loop:

```ts
const started = Date.now();
try {
  const response = await ctx.auditorCaller(...);
  auditModel = response.model;
  auditResult = AuditResultSchema.parse(response.parsed);
} catch (err) {
  pushTrace(criterion, err instanceof z.ZodError ? "auditor_schema_error" : "auditor_error", {
    auditorDurationMs: Date.now() - started,
    model: auditModel,
    errorKind: err instanceof z.ZodError ? "schema" : "provider",
    errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500)
  });
  continue;
}

if (!auditResult.hasDiff) {
  pushTrace(criterion, "auditor_no_diff", {
    auditorDurationMs: Date.now() - started,
    model: auditModel,
    evidenceCount: auditResult.evidence?.length ?? 0
  });
  continue;
}

const evidence = auditResult.evidence ?? [];
if (evidence.length === 0) {
  pushTrace(criterion, "empty_evidence", {
    auditorDurationMs: Date.now() - started,
    model: auditModel
  });
  continue;
}
```

Before reviewer, capture auditor duration separately:

```ts
const auditorDurationMs = Date.now() - started;
const reviewerStarted = Date.now();
let reviewModel = "unknown";
let reviewReason: string | undefined;
```

When parsing the reviewer response, set:

```ts
reviewModel = reviewResponse.model;
reviewReason = parsed.reason;
const reviewerDurationMs = Date.now() - reviewerStarted;
```

After reviewer:

```ts
pushTrace(criterion, reviewDecision === "accepted" ? "reviewer_accepted" : reviewDecision === "rejected" ? "reviewer_rejected" : "reviewer_needs_escalation", {
  model: auditModel,
  reviewerModel: reviewModel,
  auditorDurationMs,
  reviewerDurationMs,
  evidenceCount: evidence.length,
  diffId: record.id,
  ...(reviewReason !== undefined ? { rejectionReason: reviewReason } : {})
});
```

- [ ] **Step 5: Add tests**

Extend `tests/unit/audit.test.ts`:

```ts
it("records auditor_no_diff when model returns hasDiff false", async () => {
  const auditorCaller = vi.fn().mockResolvedValue({ parsed: { hasDiff: false }, rawContent: "", model: "audit-model", provider: "nvidia" });
  const reviewerCaller = vi.fn();
  const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, reviewerCaller, boxDeltaPx: 15 }));
  expect(result.accepted).toHaveLength(0);
  expect(result.trace.some(t => t.status === "auditor_no_diff" && t.model === "audit-model")).toBe(true);
  expect(reviewerCaller).not.toHaveBeenCalled();
});

it("records empty_evidence when hasDiff true has no evidence", async () => {
  const auditorCaller = vi.fn().mockResolvedValue({ parsed: { hasDiff: true, title: "Bad" }, rawContent: "", model: "audit-model", provider: "nvidia" });
  const result = await auditElementPair(pair, makeAuditContext({ auditorCaller, boxDeltaPx: 15 }));
  expect(result.trace.some(t => t.status === "empty_evidence")).toBe(true);
});

it("records reviewer_rejected with reason", async () => {
  const result = await auditElementPair(pair, makeAuditContext({
    auditorCaller: vi.fn().mockResolvedValue({ parsed: { hasDiff: true, evidence: ["visible"], title: "Shift" }, rawContent: "", model: "audit-model", provider: "nvidia" }),
    reviewerCaller: vi.fn().mockResolvedValue({ parsed: { decision: "rejected", reason: "not supported" }, rawContent: "", model: "review-model", provider: "nvidia" }),
    boxDeltaPx: 15
  }));
  expect(result.trace.some(t => t.status === "reviewer_rejected" && t.rejectionReason === "not supported")).toBe(true);
});
```

If `makeAuditContext` does not exist in the current test file, extract the repeated context object in `tests/unit/audit.test.ts` into a local helper during this task.

- [ ] **Step 6: Verify**

Run:

```powershell
npx vitest run tests/unit/audit.test.ts
```

Expected: audit tests pass and existing accepted/rejected behavior is unchanged.

## Task 3: Coverage Trace Before And After Recovery

**Files:**
- Modify: `src/report/coverage.ts`
- Test: `tests/unit/coverage.test.ts`

- [ ] **Step 1: Add coverage tracing function**

Add:

```ts
import type { CoverageDecisionTrace } from "../schemas/core.js";

export function traceCoverageDecisions(
  components: PixelComponent[],
  diffs: DiffRecord[],
  minArea: number
): CoverageDecisionTrace[] {
  return components.map((component, index) => {
    const componentId = `component-${String(index + 1).padStart(4, "0")}`;
    if (component.pixelCount < minArea) {
      return { componentId, componentBox: component.box, pixelCount: component.pixelCount, status: "below_threshold" };
    }
    let best: { diff: DiffRecord; ratio: number } | undefined;
    for (const diff of diffs) {
      const overlap = intersect(component.box, diff.location);
      if (!overlap) continue;
      const ratio = (overlap.width * overlap.height) / (component.box.width * component.box.height);
      if (!best || ratio > best.ratio) best = { diff, ratio };
    }
    if (best && best.ratio >= 0.1) {
      return {
        componentId,
        componentBox: component.box,
        pixelCount: component.pixelCount,
        status: "covered_by_diff",
        coveringDiffId: best.diff.id,
        coveringCriterion: best.diff.criterion,
        overlapRatio: Number(best.ratio.toFixed(4))
      };
    }
    return { componentId, componentBox: component.box, pixelCount: component.pixelCount, status: "uncovered" };
  });
}
```

- [ ] **Step 2: Keep old behavior stable**

Refactor `findUncoveredComponents` to call `traceCoverageDecisions()` and return components whose decision is `uncovered`. Preserve the existing threshold behavior exactly.

- [ ] **Step 3: Add tests**

Add to `tests/unit/coverage.test.ts`:

```ts
it("traces covered component with covering diff id and overlap ratio", () => {
  const components = [makeComponent(0, 0, 100, 100, 900)];
  const diffs = [makeDiff(0, 0, 50, 100)];
  const trace = traceCoverageDecisions(components, diffs, 10);
  expect(trace[0]).toMatchObject({
    status: "covered_by_diff",
    coveringDiffId: diffs[0]!.id,
    coveringCriterion: "geometry",
    overlapRatio: 0.5
  });
});

it("traces below-threshold components instead of silently losing them", () => {
  const trace = traceCoverageDecisions([makeComponent(0, 0, 5, 5, 5)], [], 10);
  expect(trace[0]?.status).toBe("below_threshold");
});
```

- [ ] **Step 4: Verify**

Run:

```powershell
npx vitest run tests/unit/coverage.test.ts
```

Expected: coverage tests pass.

## Task 4: Recovery Trace For Every Component Decision

**Files:**
- Modify: `src/recovery/target-recovery.ts`
- Test: `tests/unit/target-recovery.test.ts`

- [ ] **Step 1: Extend return type**

Change `RecoveryResult`:

```ts
export interface RecoveryResult {
  recovered: DiffRecord[];
  unclassifiedCount: number;
  attemptedComponents: number;
  skippedComponents: number;
  stoppedReason: "none" | "component_cap" | "model_call_cap" | "deadline_exceeded";
  trace: RecoveryComponentTrace[];
  model?: string;
}
```

- [ ] **Step 2: Assign stable component ids**

Before filtering, build ranked entries:

```ts
const ranked = uncoveredComponents
  .map((component, originalIndex) => ({
    component,
    componentId: `component-${String(originalIndex + 1).padStart(4, "0")}`
  }))
  .sort(...existing sort...);
```

The trace must use the same component id as the coverage trace when both operate on the same ordered component list.

- [ ] **Step 3: Trace skipped and below-threshold components**

Add a `trace: RecoveryComponentTrace[] = [];`. Before processing, push:

```ts
for (const entry of ranked.filter(e => e.component.pixelCount < budget.minComponentPixels)) {
  trace.push({ componentId: entry.componentId, rank: -1, componentBox: entry.component.box, pixelCount: entry.component.pixelCount, status: "below_threshold", artifactPaths: [] });
}
```

When `eligible.length > budget.maxComponents`, push `skipped_component_cap` for entries after the cap. When the loop stops for deadline or model-call cap, push `skipped_deadline` or `skipped_model_call_cap` for the remaining unattempted entries.

- [ ] **Step 4: Trace every attempted outcome**

After artifacts are written, build:

```ts
const baseTrace = {
  componentId,
  rank,
  componentBox: box,
  pixelCount: component.pixelCount,
  artifactPaths: artifacts
};
```

Then push one terminal status for each component:

- `classified_false` when `{ classified: false }`.
- `recovery_error` when the provider call throws.
- `recovery_schema_error` when Zod parse fails.
- `missing_required_fields` when `classified: true` is missing criterion, label, box, evidence, or coordinateFrame.
- `box_out_of_bounds` when the returned box is outside the image.
- `box_no_component_overlap` when the returned box does not overlap the component.
- `recovery_rejected` when the reviewer rejects.
- `recovery_accepted` or `recovery_needs_escalation` when a diff is emitted.

Record `model`, `reviewerModel`, `recoveryDurationMs`, `reviewerDurationMs`, `criterion`, and `diffId` where available.

- [ ] **Step 5: Add tests**

Extend `tests/unit/target-recovery.test.ts`:

```ts
it("traces classified_false as an attempted no-regression verdict", async () => {
  const result = await runTargetRecovery([component], makeCtx(), unlimitedBudget);
  expect(result.trace[0]).toMatchObject({ status: "classified_false", pixelCount: component.pixelCount });
});

it("traces reviewer rejection", async () => {
  const result = await runTargetRecovery([component], makeCtx({
    recoveryCaller: vi.fn().mockResolvedValue({
      parsed: { classified: true, criterion: "geometry", severity: "medium", label: "Button", coordinateFrame: "expected", box: component.box, evidence: ["visible"] },
      rawContent: "", model: "recovery-model", provider: "nvidia"
    }),
    reviewerCaller: vi.fn().mockResolvedValue({
      parsed: { decision: "rejected", reason: "not supported" },
      rawContent: "", model: "review-model", provider: "nvidia"
    })
  }), unlimitedBudget);
  expect(result.trace[0]).toMatchObject({ status: "recovery_rejected", model: "recovery-model", reviewerModel: "review-model" });
});

it("traces skipped components caused by cap", async () => {
  const components = Array.from({ length: 3 }, (_, i) => ({ box: { x: i * 20, y: 0, width: 10, height: 10 }, pixelCount: 100 }));
  const result = await runTargetRecovery(components, makeCtx(), { maxComponents: 1, maxModelCalls: 10, deadlineMs: Date.now() + 300000, minComponentPixels: 1 });
  expect(result.trace.filter(t => t.status === "skipped_component_cap")).toHaveLength(2);
});
```

- [ ] **Step 6: Verify**

Run:

```powershell
npx vitest run tests/unit/target-recovery.test.ts
```

Expected: target recovery tests pass.

## Task 5: Pipeline Aggregation And Report Artifacts

**Files:**
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/report/report-writer.ts`
- Modify: `src/schemas/tool-schemas.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`
- Test: `tests/unit/report-writer.test.ts`

- [ ] **Step 1: Aggregate audit traces**

In `run-ui-diff.ts`, import:

```ts
import { traceCoverageDecisions } from "../report/coverage.js";
import { writeRunDebugArtifacts, type RunDebugTrace } from "../debug/run-debug.js";
```

Create:

```ts
const debugTrace: RunDebugTrace = { audit: [], coverage: [], recovery: [] };
```

When calling `auditElementPair`:

```ts
const { accepted, trace } = await auditElementPair(pair, ctx);
debugTrace.audit.push(...trace);
auditedDiffs.push(...accepted);
```

- [ ] **Step 2: Write coverage trace before recovery**

Replace:

```ts
const uncoveredComponents = findUncoveredComponents(significantComponents, allDiffs, 50);
```

with:

```ts
debugTrace.coverage = traceCoverageDecisions(significantComponents, allDiffs, 50);
const uncoveredComponents = significantComponents.filter((_, index) => debugTrace.coverage[index]?.status === "uncovered");
```

This keeps the same component order so coverage and recovery component ids line up.

- [ ] **Step 3: Add recovery traces**

After recovery:

```ts
debugTrace.recovery.push(...recoveryResult.trace);
```

- [ ] **Step 4: Write debug artifacts before final report**

Before constructing the final `report`, call:

```ts
const debugArtifactsResult = await writeRunDebugArtifacts(artifactRoot, debugTrace);
runArtifacts.push(...debugArtifactsResult.artifacts);
```

Add to `report`:

```ts
debugSummary: debugArtifactsResult.summary,
```

Also include the debug artifacts in checkpoint reports only after the debug artifact call exists; checkpoints before final report can omit them.

- [ ] **Step 5: Compact output and report writer**

In `src/report/report-writer.ts`, add `debugSummary?: RunDebugSummary` to `CompactOutput` and return it when present. Include `debugSummary` in `src/schemas/tool-schemas.ts` output schemas using `RunDebugSummarySchema.optional()`.

- [ ] **Step 6: Add E2E assertions**

Extend `tests/e2e/compare-ui-images.test.ts`:

```ts
expect(report.debugSummary).toBeDefined();
expect(report.runArtifacts.some(a => a.role === "audit_trace")).toBe(true);
expect(report.runArtifacts.some(a => a.role === "coverage_trace")).toBe(true);
expect(report.runArtifacts.some(a => a.role === "recovery_trace")).toBe(true);
expect(report.runArtifacts.some(a => a.role === "debug_summary")).toBe(true);
expect(report.debugSummary.auditPairs).toBe(report.auditScope?.auditedPairs ?? 0);
```

- [ ] **Step 7: Verify**

Run:

```powershell
npm run verify
```

Expected: unit, sidecar, build, and integration tests pass.

## Task 6: Release Gate Uses Debug Evidence

**Files:**
- Modify: `tests/live/calorix-smoke.live.test.ts`
- Modify: `docs/release/production-readiness-checklist.md`
- Modify: `docs/implementation-status.md`

- [ ] **Step 1: Tighten live Calorix assertions**

In both bounded and full Calorix live tests, after loading `report`, assert:

```ts
expect(report.debugSummary, "debug summary must be written").toBeDefined();
expect(report.runArtifacts.some(a => a.role === "audit_trace"), "audit trace artifact must exist").toBe(true);
expect(report.runArtifacts.some(a => a.role === "coverage_trace"), "coverage trace artifact must exist").toBe(true);
expect(report.runArtifacts.some(a => a.role === "recovery_trace"), "recovery trace artifact must exist").toBe(true);
```

For the full audit only, also assert:

```ts
expect(report.debugSummary?.auditPairs ?? 0).toBeGreaterThan(0);
expect(report.debugSummary?.auditCriterionCalls ?? 0).toBeGreaterThan(0);
expect(report.debugSummary?.coverageComponents ?? 0).toBeGreaterThan(0);
```

- [ ] **Step 2: Document the gate**

Add to `docs/release/production-readiness-checklist.md`:

```md
### Debug Insight Gate

A production sign-off run must include `debugSummary`, `audit-trace.json`,
`coverage-trace.json`, and `recovery-trace.json`. The traces must explain every
auditor/reviewer/recovery loss point using structured statuses. A run that only
reports final diff counts without these traces is not acceptable for Calorix sign-off.
```

- [ ] **Step 3: Update implementation status**

Set `docs/implementation-status.md` current task to this plan while implementing, then record the verification command and commit hash after completion.

- [ ] **Step 4: Verify**

Run deterministic verification:

```powershell
npm run verify
npm run test:coverage
```

Expected: all tests pass and coverage thresholds remain above configured minimums.

Live verification after implementation, before production sign-off:

```powershell
$env:RUN_CALORIX_UI_DIFF_LIVE="1"
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-09-criterion-audit-validation.png"
$env:LOCATEANYTHING_EAGLE_EMBODIED_DIR="C:\Users\xursc\projects\Eagle\Embodied"
npm run verify:calorix-live
```

Expected: the run passes or fails with enough trace detail to explain the result.

## Acceptance Checks

- `report.json` contains `debugSummary`.
- `artifacts/audit-trace.json` explains every triggered audit criterion outcome.
- `artifacts/coverage-trace.json` explains every significant pixel component as below-threshold, covered by a named diff, or uncovered.
- `artifacts/recovery-trace.json` explains every recovery candidate as accepted, rejected, classified false, validation failed, model failed, or skipped by a named budget.
- MCP compact output includes `debugSummary`.
- Calorix live tests require debug artifacts before future sign-off.
- No trace contains API keys, base64 image data, full prompt bodies, or root-cause/code-change recommendations.
- No manual target config, ROI config, ignore mask, or human inspection step is introduced.

## Self-Review

- Spec coverage: this plan directly addresses the lost-diff insight gap for target-pair audit, pixel coverage, and recovery.
- Placeholder scan: no `TBD`, no `TODO`, and no “similar to” tasks remain.
- Type consistency: schema names match task snippets: `AuditCriterionTrace`, `CoverageDecisionTrace`, `RecoveryComponentTrace`, `RunDebugSummary`, and `RunDebugTrace`.
- Product boundary: the plan adds automated diagnostics only; it does not add causality explanations or implementation advice.

## Gemini Review

Gemini 3.1 Pro Preview review:

- `AGREEMENT_STATUS: agree`
- `MUST_FIX: none`
- `SHOULD_FIX: none`
- Notes incorporated: make auditor/reviewer timing unambiguous. The plan now uses `auditorDurationMs`, `recoveryDurationMs`, and `reviewerDurationMs` instead of a generic `durationMs`.
- Additional self-fix after review: the plan now requires `criterion_not_triggered` trace rows so the report explains both model losses and deterministic criteria that were never sent to the auditor.
