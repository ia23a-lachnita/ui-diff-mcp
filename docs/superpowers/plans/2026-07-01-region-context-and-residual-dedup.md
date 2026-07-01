# Region Context And Residual Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make final UI-diff reports explain unresolved pixel regions in full-screen context and prevent tiny residual fragments already covered by larger findings from blocking release as standalone unresolved diffs.

**Architecture:** Keep the existing region-ledger and recovery pipeline as the source of truth. Add deterministic residual-fragment classification before target recovery, preserve those decisions in coverage/debug traces, and write run-level annotated full-screen artifacts that show unresolved regions, accepted findings, and element/card outlines in the comparison coordinate space.

**Tech Stack:** TypeScript ESM, Zod v4, Sharp SVG compositing, Vitest, existing `RegionLedger`, `DiffRecord`, `UiArtifact`, and `UiDiffReport` schemas.

## Global Constraints

- Do not introduce user-authored target maps, ROI maps, ignore masks, anchor dumps, or manual ignore-region setup.
- Do not silently delete visual changes. Every residual suppression must be represented in `coverage-trace.json`, `debug-summary.json`, and the report artifacts.
- Deterministic residual suppression can only mark a region as noise when it is small/narrow and spatially attributable to an already accepted or deterministic larger finding.
- The VLM must not be used to decide residual suppression.
- After every repository change, update `docs/implementation-status.md`, commit, and push to `origin`.
- Before implementation and after implementation, request Antigravity MCP review with `model:"gemini-3.1-pro-preview"`, `approvalMode:"plan"`, and the same conversation ID.

---

## Root Cause Summary

Fresh strict run `run-1782886503519-a3233c` proves the providers and audit flow can process all selected pairs, but release remains blocked by two recovery-rejected residual regions:

- `region-0847`: `x=860,y=173,w=41,h=76`, top-right header/action-icon area, reviewer rejected the recovery claim because the crop evidence was too weak.
- `region-0861`: `x=544,y=2241,w=3,h=28`, a 3px-wide sliver in the bottom scan/recent-scan/nav area, surrounded by accepted larger diffs.

The current report preserves `unresolvedRegions[].location`, but the run-level artifacts do not draw these regions on the full screen or show nearby accepted findings/card outlines. The pipeline also treats residual slivers as unresolved even when a larger accepted finding already explains the surrounding UI movement.

---

## File Structure

- Modify `src/schemas/core.ts`: add artifact roles, coverage statuses, unresolved-region relation fields, and debug-summary counters.
- Create `src/report/residual-fragments.ts`: deterministic rules for classifying residual components as covered/noise by a nearby larger finding.
- Create `src/report/context-overlays.ts`: Sharp/SVG full-screen annotation artifacts for unresolved regions, residual-covered regions, final diffs, and element outlines.
- Modify `src/report/region-ledger.ts`: apply residual-fragment decisions before recovery and expose relation metadata in unresolved regions.
- Modify `src/pipeline/run-ui-diff.ts`: run residual classification after initial ledger build, emit context overlays after final consolidation, and attach artifacts to `runArtifacts`.
- Modify `src/debug/run-debug.ts`: count residual-covered/noise components in debug summaries.
- Modify `tests/unit/coverage.test.ts`: residual-fragment and ledger behavior tests.
- Create `tests/unit/context-overlays.test.ts`: image artifact generation tests.
- Modify `tests/e2e/compare-ui-images.test.ts`: final report contains run-level context artifacts.
- Modify `docs/implementation-status.md`: track the current task, verification, review, commit, and push state.

---

## Task 1: Schema And Trace Contract

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `tests/unit/schemas.test.ts`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Produces artifact roles:
  - `unresolved_regions_overlay`
  - `final_diff_regions_overlay`
  - `region_context_overlay`
- Produces coverage statuses:
  - `covered_by_residual_rule`
  - `noise_residual_fragment`
- Produces debug-summary counters:
  - `coverageResidualCovered: number`
  - `coverageResidualNoise: number`
- Produces optional `UnresolvedRegion` fields:
  - `relatedFindingIds?: string[]`
  - `relation?: "nearby_larger_finding" | "inside_larger_finding" | "none"`

- [x] **Step 1: Write failing schema tests**

Add tests that assert:

```ts
expect(UiArtifactSchema.parse({
  role: "region_context_overlay",
  path: "context.png"
}).role).toBe("region_context_overlay");

expect(CoverageDecisionTraceSchema.parse({
  componentId: "component-1",
  componentBox: { x: 10, y: 10, width: 3, height: 30 },
  pixelCount: 90,
  status: "noise_residual_fragment",
  coveringDiffId: "diff-large",
  coveringCriterion: "geometry",
  overlapRatio: 0
}).status).toBe("noise_residual_fragment");

expect(UnresolvedRegionSchema.parse({
  id: "region-1",
  location: { x: 10, y: 10, width: 3, height: 30 },
  pixelCount: 90,
  sourceComponentIds: ["component-1"],
  reason: "not_classified",
  relatedFindingIds: ["diff-large"],
  relation: "nearby_larger_finding",
  artifactPaths: []
}).relatedFindingIds).toEqual(["diff-large"]);
```

- [x] **Step 2: Verify red**

Run:

```powershell
npx vitest run tests/unit/schemas.test.ts
```

Expected: FAIL because the new enum values/fields do not exist.

- [x] **Step 3: Implement schema additions**

Update `UiArtifactSchema.role`, `CoverageDecisionStatusSchema`, `CoverageDecisionTraceSchema`, `UnresolvedRegionSchema`, and `RunDebugSummarySchema` with the new fields. In `summarizeRunDebug()`, populate:

```ts
coverageResidualCovered: trace.coverage.filter(t => t.status === "covered_by_residual_rule").length,
coverageResidualNoise: trace.coverage.filter(t => t.status === "noise_residual_fragment").length
```

This is required because `RunDebugSummarySchema.parse(summary)` validates the object at runtime.

- [x] **Step 4: Verify green**

Run:

```powershell
npx vitest run tests/unit/schemas.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit and push**

Update `docs/implementation-status.md`, then:

```powershell
git add src/schemas/core.ts tests/unit/schemas.test.ts docs/implementation-status.md
git commit -m "feat: extend region trace schema"
git push
```

---

## Task 2: Deterministic Residual-Fragment Classifier

**Files:**
- Create: `src/report/residual-fragments.ts`
- Modify: `src/report/region-ledger.ts`
- Modify: `tests/unit/coverage.test.ts`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- `classifyResidualFragments(regions, findings, options): ResidualFragmentDecision[]`
- `applyResidualFragmentDecisions(ledger, decisions): void`
- `applyResidualFragmentDecisions()` must update both:
  - `ledger.regions[*]` state/relation/covering IDs
  - every matching `ledger.coverageTrace[*]` whose `componentId` is in `region.sourceComponentIds`
- A residual can be marked `noise` only when:
  - `pixelCount <= 120` or `min(width,height) <= 4`
  - and it is inside a larger finding expanded by `maxDistancePx`
  - and the larger finding area is at least `minAreaMultiplier` times the residual area
  - and the larger finding has `reviewerStatus:"accepted"` or a deterministic classification source

- [x] **Step 1: Write failing residual tests**

Add tests:

```ts
it("marks a tiny sliver near a larger accepted finding as residual noise", () => {
  const ledger = buildRegionLedger([makeComponent(544, 2241, 3, 28, 80)], [], {
    minPixelCount: 50,
    maxGapPx: 12,
    maxClusterAreaRatio: 0.5,
    imageWidth: 1200,
    imageHeight: 2600
  });
  const decisions = classifyResidualFragments(ledger.regions, [
    {
      ...makeDiff(500, 2200, 250, 220),
      id: "diff-large",
      classificationSource: "vlm_reviewed",
      reviewerStatus: "accepted"
    }
  ], { maxDistancePx: 24, maxResidualPixels: 120, maxThinSidePx: 4, minAreaMultiplier: 8 });
  applyResidualFragmentDecisions(ledger, decisions);
  expect(unresolvedRegionsFromLedger(ledger, "not_classified")).toHaveLength(0);
  expect(ledger.regions[0]).toMatchObject({
    state: "noise",
    coveringFindingIds: ["diff-large"],
    unresolvedDetail: expect.stringContaining("residual")
  });
  expect(ledger.coverageTrace[0]).toMatchObject({
    status: "noise_residual_fragment",
    coveringDiffId: "diff-large",
    coveringCriterion: "geometry"
  });
});

it("keeps a meaningful uncovered region unresolved", () => {
  const ledger = buildRegionLedger([makeComponent(100, 100, 80, 60, 1000)], [], {
    minPixelCount: 50,
    maxGapPx: 12,
    maxClusterAreaRatio: 0.5,
    imageWidth: 1200,
    imageHeight: 2600
  });
  const decisions = classifyResidualFragments(ledger.regions, [
    { ...makeDiff(400, 400, 200, 200), id: "far-diff", reviewerStatus: "accepted" }
  ], { maxDistancePx: 24, maxResidualPixels: 120, maxThinSidePx: 4, minAreaMultiplier: 8 });
  applyResidualFragmentDecisions(ledger, decisions);
  expect(unresolvedRegionsFromLedger(ledger, "not_classified")).toHaveLength(1);
});
```

- [x] **Step 2: Verify red**

Run:

```powershell
npx vitest run tests/unit/coverage.test.ts
```

Expected: FAIL because `classifyResidualFragments` does not exist.

- [x] **Step 3: Implement classifier and trace mutation**

Implement box area, expanded containment, nearest larger finding selection, deterministic/accepted finding eligibility, and ledger application. Ledger application must mutate the coverage trace for all `sourceComponentIds` so `coverage-trace.json` and `debug-summary.json` explain why a component disappeared from recovery.

- [x] **Step 4: Verify green**

Run:

```powershell
npx vitest run tests/unit/coverage.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit and push**

