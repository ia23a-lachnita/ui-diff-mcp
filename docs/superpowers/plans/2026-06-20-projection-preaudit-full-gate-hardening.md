# Projection Pre-Audit And Full Gate Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix projection-aware comparison, audit accounting, report truth, and release gates so the next Calorix full live run produces trustworthy production-readiness evidence.

**Architecture:** Move projected-crop mismatch detection out of `auditElementPair()` into an explicit deterministic pre-audit stage. Projected crops from different source sizes must be compared after normalizing comparison dimensions; crop size difference by itself is metadata, not a diff. The VLM audit budget must count only pairs that actually reach the auditor/reviewer model path.

**Tech Stack:** TypeScript ESM, Vitest, Sharp for artifact I/O, existing RGBA buffer utilities, Zod report schemas, current MCP live gate scripts.

## Global Constraints

- Do not use user-authored target maps, ROI maps, ignore masks, anchor dumps, or manual screen config.
- Do not suggest app-code changes, MCP config changes, or root-cause explanations in final diff records.
- Keep projection mode as the default Calorix path; do not restore dual locator as the normal gate path.
- Do not treat expected/actual crop dimension mismatch as visual absence. Different crop dimensions are expected when projecting between different screen sizes.
- Every final diff record must have a `classificationSource`.
- Bounded smoke gates are diagnostic only. Release readiness requires `verify:calorix-full-live` and `verify:calorix-release-live`.
- Commit and push after each implementation task, including status-file updates.

---

## Current Evidence To Correct

Latest inspected run:

`C:\Users\xursc\projects\calorix\.ui-diff\runs\run-1781962032076-14decb\artifacts\report.json`

Facts from that run:

- `status: "complete"`
- `locatorCoverageStatus: "complete"`
- `auditScope.auditedPairs: 3`
- `auditScope.totalPairs: 79`
- `auditScope.auditLimited: true`
- auditor routes were selected and auditor probes passed
- the 3 bounded audit pairs became `deterministic_projected_mismatch`
- recovery ran and left `recoverySummary.unclassifiedCount: 5`
- 100 final diffs existed: 79 `geometry`, 3 `presence`, 18 `unclassified_visual_change`
- 97 diffs had no `classificationSource`

The current status file incorrectly says the bounded run failed because no audit calls started and all auditor probes failed. That must be corrected before more live gates are interpreted.

## File Structure

- Modify `docs/implementation-status.md`: correct June 20 run facts and current blockers.
- Modify `docs/superpowers/plans/2026-06-18-model-diagnostics-recovery-projection-hardening.md`: mark bounded Calorix diagnostic as run with the correct result; keep full/release unchecked.
- Modify `src/diff/deterministic-diffs.ts`: add `classificationSource: "deterministic_geometry"` to geometry records and `classificationSource: "deterministic_presence"` to missing/extra records.
- Create `src/images/crop.ts`: own shared RGBA crop extraction and Sharp/Lanczos comparison resizing.
- Modify `src/audit/projected-mismatch.ts`: normalize different-sized projected crops before comparison; remove dimension-only mismatch behavior.
- Create `src/diff/projected-preaudit.ts`: deterministic projected-pair classifier that runs before VLM audit selection.
- Modify `src/audit/audit-target.ts`: remove projected-mismatch early return and keep it focused on VLM criteria.
- Modify `src/pipeline/run-ui-diff.ts`: run projected pre-audit before audit selection; make `auditScope.auditedPairs` count only pairs that reached VLM audit.
- Modify `src/schemas/core.ts`: add pre-audit and recovery reason-count report fields.
- Modify `src/recovery/target-recovery.ts`: record recovery outcome counts in `recoverySummary`.
- Modify `src/report/report-writer.ts` only if report output filtering drops new schema fields.
- Modify `tests/unit/projected-mismatch.test.ts`: cover resized comparison for projected crops.
- Modify `tests/unit/audit.test.ts`: assert projected mismatch no longer happens inside `auditElementPair()`.
- Modify or create `tests/unit/projected-preaudit.test.ts`: cover pre-audit classification and budget accounting input.
- Modify `tests/unit/deterministic-diffs.test.ts` or existing deterministic diff tests: assert `deterministic_geometry` and `deterministic_presence`.
- Modify `tests/live/calorix-smoke.live.test.ts`: harden gate assertions around pre-audit counts, VLM-audited counts, and classification sources.
- Modify `docs/release/production-readiness-checklist.md`: clarify the required sequence for the next full live gates.

---

## Task 1: Correct Run Truth And Tracking

**Files:**
- Modify: `docs/implementation-status.md`
- Modify: `docs/superpowers/plans/2026-06-18-model-diagnostics-recovery-projection-hardening.md`

**Interfaces:**
- Consumes: factual run evidence from `run-1781962032076-14decb`
- Produces: handoff state that does not claim sidecar unavailable or all auditor probes failed for the June 20 bounded run

- [x] **Step 1: Update current-state text**

Replace the stale Current State bullets in `docs/implementation-status.md` with text equivalent to:

```markdown
- Status: **Projection pre-audit hardening plan drafted.** Latest bounded Calorix run `run-1781962032076-14decb` completed with locator coverage complete and selected auditor routes, but it was limited to 3/79 pairs and produced no accepted semantic VLM diffs. Production release remains blocked until projection pre-audit, classification-source coverage, and full/release live gates are fixed and re-run.
- Current task: **Plan `docs/superpowers/plans/2026-06-20-projection-preaudit-full-gate-hardening.md` drafted for review. Next implementation must start at Task 1 and keep this status file synchronized.**
- Last verification: `npm run verify` — 397 unit/e2e + 22 integration tests pass, typecheck clean, build clean (2026-06-19). Live gates run 2026-06-20: NVIDIA 4/4 PASS; MCP 1/1 PASS; OpenRouter-free failed due free route limits; Calorix bounded run `run-1781962032076-14decb` completed as a diagnostic smoke run with `auditLimited:true`, `auditedPairs:3`, `totalPairs:79`, `visualClassificationStatus:"incomplete"`, and `recoverySummary.unclassifiedCount:5`; Calorix full/release were not freshly completed.
- Open blockers: **Production release blocked** - projected crop dimension mismatch currently creates false deterministic presence diffs before VLM review, deterministic geometry diffs lack `classificationSource`, and full/release Calorix gates must be re-run after this plan.
```

- [x] **Step 2: Add a progress-log entry**

Append this row near the newest June 20 entries:

```markdown
| 2026-06-20 | this commit | Projection pre-audit hardening plan | Plan only; no code verification required beyond `git diff --check` | Corrects the interpretation of `run-1781962032076-14decb`: sidecar and locator worked, auditor routes were selected, bounded smoke was limited to 3/79 pairs, projected dimension-only mismatch short-circuited all 3 VLM audit slots, recovery left 5 unclassified components. |
```

- [x] **Step 3: Update the older hardening plan checkboxes**

In `docs/superpowers/plans/2026-06-18-model-diagnostics-recovery-projection-hardening.md`, change Task 7 Step 3 from "not yet run" to a checked diagnostic result:

```markdown
- [x] **Step 3: Run Calorix diagnostic gates** *(bounded diagnostic ran on 2026-06-20 as `run-1781962032076-14decb`; result is not release evidence because `auditLimited:true`, `visualClassificationStatus:"incomplete"`, and projected dimension-only mismatch consumed all 3 VLM audit slots)*
```

Keep Step 4 unchecked:

```markdown
- [ ] **Step 4: Run release gate** *(not yet run successfully after projection pre-audit hardening)*
```

- [x] **Step 4: Verify and commit**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only the two docs files are changed.

Commit and push:

```powershell
git add docs/implementation-status.md docs/superpowers/plans/2026-06-18-model-diagnostics-recovery-projection-hardening.md
git commit -m "docs(status): correct June 20 Calorix gate facts"
git push
```

## Task 2: Tag All Deterministic Diffs With Classification Source

**Files:**
- Modify: `src/diff/deterministic-diffs.ts`
- Modify: `tests/unit/deterministic-diffs.test.ts` or the existing test file that covers `buildDeterministicDiffs`
- Modify: `tests/live/calorix-smoke.live.test.ts`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Consumes: `DiffRecordSchema.classificationSource`
- Produces: geometry records carry `deterministic_geometry`; missing/extra records carry `deterministic_presence`

- [x] **Step 1: Write the failing unit test**

Add or update a unit test so it asserts every geometry diff from `buildDeterministicDiffs()` has the source:

```ts
expect(diffs).toContainEqual(expect.objectContaining({
  criterion: "geometry",
  model: "deterministic",
  reviewerStatus: "accepted",
  classificationSource: "deterministic_geometry"
}));

expect(diffs).toContainEqual(expect.objectContaining({
  criterion: "presence",
  model: "deterministic",
  reviewerStatus: "accepted",
  classificationSource: "deterministic_presence"
}));
```

Run:

```powershell
npx vitest run tests/unit --runInBand
```

Expected: the new assertion fails because geometry records currently have no `classificationSource`.

- [x] **Step 2: Extend the source enum and implement precise source tags**

In `src/schemas/core.ts`, add the new source value:

```ts
"deterministic_presence",
```

In `src/diff/deterministic-diffs.ts`, add this property to deterministic geometry `DiffRecord` objects:

```ts
classificationSource: "deterministic_geometry",
```

Tag missing/extra deterministic presence records as:

```ts
classificationSource: "deterministic_presence",
```

Do not leave deterministic records untagged or classify presence records as geometry.