Update `docs/implementation-status.md`, then:

```powershell
git add src/report/residual-fragments.ts src/report/region-ledger.ts tests/unit/coverage.test.ts docs/implementation-status.md
git commit -m "feat: classify residual diff fragments"
git push
```

---

## Task 3: Run-Level Context Overlay Artifacts

**Files:**
- Create: `src/report/context-overlays.ts`
- Modify: `src/images/artifacts.ts`
- Modify: `src/schemas/core.ts`
- Create: `tests/unit/context-overlays.test.ts`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- `writeRegionContextOverlays(input): Promise<UiArtifact[]>`
- Inputs:
  - `actualComparisonPath`
  - `directionalOverlayPath`
  - `artifactDir`
  - `diffs`
  - `unresolvedRegions`
  - `elements`
  - optional `imagePairTransform`
- Outputs:
  - `final-diff-regions-overlay.png`
  - `unresolved-regions-overlay.png`
  - `region-context-overlay.png`

- [x] **Step 1: Write failing artifact test**

Create `tests/unit/context-overlays.test.ts` that writes a 200x400 base image, one accepted diff, one unresolved region, one card element, and asserts all three PNG paths exist and appear as `UiArtifact` roles.

- [x] **Step 2: Verify red**

Run:

```powershell
npx vitest run tests/unit/context-overlays.test.ts
```

Expected: FAIL because the module does not exist.

- [x] **Step 3: Implement SVG annotation overlay helper**

Use Sharp compositing with generated SVG:

- green boxes for accepted/final diffs,
- magenta boxes for unresolved regions,
- orange boxes for residual/noise-covered regions when present in ledger context,
- yellow thin boxes for semantic parent elements (`card`, `chart`, `nav`, `list_item`, `button`, `image`),
- compact labels with `diff.id`, `criterion`, or `region.id`.

Element outlines are drawn in comparison space. Expected elements can be drawn directly. Actual elements in dual-locator mode must be transformed into comparison space before drawing; projected actual elements already live in expected/comparison space.

- [x] **Step 4: Verify green**

Run:

```powershell
npx vitest run tests/unit/context-overlays.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit and push**

Update `docs/implementation-status.md`, then:

```powershell
git add src/report/context-overlays.ts src/images/artifacts.ts src/schemas/core.ts tests/unit/context-overlays.test.ts docs/implementation-status.md
git commit -m "feat: add full screen region context overlays"
git push
```

---

## Task 4: Pipeline Wiring And Final Report Visibility

**Files:**
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/report/report-writer.ts`
- Modify: `tests/e2e/compare-ui-images.test.ts`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Residual classification runs after the first `buildRegionLedger()` and before `runTargetRecovery()`.
- Residual classification also runs during final ledger consolidation after all audit/recovery findings have been added. This guarantees deterministic-only mode and post-recovery residuals use the same suppression rules.
- Recovery only receives regions still in `state:"unresolved"`.
- Context overlays run after `finalDiffs` and `unresolvedRegions` are computed.
- `index.json` includes run-level context overlays in `runArtifacts`.

- [x] **Step 1: Write failing e2e assertions**

In the deterministic-only e2e test, assert:

```ts
expect(report.runArtifacts.some(a => a.role === "region_context_overlay")).toBe(true);
expect(report.runArtifacts.some(a => a.role === "unresolved_regions_overlay")).toBe(true);
expect(report.runArtifacts.some(a => a.role === "final_diff_regions_overlay")).toBe(true);
```

- [x] **Step 2: Verify red**

Run:

```powershell
npx vitest run tests/e2e/compare-ui-images.test.ts
```

Expected: FAIL because the pipeline does not write those run artifacts.

- [x] **Step 3: Wire residual classifier**

Create a local helper in `run-ui-diff.ts`:

```ts
function applyResidualSuppression(ledger: RegionLedger): void {
  const residualDecisions = classifyResidualFragments(ledger.regions, allDiffs, {
    maxDistancePx: 24,
    maxResidualPixels: 120,
    maxThinSidePx: 4,
    minAreaMultiplier: 8
  });
  applyResidualFragmentDecisions(ledger, residualDecisions);
}
```