- [x] **Step 3: Harden the live release assertion**

In `tests/live/calorix-smoke.live.test.ts`, add an unconditional check before viewport-specific checks:

```ts
const untaggedAcceptedDiffs = report.diffs.filter(d =>
  d.reviewerStatus !== "rejected" && !d.classificationSource
);
expect(
  untaggedAcceptedDiffs.length,
  "release gate must not pass with accepted diffs missing classificationSource"
).toBe(0);
```

Extend the viewport-mismatch `unsafeDiffs` allowlist with:

```ts
d.classificationSource !== "deterministic_presence"
```

so correctly tagged missing/extra records are accepted by the same release contract as deterministic geometry records.

- [x] **Step 4: Verify and commit**

Run:

```powershell
npm run verify
```

Expected: all tests pass and deterministic geometry source is covered.

Update `docs/implementation-status.md` current task and progress log, then commit and push:

```powershell
git add src/diff/deterministic-diffs.ts tests docs/implementation-status.md
git commit -m "fix(report): tag deterministic geometry diffs"
git push
```

## Task 3: Normalize Projected Crop Comparison

**Files:**
- Create: `src/images/crop.ts`
- Modify: `src/audit/projected-mismatch.ts`
- Modify: `tests/unit/projected-mismatch.test.ts`
- Modify: `src/schemas/core.ts` only if measurement names or reasons need schema updates
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Consumes: `await detectProjectedCropMismatch(expected, actual, expectedText?)`
- Produces: dimension differences become comparison metadata; mismatch is decided from Sharp/Lanczos-normalized pixel, edge, color, and optional text signals

- [x] **Step 1: Write failing tests for projected size differences**

Add tests that prove crop size difference alone does not create a mismatch:

```ts
it("does not treat projected crop dimension difference as mismatch by itself", async () => {
  const expected = makeSolidCrop(100, 100, [30, 40, 50, 255]);
  const actual = makeSolidCrop(50, 50, [30, 40, 50, 255]);

  const result = await detectProjectedCropMismatch(expected, actual);

  expect(result?.mismatched ?? false).toBe(false);
});

it("detects real content mismatch after resizing projected crop for comparison", async () => {
  const expected = makeCropWithCenteredRect(100, 100, [30, 40, 50, 255], [0, 220, 220, 255]);
  const actual = makeSolidCrop(50, 50, [30, 40, 50, 255]);

  const result = await detectProjectedCropMismatch(expected, actual);

  expect(result?.mismatched).toBe(true);
  expect(result?.reason).not.toBe("projection_dimension_mismatch");
  expect(result?.changedPercent ?? 0).toBeGreaterThan(10);
});
```

Use local helper functions in the test file to create RGBA buffers. Do not use image files for these unit tests.

- [x] **Step 2: Create shared crop helpers and replace dimension-only mismatch**

Move the existing local `extractImageCrop` implementation from `src/audit/audit-target.ts` into a new focused module, `src/images/crop.ts`. Export it with the existing signature:

```ts
export function extractImageCrop(
  imageData: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  box: Box
): Uint8Array;
```

Update `src/audit/audit-target.ts` to import this helper from `../images/crop.js`. Add a unit test using a 4x4 RGBA buffer and a 2x2 box to prove the moved helper preserves the exact source pixels.

In `src/audit/projected-mismatch.ts`, remove this behavior:

```ts
if (expected.width !== actual.width || expected.height !== actual.height) {
  return {
    mismatched: true,
    reason: "projection_dimension_mismatch",
    changedPercent: 100,
    expectedDominant,
    actualDominant,
  };
}
```

Add a Sharp-based comparison resize to `src/images/crop.ts`:

```ts
export async function resizeRgbaForComparison(
  input: { data: Uint8Array; width: number; height: number },
  width: number,
  height: number
): Promise<Uint8Array> {
  const resized = await sharp(Buffer.from(input.data), {
    raw: { width: input.width, height: input.height, channels: 4 }
  })
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer();
  return new Uint8Array(resized);
}
```

Make `detectProjectedCropMismatch` asynchronous and compare at expected crop dimensions:

```ts
const comparisonActualData =
  expected.width === actual.width && expected.height === actual.height
    ? actual.data
    : await resizeRgbaForComparison(actual, expected.width, expected.height);

const comparisonActual = {
  data: comparisonActualData,
  width: expected.width,
  height: expected.height
};
```

Then run `computeChangedPercent`, edge overlap, and palette comparison against `expected` and `comparisonActual`.

Sharp/Lanczos is required here because nearest-neighbor downscaling can create artificial edge and pixel differences in UI text, rings, and icons. Original expected/actual crop artifacts remain untouched; resizing is comparison-only.

- [x] **Step 3: Rename dimension reason use**

Keep `projection_dimension_mismatch` in the schema for backward compatibility with old reports, but do not emit it for new deterministic mismatches. If dimensions differ and normalized comparison is inconclusive, return:

```ts
return { mismatched: false, reason: "projected_crop_high_diff_mass", changedPercent, expectedDominant, actualDominant };
```

The reason value in a non-mismatch return is diagnostic only and must not become a final diff.

- [x] **Step 4: Verify and commit**

Run:

```powershell
npx vitest run tests/unit/projected-mismatch.test.ts
npm run verify
```

Expected: projected size-only test passes; real content mismatch test passes.

Update status, commit, and push:

```powershell
git add src/audit/projected-mismatch.ts tests/unit/projected-mismatch.test.ts docs/implementation-status.md
git commit -m "fix(projection): compare resized projected crops"
git push
```

## Task 4: Move Projected Mismatch To Pre-Audit Stage

**Files:**
- Create: `src/diff/projected-preaudit.ts`
- Modify: `src/images/crop.ts`
- Modify: `src/audit/audit-target.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/schemas/core.ts`
- Create or modify: `tests/unit/projected-preaudit.test.ts`
- Modify: `tests/unit/audit.test.ts`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Consumes: `ElementPair[]`, expected/actual element maps, expected/actual RGBA buffers, `detectProjectedCropMismatch`
- Produces: `ProjectedPreAuditResult` and deterministic projected diff records before VLM audit selection

- [x] **Step 1: Add pre-audit schema fields**

In `src/schemas/core.ts`, add:

```ts
export const ProjectedPreAuditSummarySchema = z.object({
  projectedPairsChecked: z.number().int().nonnegative(),
  deterministicProjectedDiffs: z.number().int().nonnegative(),
  sentToVlmPairs: z.number().int().nonnegative(),
  skippedFromVlmPairIds: z.array(z.string()).default([])
});
export type ProjectedPreAuditSummary = z.infer<typeof ProjectedPreAuditSummarySchema>;
```

Add optional field to `UiDiffReportSchema`:

```ts
projectedPreAudit: ProjectedPreAuditSummarySchema.optional(),
```

Extend `AuditScopeSchema` with optional VLM-specific fields:

```ts
vlmAuditedPairs: z.number().int().nonnegative().optional(),
preAuditDeterministicPairs: z.number().int().nonnegative().optional(),
```

- [x] **Step 2: Create projected pre-audit module**

Create `src/diff/projected-preaudit.ts`:

```ts
import crypto from "node:crypto";
import type { DiffRecord, ElementPair, UiElement } from "../schemas/core.js";
import { detectProjectedCropMismatch } from "../audit/projected-mismatch.js";
import { extractImageCrop } from "../images/crop.js";

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface ProjectedPreAuditResult {
  diffs: DiffRecord[];
  skipVlmPairIds: Set<string>;
  summary: {
    projectedPairsChecked: number;
    deterministicProjectedDiffs: number;
    sentToVlmPairs: number;
    skippedFromVlmPairIds: string[];
  };
}

export async function runProjectedPreAudit(input: {
  pairs: ElementPair[];
  expectedElements: UiElement[];
  actualElements: UiElement[];
  expectedRgba: RgbaImage;
  actualRgba: RgbaImage;
}): Promise<ProjectedPreAuditResult> {
  const expectedById = new Map(input.expectedElements.map(e => [e.id, e]));
  const actualById = new Map(input.actualElements.map(e => [e.id, e]));
  const diffs: DiffRecord[] = [];
  const skipVlmPairIds = new Set<string>();
  let projectedPairsChecked = 0;
  let sentToVlmPairs = 0;

  for (const pair of input.pairs) {
    if (!pair.expectedId || !pair.actualId) continue;
    const expected = expectedById.get(pair.expectedId);
    const actual = actualById.get(pair.actualId);
    if (!expected || !actual || actual.source !== "projected") continue;

    projectedPairsChecked += 1;
    const expectedCrop = extractImageCrop(input.expectedRgba.data, input.expectedRgba.width, input.expectedRgba.height, expected.box);
    const actualCrop = extractImageCrop(input.actualRgba.data, input.actualRgba.width, input.actualRgba.height, actual.box);
    const result = await detectProjectedCropMismatch(
      { data: expectedCrop, width: Math.max(1, Math.round(expected.box.width)), height: Math.max(1, Math.round(expected.box.height)) },
      { data: actualCrop, width: Math.max(1, Math.round(actual.box.width)), height: Math.max(1, Math.round(actual.box.height)) },
      expected.text
    );

    if (result?.mismatched) {
      skipVlmPairIds.add(pair.id);
      diffs.push({
        id: crypto.randomBytes(6).toString("hex"),
        pairId: pair.id,
        criterion: "presence",
        severity: "high",
        title: `Expected target absent or mismatched at projected location: ${expected.label}`,
        location: actual.box,
        evidence: [
          "Projected expected crop did not match the actual source crop after normalized comparison.",
          `reason=${result.reason}, changedPercent=${result.changedPercent.toFixed(1)}`
        ],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "accepted",
        model: "deterministic",
        classificationSource: "deterministic_projected_mismatch",
        projectionMismatchReason: result.reason
      });
    } else {
      sentToVlmPairs += 1;
    }
  }

  return {
    diffs,
    skipVlmPairIds,
    summary: {
      projectedPairsChecked,
      deterministicProjectedDiffs: diffs.length,
      sentToVlmPairs,
      skippedFromVlmPairIds: [...skipVlmPairIds]
    }
  };
}
```