Call it:

1. Immediately after the first `buildRegionLedger(significantComponents, allDiffs, ...)` and before building `uncoveredComponents`.
2. Immediately after `applyFindingCoverage(regionLedger, recoveryResult.recovered)` and `applyRecoveryOutcomes(regionLedger, recoveryResult.regionOutcomes)`, because recovery can create the larger finding that explains a nearby sliver.
3. During final ledger consolidation after `regionLedger ??= buildRegionLedger(...)` and `applyFindingCoverage(regionLedger, allDiffs)`, so `deterministic_only` mode is covered.

Then build `uncoveredComponents` only from regions that remain `state:"unresolved"`.

- [x] **Step 4: Wire context overlays**

After `finalDiffs` and `unresolvedRegions` are computed, call `writeRegionContextOverlays()` and append its artifacts to `runArtifacts` before building the final `UiDiffReport`. Pass `imagePairTransform` so any actual-source element outlines can be drawn in comparison space.

- [x] **Step 5: Verify green**

Run:

```powershell
npx vitest run tests/e2e/compare-ui-images.test.ts
```

Expected: PASS.

- [x] **Step 6: Commit and push**

Update `docs/implementation-status.md`, then:

```powershell
git add src/pipeline/run-ui-diff.ts src/report/report-writer.ts tests/e2e/compare-ui-images.test.ts docs/implementation-status.md
git commit -m "feat: wire residual dedup into reports"
git push
```

---

## Task 5: Verification, Live Evidence, And External Review

**Files:**
- Modify: `docs/implementation-status.md`
- Modify: `docs/release/2026-06-30-direct-gemini-mistral-live-results.md`

- [ ] **Step 1: Run deterministic verification**

Run:

```powershell
npm run verify
```

Expected: PASS.

- [ ] **Step 2: Run relevant live gates that environment permits**

Run, in order:

```powershell
npm run verify:gemini-live
npm run verify:mistral-live
npm run verify:mcp-live
npm run verify:calorix-live
npm run verify:calorix-full-live
npm run verify:calorix-release-live
```

If a gate cannot run, record the exact blocker. If strict release runs, record exact run ID, final diff counts, unresolved count, residual-covered count, model routes, provider fallback summary, and visual validation scope.

- [ ] **Step 3: Inspect generated artifacts**

For the freshest Calorix run, inspect:

- `region-context-overlay.png`
- `unresolved-regions-overlay.png`
- `final-diff-regions-overlay.png`
- `coverage-trace.json`
- `recovery-trace.json`
- `report.json`

Record whether inspection was exhaustive or sampled.

- [ ] **Step 4: Request Antigravity MCP post-implementation review**

Use `mcp__antigravity_mcp__ask_ai` with:

- `model:"gemini-3.1-pro-preview"`
- `approvalMode:"plan"`
- same conversation ID as the pre-review
- include the commit range, verification output, run IDs, and artifact paths

Green means `AGREEMENT_STATUS: agree` and `MUST_FIX: none`.

- [ ] **Step 5: Commit and push final evidence**

Update docs and status, then:

```powershell
git add docs/implementation-status.md docs/release/2026-06-30-direct-gemini-mistral-live-results.md
git commit -m "docs: record residual dedup verification"
git push
```

---

## Acceptance Checks

- `npm run verify` passes.
- Final reports include full-screen context artifacts in `runArtifacts` and `index.json`.
- Unresolved regions retain exact `location`, `pixelCount`, `detail`, `artifactPaths`, and any related finding IDs.
- Tiny residual fragments already inside/near a larger accepted finding are marked as deterministic noise/covered in traces and do not block release.
- Meaningful uncovered regions remain unresolved and still block release.
- No VLM claim can silently suppress a region.
- Calorix strict release either passes with `unresolvedRegions.length === 0` or fails with visually actionable unresolved context artifacts.

## Antigravity Review

Pre-implementation review round 1 (`gemini-3.1-pro-preview` via Antigravity MCP): `AGREEMENT_STATUS: disagree`.

MCP response noise: the response was prefixed with `I am going to check the available permissions to understand the workspace layout.` before the structured review.

Must-fix feedback incorporated:

- Residual suppression now explicitly runs during final ledger consolidation so `deterministic_only` mode is covered.
- Residual suppression now explicitly re-runs after target recovery creates new findings.
- Debug summary counters are explicitly populated in `summarizeRunDebug()`.

Should-fix feedback incorporated:

- `applyResidualFragmentDecisions()` must update `coverageTrace` entries for every source component.
- Context overlays must transform actual element boxes into comparison space in dual-locator mode.