Task 3 already moves and exports `extractImageCrop` from `src/images/crop.ts`. This task must import that shared helper and must not duplicate crop math.

- [x] **Step 3: Remove audit-path projected early return**

In `src/audit/audit-target.ts`, remove the block that checks `actualEl?.source === "projected"` and returns before auditor/reviewer calls. Keep crop artifact writing for normal audit calls.

Add a unit test asserting a projected actual element still invokes the mocked auditor when pre-audit has not removed the pair.

- [x] **Step 4: Wire pre-audit before audit selection**

In `src/pipeline/run-ui-diff.ts`, after deterministic geometry diffs and before audit pair selection, add:

```ts
const projectedPreAudit = await runProjectedPreAudit({
  pairs,
  expectedElements,
  actualElements,
  expectedRgba,
  actualRgba
});
allDiffs.push(...projectedPreAudit.diffs);

const vlmCandidatePairs = pairs.filter(pair => !projectedPreAudit.skipVlmPairIds.has(pair.id));
```

Use `vlmCandidatePairs` for any `UI_DIFF_MAX_AUDIT_PAIRS` limit. Do not use the original `pairs` array for VLM budget selection.

When writing `auditScope`, set:

```ts
auditScope = {
  auditedPairs: auditSelection.pairs.length,
  vlmAuditedPairs: auditSelection.pairs.length,
  totalPairs: pairs.length,
  auditLimited: auditSelection.limited,
  preAuditDeterministicPairs: projectedPreAudit.diffs.length,
  ...(auditSelection.warning ? { limitReason: auditSelection.warning } : {})
};
```

Write `projectedPreAudit: projectedPreAudit.summary` into `UiDiffReport`.

- [x] **Step 5: Add pre-audit unit tests**

Create `tests/unit/projected-preaudit.test.ts` with these cases:

```ts
it("does not consume VLM budget for a definite projected mismatch", async () => {
  const result = await runProjectedPreAudit(makeProjectedMismatchFixture());
  expect(result.diffs).toHaveLength(1);
  expect(result.skipVlmPairIds).toContain("pair-1");
  expect(result.summary.deterministicProjectedDiffs).toBe(1);
});

it("sends dimension-only projected pairs to VLM instead of creating absence diffs", async () => {
  const result = await runProjectedPreAudit(makeSameContentDifferentScaleFixture());
  expect(result.diffs).toHaveLength(0);
  expect(result.skipVlmPairIds.size).toBe(0);
  expect(result.summary.sentToVlmPairs).toBe(1);
});
```

- [x] **Step 6: Verify and commit**

Run:

```powershell
npx vitest run tests/unit/projected-preaudit.test.ts tests/unit/audit.test.ts
npm run verify
```

Expected: projected pre-audit tests pass; audit tests prove projected pairs can reach the mocked auditor.

Update status, commit, and push:

```powershell
git add src/diff/projected-preaudit.ts src/audit/audit-target.ts src/pipeline/run-ui-diff.ts src/schemas/core.ts tests docs/implementation-status.md
git commit -m "fix(audit): move projected mismatch to pre-audit"
git push
```

## Task 5: Improve Recovery Outcome Reporting

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/recovery/target-recovery.ts`
- Modify: `src/pipeline/run-ui-diff.ts` if summary construction lives there
- Modify: `tests/unit/target-recovery.test.ts` or the existing recovery unit test file
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Consumes: recovery trace statuses such as `missing_required_fields`, `box_no_component_overlap`, `classified_false`, `below_threshold`
- Produces: machine-readable status counts in `report.recoverySummary`

- [x] **Step 1: Extend recovery summary schema**

In `src/schemas/core.ts`, extend `RecoverySummarySchema` with:

```ts
statusCounts: z.record(z.string(), z.number().int().nonnegative()).default({})
```

Keep existing fields unchanged.

- [x] **Step 2: Populate status counts**

In the recovery implementation, increment counts for every component outcome:

```ts
function incrementStatusCount(counts: Record<string, number>, status: string): void {
  counts[status] = (counts[status] ?? 0) + 1;
}
```

The latest run should become expressible as:

```json
{
  "statusCounts": {
    "below_threshold": 1,
    "missing_required_fields": 1,
    "box_no_component_overlap": 4,
    "classified_false": 2
  }
}
```

The exact counts in tests can use a fixture; they do not need to match Calorix.

- [x] **Step 3: Add recovery summary tests**

Add a unit test that feeds mocked recovery outcomes and asserts the summary includes all outcome counts.

- [x] **Step 4: Verify and commit**

Run:

```powershell
npx vitest run tests/unit/*recovery*.test.ts
npm run verify
```

Expected: recovery summary tests pass and report schema accepts `statusCounts`.

Update status, commit, and push:

```powershell
git add src/schemas/core.ts src/recovery src/pipeline tests docs/implementation-status.md
git commit -m "feat(report): summarize recovery outcome statuses"
git push
```

## Task 6: Harden Live Gate Semantics

**Files:**
- Modify: `tests/live/calorix-smoke.live.test.ts`
- Modify: `docs/release/production-readiness-checklist.md`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Consumes: `auditScope`, `projectedPreAudit`, `visualClassificationStatus`, `classificationSource`, `recoverySummary.statusCounts`
- Produces: gates that distinguish bounded diagnostics from full/release evidence

- [x] **Step 1: Update bounded smoke assertions**

In the bounded smoke test, assert:

```ts
expect(report.auditScope?.auditLimited).toBe(true);
expect(report.auditScope?.totalPairs ?? 0).toBeGreaterThan(0);
expect(report.projectedPreAudit).toBeDefined();
expect(report.auditScope?.vlmAuditedPairs ?? report.auditScope?.auditedPairs ?? 0)
  .toBeGreaterThan(0);
```

If `UI_DIFF_MAX_AUDIT_PAIRS=3`, the smoke gate must fail when all 3 slots are consumed by pre-audit deterministic records without a VLM audit. This catches the exact June 20 issue.

- [x] **Step 2: Update full gate assertions**

In the full live test, assert:

```ts
expect(report.auditScope?.auditLimited ?? false).toBe(false);
const vlmAuditedPairs = report.auditScope?.vlmAuditedPairs ?? report.auditScope?.auditedPairs ?? 0;
const preAuditDeterministicPairs = report.auditScope?.preAuditDeterministicPairs ?? 0;
expect(vlmAuditedPairs + preAuditDeterministicPairs)
  .toBe(report.auditScope?.totalPairs);
expect(report.diffs.filter(d => d.reviewerStatus !== "rejected" && !d.classificationSource))
  .toHaveLength(0);
```

This accounting proves every pair was handled by exactly one path: deterministic pre-audit or VLM audit. A true projected deterministic mismatch must not make the full gate fail merely because it correctly bypassed VLM review.

The full diagnostic gate may still allow `visualClassificationStatus: "incomplete"` only when provider diagnostics explain model unavailability. It must not pass if incompleteness is caused by accounting or projection-precheck bugs.

- [x] **Step 3: Update release gate assertions**

In the release gate, require:

```ts
expect(report.status).toBe("complete");
expect(report.visualClassificationStatus).toBe("complete");
expect(report.auditScope?.auditLimited ?? false).toBe(false);
expect(report.recoverySummary?.unclassifiedCount ?? 0).toBe(0);
expect(report.diffs.filter(d => d.reviewerStatus === "needs_escalation")).toHaveLength(0);
expect(report.diffs.filter(d => d.reviewerStatus !== "rejected" && !d.classificationSource)).toHaveLength(0);
```

- [x] **Step 4: Update checklist wording**

In `docs/release/production-readiness-checklist.md`, add a "Before running full/release Calorix gates" section:

```markdown
Before running `verify:calorix-full-live` or `verify:calorix-release-live`, confirm:

- latest bounded smoke report has `locatorCoverageStatus:"complete"`
- `auditScope.vlmAuditedPairs > 0`
- `projectedPreAudit` exists and does not report dimension-only projected mismatches as final absence
- every accepted diff has `classificationSource`
- `recoverySummary.statusCounts` exists when recovery ran
```

- [x] **Step 5: Verify and commit**

Run:

```powershell
npm run verify
```

Expected: non-live tests pass. Live gates are not run in this task.

Update status, commit, and push:

```powershell
git add tests/live/calorix-smoke.live.test.ts docs/release/production-readiness-checklist.md docs/implementation-status.md
git commit -m "test(live): harden Calorix gate semantics"
git push
```

## Task 7: Execute Fresh Live Gates And Record Evidence

**Files:**
- Modify: `docs/implementation-status.md`
- Create or modify: `docs/release/2026-06-20-projection-preaudit-live-results.md`
- Do not commit `.ui-diff/runs`, zip artifacts, logs with secrets, or provider raw bodies

**Interfaces:**
- Consumes: fixed code from Tasks 1-6 and live environment variables from `AGENTS.md`
- Produces: current live gate evidence for production readiness decision

- [x] **Step 1: Run deterministic verification**

Run:

```powershell
npm run verify
npm run test:coverage
```

Expected: both pass.

- [x] **Step 2: Run provider and generic live gates** *(attempted 2026-06-21; managed-shell outbound networking denied all provider fetches, so this is not passing release evidence)*

Run:

```powershell
$env:RUN_NVIDIA_LIVE="1"
npm run verify:nvidia-live

$env:RUN_OPENROUTER_FREE_LIVE="1"
npm run verify:openrouter-free-live

$env:RUN_UI_DIFF_LIVE="1"
npm run verify:mcp-live
```

Expected: record pass/fail, selected models, and route diagnostics. If a free provider rate-limits, record it as provider availability evidence, not as a code failure.

- [x] **Step 3: Run bounded Calorix diagnostic** *(attempted 2026-06-21; blocked before run creation by sandbox `EPERM` writing `calorix/.ui-diff/generated/run-state`)*

Run:

```powershell
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-17-adb-seeded-2.png"
$env:LOCATEANYTHING_EAGLE_EMBODIED_DIR="C:\Users\xursc\projects\Eagle\Embodied"
$env:RUN_CALORIX_UI_DIFF_LIVE="1"
npm run verify:calorix-live
```

Expected: bounded run completes as diagnostic evidence. It must not pass if `vlmAuditedPairs` is zero.

Record:

- run ID
- `auditScope`
- `projectedPreAudit`
- `visualClassificationStatus`
- `recoverySummary`
- diff count by `classificationSource`

- [x] **Step 4: Run full Calorix diagnostic** *(attempted 2026-06-21; same sibling-repository write denial, so no report was produced)*

Run with no `UI_DIFF_MAX_AUDIT_PAIRS` in the environment:

```powershell
Remove-Item Env:UI_DIFF_MAX_AUDIT_PAIRS -ErrorAction SilentlyContinue
$env:RUN_CALORIX_FULL_LIVE="1"
npm run verify:calorix-full-live
```

Expected: all 79 pairs are eligible for VLM audit unless pre-audit emits true deterministic projected mismatches after normalized comparison.

- [x] **Step 5: Run release gate** *(attempted 2026-06-21; same sibling-repository write denial, so production sign-off remains blocked)*

Run:

```powershell
$env:RUN_CALORIX_RELEASE_LIVE="1"
npm run verify:calorix-release-live
```

Expected: pass only if `visualClassificationStatus:"complete"`, `auditLimited:false`, `unclassifiedCount:0`, no escalation, and every accepted diff has `classificationSource`.

- [x] **Step 6: Write release result document**

Create `docs/release/2026-06-20-projection-preaudit-live-results.md` with:

```markdown
# Projection Pre-Audit Live Gate Results - 2026-06-20

## Summary

| Gate | Result | Duration | Notes |
| --- | --- | --- | --- |
| deterministic verify | PASS/FAIL |  |  |
| coverage | PASS/FAIL |  |  |
| NVIDIA live | PASS/FAIL |  |  |
| OpenRouter free live | PASS/FAIL |  |  |
| MCP live | PASS/FAIL |  |  |
| Calorix bounded | PASS/FAIL |  | run id, auditScope |
| Calorix full | PASS/FAIL |  | run id, auditScope |
| Calorix release | PASS/FAIL |  | run id |

## Calorix Evidence

- bounded run:
- full run:
- release run:
- diff count by classificationSource:
- recovery status counts:
- provider route diagnostics:

## Production Decision

Release status: READY or BLOCKED

Blocking predicates:

- list exact failing assertion or state "none"
```

- [x] **Step 7: Update status, commit, and push** *(fresh unrestricted results recorded on 2026-06-21; production remains blocked by the failures documented in the release-results file)*

Update `docs/implementation-status.md` with exact commands and results.

Commit and push:

```powershell
git add docs/implementation-status.md docs/release/2026-06-20-projection-preaudit-live-results.md
git commit -m "docs(release): record projection pre-audit live gates"
git push
```

## Acceptance Checks

- `projection_dimension_mismatch` is no longer emitted as a final diff only because crop dimensions differ.
- The three June 20 crop examples would not become automatic high-severity presence diffs from dimension mismatch alone.
- Deterministic geometry diffs have `classificationSource: "deterministic_geometry"`.
- Deterministic missing/extra diffs have `classificationSource: "deterministic_presence"`.
- Projected deterministic decisions happen before VLM audit selection and do not consume VLM budget.
- `auditScope.auditedPairs` and `auditScope.vlmAuditedPairs` count pairs that actually entered the VLM auditor path.
- Full-run pair accounting satisfies `vlmAuditedPairs + preAuditDeterministicPairs === totalPairs`.
- Bounded smoke gate fails if zero pairs reach VLM audit.
- Full gate requires no audit limit and no accepted untagged diffs.
- Release gate requires complete visual classification and zero unclassified recovery leftovers.
- Status docs no longer claim the June 20 bounded run had no passing auditor probes.

## Self-Review

Spec coverage:

- Automatic target discovery remains unchanged.
- No manual ROI, target-map, ignore-mask, or anchor workflow is introduced.
- The MCP still only reports visual diffs and evidence.
- Projection between different screen sizes is handled by coordinate scaling and normalized crop comparison.
- Every final diff has a source label.

Placeholder scan:

- No task uses unresolved placeholder markers.
- No task says "add tests" without naming the concrete assertion.
- No task asks for manual user-created config.

Type consistency:

- `ProjectedPreAuditSummarySchema` and `projectedPreAudit` are named consistently.
- `classificationSource: "deterministic_geometry"` matches the existing enum; Task 2 adds `deterministic_presence` for missing/extra records.
- `vlmAuditedPairs` and `preAuditDeterministicPairs` are optional additions to `AuditScopeSchema`.
- `detectProjectedCropMismatch` and `runProjectedPreAudit` are both asynchronous because comparison resizing uses Sharp/Lanczos.

## External Review Prompt

Use the prompt below with `mcp__antigravity_mcp__ask_ai` and `model: "gemini-3.1-pro-preview"`. Continue the same MCP conversation for revisions; do not use either CLI.

```text
You are reviewing a production-readiness implementation plan for C:\Users\xursc\projects\ui-diff-mcp.

Context:
- ui-diff-mcp compares an expected mobile mockup screenshot and an actual app screenshot.
- Product boundary: it only reports visible UI diffs with evidence. It must not suggest code/config fixes, root causes, or require user-authored ROI/target maps/ignore masks.
- Current default Calorix path uses single-pass expected locator plus projection into actual screenshot coordinates.
- Projection must scale coordinates between screen sizes. If the actual screen is smaller, the projected actual crop is expected to be smaller. Different crop dimensions alone are not a visual mismatch.
- Latest inspected run: C:\Users\xursc\projects\calorix\.ui-diff\runs\run-1781962032076-14decb\artifacts\report.json. It completed as a bounded smoke run with locatorCoverageStatus complete, 79 pairs, auditLimited true, auditedPairs 3, visualClassificationStatus incomplete, recoverySummary.unclassifiedCount 5. Auditor routes were selected and probes passed. The 3 audited pairs were short-circuited as deterministic_projected_mismatch because expected/actual projected crop dimensions differed. Manual inspection showed those three crops mostly contained the same target, so dimension-only mismatch was a false presence diff.

Please review this plan:
docs/superpowers/plans/2026-06-20-projection-preaudit-full-gate-hardening.md

Review goals:
1. Check whether the plan correctly fixes the projection bug: crop dimension mismatch must not itself produce a final presence diff.
2. Check whether projected mismatch detection belongs in pre-audit rather than inside auditElementPair, and whether the plan prevents deterministic pre-checks from consuming VLM audit budget.
3. Check whether the report contract additions are sufficient: deterministic_geometry classificationSource, projectedPreAudit summary, VLM-audited pair counts, and recovery outcome counts.
4. Check whether the live gate assertions distinguish bounded diagnostic smoke, full diagnostic, and release sign-off correctly.
5. Check whether any task risks hiding diffs, weakening release criteria, or reintroducing manual configuration.

Output exactly:
AGREEMENT_STATUS: agree|disagree
MUST_FIX:
- list blockers, or "none"
SHOULD_FIX:
- list non-blocking improvements, or "none"
QUESTIONS:
- list questions, or "none"
RATIONALE:
- concise explanation
```

## Gemini Review Result - 2026-06-20

Interactive Antigravity review conversation: `0f86fef2-0357-456d-aab0-45ecaefe9238`

Result:

- `AGREEMENT_STATUS: agree`
- Must-fix accounting: corrected full-gate coverage to require `vlmAuditedPairs + preAuditDeterministicPairs === totalPairs`.
- Must-fix crop helper ownership: Task 3 now moves `extractImageCrop` from `audit-target.ts` into `src/images/crop.ts`; Task 4 imports it from that module.
- Must-fix variable mismatch: Task 4 uses the real pipeline variable `auditSelection.pairs.length`.
- Should-fix source precision: Task 2 adds `deterministic_presence` instead of labeling missing/extra records as geometry.
- Should-fix interpolation quality: comparison resizing now uses existing Sharp with Lanczos3 instead of custom nearest-neighbor scaling.
- Additional self-review fix: projected pre-audit no longer imports the non-exported `diffId()` from `audit-target.ts`.
