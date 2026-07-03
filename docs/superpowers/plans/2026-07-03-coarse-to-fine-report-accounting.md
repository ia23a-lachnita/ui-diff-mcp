# Coarse-To-Fine Diff Scope And Report Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add coarse-to-fine UI diff scopes, first-class input/output token accounting, and partitioned report JSON files so agents can ask for whole-screen, region, target, or full audits without drowning in a flat target-level report.

**Architecture:** Keep provider/model `mode` separate from visual `diffScope`. The pipeline will add screen/region/target scope metadata and screen/region summaries first, then later VLM screen/region criterion audit can use the same scoped evidence contract. Large arrays and traces move behind `reportParts` references while `report.json` remains the stable manifest.

**Tech Stack:** TypeScript ESM, Zod, Vitest, Sharp artifacts, existing provider trace and report writer modules.

## Global Constraints

- Do not add manual user-authored ROI maps, target maps, ignore masks, or anchor dumps.
- Do not suggest root causes, app code edits, or MCP config edits in model prompts or reports.
- Keep exact provider/model and cost class reporting.
- Token accounting must separate input tokens, output tokens, total tokens, reasoning tokens, and call counts.
- `report.json` must stay schema-valid, but large report sections should be available through referenced subpart JSON files.
- Commit and push after each meaningful implementation stage.
- Use Antigravity MCP before and after implementation for this report-contract/pipeline change.

---

## Current Problems

- The current full run audits many target pairs even when a larger screen or region mismatch already explains the visible difference.
- `report.json` has become too cluttered because it embeds large arrays (`diffs`, `pairs`, `elements`, unresolved regions, debug summaries) and separately links traces.
- Provider token usage exists only in `provider-trace.json` events. A reader has to post-process traces to know input/output tokens by role/provider/model.
- There is no explicit user-facing way to request “whole screen only,” “top/bottom or named region,” or “a described target only.”

## Desired Diff Scopes

Add a new optional tool input `diffScope`:

```ts
type DiffScope =
  | { kind: "full" }
  | { kind: "screen" }
  | { kind: "regions"; regions?: Array<"top" | "middle" | "bottom" | "header" | "content" | "nav"> }
  | { kind: "target"; query: string };
```

Default is `{ kind: "full" }`, preserving current behavior.

- `screen`: compare the whole screenshot by built-in criteria using full-screen artifacts and deterministic measurements.
- `regions`: compare deterministic screen bands or named areas first. If no regions are supplied, use `top`, `middle`, `bottom`, and `nav`.
- `target`: resolve the described target through current target discovery/OCR labels and audit only the best matching pair plus context.
- `full`: run screen summary, region summary, and the current target-level pipeline. Large target-level children should be grouped under larger region/screen diffs when they add no new information.

## Report Partitioning

`report.json` becomes a manifest plus compact summaries. It keeps:

- run identity, status, warnings, image paths, model selection
- `usageSummary`
- `diffScope`
- high-level `diffSummary`
- short top-level `diffs` array for final accepted findings only
- `reportParts` references for large sections

Add `reportParts` entries:

```json
[
  { "role": "elements", "path": "parts/elements.json" },
  { "role": "pairs", "path": "parts/pairs.json" },
  { "role": "diffs", "path": "parts/diffs.json" },
  { "role": "unresolved_regions", "path": "parts/unresolved-regions.json" },
  { "role": "debug_summary", "path": "parts/debug-summary.json" },
  { "role": "usage_summary", "path": "parts/usage-summary.json" }
]
```

Keep backward compatibility by retaining embedded arrays for now, but add `UI_DIFF_PARTITION_REPORT=1` to write embedded large arrays as empty or compact stubs only after tests and readers are updated. This plan implements references first and leaves destructive slimming disabled by default.

`reportParts[].path` is always relative to the directory containing `report.json`. Existing `runArtifacts[].path` may remain absolute for artifact compatibility.

## Token Accounting Contract

Add `UsageSummary`:

```ts
interface UsageBucket {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens: number;
  missingUsageCalls: number;
  totalOnlyUsageCalls: number;
  errorCalls: number;
  fallbackCalls: number;
  routeExhaustedCount: number;
  durationMs: number;
}

interface UsageSummary extends UsageBucket {
  byPhase: Record<string, UsageBucket>;
  byRole: Record<string, UsageBucket>;
  byRoute: Record<string, UsageBucket>;
}
```

Input and output tokens are mandatory separate fields in summaries. If a provider reports `totalTokens` but not input/output, keep `totalTokens`, leave input/output as zero, and increment `totalOnlyUsageCalls`. Do not invent a heuristic split. If a provider omits all usage, counts remain zero and `missingUsageCalls` increments.

## Screen/Region VLM Cost Guard

Screen and region scopes must not audit every criterion blindly. `ScopeDiffSummary` owns deterministic trigger selection:

- `geometry`: changed-mass bounding box center/size shifts or projected group displacement.
- `spacing_alignment`: multiple aligned components in a region shift coherently or large empty-space bands differ.
- `color_appearance`: OKLab/dominant palette delta exceeds configured threshold.
- `icon_image`: edge-diff concentration in icon/image-like subregions.
- `layering_clipping`: changed mass touches region boundaries or overlaps expected/actual surface boxes.
- `typography_content`: OCR/text-box density, text mask, or text-region edge changes exceed threshold.

Only triggered criteria are sent to the scope auditor. A clean screen/region summary emits no VLM call.

Default trigger thresholds:

- `geometry`: changed-mass bounding-box center delta > 2.5% of region width/height or size delta > 4%.
- `spacing_alignment`: coherent component shift count >= 3 or whitespace band delta > 5% of region area.
- `color_appearance`: OKLab average delta > 0.08 or dominant palette changed-pixel ratio > 8%.
- `icon_image`: edge-diff concentration > 12% inside icon/image-like subregions.
- `layering_clipping`: changed mass touching region boundary > 3% of boundary-adjacent pixels or overlap delta > 8%.
- `typography_content`: OCR/text-mask changed area > 5% of text-region area or text-box density delta > 10%.

Threshold env overrides are not part of this implementation. They can be added later only if live evidence shows fixed defaults are too brittle.

## Implementation Tasks

### Task 1: Schema And Tool Contract

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/schemas/tool-schemas.ts`
- Test: `tests/unit/schemas.test.ts`
- Test: `tests/unit/server-handlers.test.ts`

- [x] Add `DiffScopeSchema`, `ReportPartSchema`, `UsageBucketSchema`, and `UsageSummarySchema`.
- [x] Add `ScopeDiffSummarySchema` and `DiffSummarySchema`. `DiffSummarySchema` includes counts by severity, counts by criterion, counts by `classificationSource`, top-level final diff count, unresolved region count, and `scopeSummaries`.
- [x] Add optional `diffScope`, `usageSummary`, `reportParts`, and `diffSummary` to `UiDiffReportSchema`.
- [x] Add optional `scopeId`, `scopeKind`, and `scopeLabel` to `DiffRecordSchema`; allowed `scopeKind` values are `"screen"`, `"region"`, and `"target"`.
- [x] Add optional `diffScope` to `CompareUiImagesInputSchema` and `StartUiDiffRunInputSchema`.
- [x] Add optional `usageSummary` to `CompareUiImagesOutputSchema`.
- [x] Add tests proving default scope parses as `full`, target scope requires non-empty `query`, scope metadata survives on diff records, and usage summary preserves separate input/output token totals.
- [x] Verify red/green with `npx vitest run tests/unit/schemas.test.ts tests/unit/server-handlers.test.ts`.
- [x] Update `docs/implementation-status.md`, commit, and push.

### Task 2: Usage Summary Builder

**Files:**
- Create: `src/debug/usage-summary.ts`
- Test: `tests/unit/usage-summary.test.ts`
- Modify: `src/report/report-writer.ts`

- [ ] Write failing tests for aggregating provider trace events into totals by phase, role, and provider/model route.
- [ ] Count `call_success` as calls; aggregate input/output/total/reasoning tokens and duration.
- [ ] Count successful calls with no usage fields as `missingUsageCalls`.
- [ ] Count successful calls with only total tokens as `totalOnlyUsageCalls`; do not estimate input/output split.
- [ ] Count `call_error`, `fallback`, and `route_exhausted` separately without adding tokens.
- [ ] Export `buildUsageSummary(events: readonly ProviderTraceEvent[]): UsageSummary`.
- [ ] Write `usage-summary.json` as a report part and include `usageSummary` in compact output.
- [ ] Verify with `npx vitest run tests/unit/usage-summary.test.ts tests/unit/report-writer.test.ts`.
- [ ] Update status, commit, and push.

### Task 3: Report Parts Writer

**Files:**
- Create: `src/report/report-parts.ts`
- Modify: `src/report/report-writer.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/server.ts`
- Test: `tests/unit/report-writer.test.ts`
- Test: `tests/unit/server-handlers.test.ts`
- Test: `tests/integration/mcp-tools.integration.test.ts`

- [ ] Write failing tests that `writeUiDiffReport` writes `parts/elements.json`, `parts/pairs.json`, `parts/diffs.json`, `parts/unresolved-regions.json`, `parts/debug-summary.json`, and `parts/usage-summary.json` when data exists.
- [ ] Add schema-safe subpart schemas derived from the existing report sub-schemas: `ElementsPartSchema`, `PairsPartSchema`, `DiffsPartSchema`, `UnresolvedRegionsPartSchema`, `DebugSummaryPartSchema`, and `UsageSummaryPartSchema`.
- [ ] Add `writeReportPart(artifactRoot, role, fileName, payload, schema)` using atomic temp-file write and schema validation before writing.
- [ ] Add `reportParts` to `index.json` and `report.json`.
- [ ] Store `reportParts[].path` relative to the `report.json` directory; resolve relative paths only inside `hydrateReportParts`.
- [ ] Keep embedded arrays unchanged for backward compatibility.
- [ ] Update `writeReportCheckpoint` to write the same report parts as final reports.
- [ ] Add `hydrateReportParts(report, reportPath, readFile = fs.readFile)` that loads referenced part files and reconstructs a full report object when embedded arrays are absent or compacted. If embedded arrays/objects are already populated, skip reading that part.
- [ ] Update `runUiDiff` resume loading to call `hydrateReportParts` before `UiDiffReportSchema.parse`.
- [ ] Update `handleReadUiDiffReport` to call `hydrateReportParts` with `deps.readFile` before returning `report`, so MCP consumers receive a full report even after partitioning is enabled and unit tests stay fully mocked.
- [ ] Verify `read_ui_diff_report` still returns a schema-valid report.
- [ ] Verify with `npx vitest run tests/unit/report-writer.test.ts tests/integration/mcp-tools.integration.test.ts`.
- [ ] Update status, commit, and push.

### Task 4: Scope Resolution And Target Filtering

**Files:**
- Create: `src/pipeline/diff-scope.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Test: `tests/unit/diff-scope.test.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`

- [ ] Implement `normalizeDiffScope(input): DiffScope` with default `full`.
- [ ] Implement `filterPairsForScope(scope, pairs, expectedElements, actualElements)`:
  - `full`: all pairs.
  - `screen`: no target pairs selected for VLM target audit.
  - `regions`: only pairs whose expected or actual center lies inside selected region boxes.
  - `target`: best label/text/query match; include ties only if scores are equal.
- [ ] Add `scopeSummary` counts: total pairs, selected target pairs, skipped by scope, and target query match details.
- [ ] Wire target pair filtering before audit pair selection.
- [ ] If `target` scope resolves zero candidate pairs, append warning `Target query "<query>" could not be resolved by the locator.` and return zero target audit pairs without pretending the target was checked.
- [ ] If `screen` scope is active, bypass target recovery; coverage leftovers are represented in screen/region summaries and unresolved regions, not target-recovery VLM calls.
- [ ] If `regions` scope is active, target recovery is restricted to uncovered components whose center lies inside one selected region. Components outside selected regions are recorded as `skipped_scope_outside_region` in coverage/recovery trace, not sent to VLM recovery.
- [ ] Verify target scope reduces audited pairs in e2e and screen scope writes no target-audit calls.
- [ ] Verify with `npx vitest run tests/unit/diff-scope.test.ts tests/e2e/compare-ui-images.test.ts`.
- [ ] Update status, commit, and push.

### Task 5: Whole-Screen And Region Deterministic Summaries

**Files:**
- Create: `src/diff/scope-summary.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Test: `tests/unit/scope-summary.test.ts`

- [ ] Build screen and region boxes in comparison space: `screen`, `top`, `middle`, `bottom`, `header`, `content`, `nav`.
- [ ] Use mobile-first deterministic ratios: `header` = top 18%, `nav` = bottom 16%, `content` = between header/nav, `top/middle/bottom` = equal thirds. If width >= height, mark region profile as `landscape_or_tablet` and use `nav` = bottom 12% plus a warning that desktop/sidebar navs are not yet specialized.
- [ ] For each scope region, compute changed pixel percent, edge changed percent, dominant expected/actual palette samples, and bounding box of changed mass.
- [ ] Compute `triggeredCriteria` from the deterministic trigger map in the Screen/Region VLM Cost Guard section.
- [ ] Emit `ScopeDiffSummary` records and write them to `parts/scope-summary.json`.
- [ ] Add `diffSummary.scopeSummaries` to the report manifest.
- [ ] Do not call VLMs in this task; this is deterministic evidence feeding the next task.
- [ ] Verify with `npx vitest run tests/unit/scope-summary.test.ts`.
- [ ] Update status, commit, and push.

### Task 6: Screen/Region Criterion Audit And Review

**Files:**
- Create: `src/audit/audit-scope.ts`
- Modify: `src/audit/prompts.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Test: `tests/unit/audit-scope.test.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`

- [ ] Add `buildScopeAuditorPrompt` and `buildScopeReviewerPrompt` for full-screen/region evidence.
- [ ] Use criterion-scoped prompts only for criteria listed in each region's `triggeredCriteria`.
- [ ] Evidence images are expected region, actual region, directional overlay, pixel mask, and optional full-screen context overlay.
- [ ] Auditor must not make exact pixel claims unless citing deterministic measurements.
- [ ] Reviewer validates only supplied screen/region evidence.
- [ ] Add `classificationSource: "vlm_reviewed"` and `scopeId`/`scopeKind` metadata to accepted records.
- [ ] For `screen` scope, visual classification can complete without target audit if all selected screen criteria are reviewed and coverage has no unresolved regions.
- [ ] Verify with mocked callers in `npx vitest run tests/unit/audit-scope.test.ts tests/e2e/compare-ui-images.test.ts`.
- [ ] Update status, commit, and push.

### Task 7: Full Coarse-To-Fine Ordering

**Files:**
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/report/coverage.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`
- Test: `tests/unit/coverage.test.ts`

- [ ] In `full` scope, run screen summaries, region summaries, screen/region audits, then target audit.
- [ ] If a target-level diff is inside a larger accepted region/screen diff and does not add a new criterion, mark it as a child finding or suppress it from top-level `diffs`.
- [ ] Preserve children in `parts/diffs.json` with `childFindingIds` and `findingGroupId`.
- [ ] Add tests proving large region diffs prevent duplicate tiny fragments from inflating top-level diff counts.
- [ ] Verify with `npx vitest run tests/e2e/compare-ui-images.test.ts tests/unit/coverage.test.ts`.
- [ ] Update status, commit, and push.

### Task 8: Docs, Live Gates, And Review

**Files:**
- Modify: `README.md`
- Modify: `docs/release/production-readiness-checklist.md`
- Modify: `docs/implementation-status.md`
- Test: live gates as available

- [ ] Document `diffScope` examples for `screen`, `regions`, `target`, and `full`.
- [ ] Document report parts and where to inspect token accounting.
- [ ] Run `npm run verify`.
- [ ] Run relevant live gates if credentials/sidecar/quota permit: at minimum `verify:mcp-live` and `verify:calorix-release-live` for report-contract changes.
- [ ] Get Antigravity MCP post-implementation review green.
- [ ] Record exact run IDs, model routes, final diff counts, `auditLimited`, visual classification status, usage summary, and any skipped gates.
- [ ] Commit and push final docs/status.

## Antigravity Review

- Pre-implementation review: Gemini 3.1 Pro Preview via Antigravity MCP conversation `ui-diff-coarse-to-fine-report-accounting-2026-07-03`.
  - Round 1: `AGREEMENT_STATUS: disagree`; must-fix blockers were missing `DiffRecord` scope schema fields, no deterministic VLM triggers for screen/region criteria, and partitioned checkpoint/resume breakage.
  - Round 2: `AGREEMENT_STATUS: agree`, `MUST_FIX: none`. Should-fix improvements incorporated: explicit `DiffSummarySchema`/`ScopeDiffSummarySchema`, complete Task 3 file list, relative `reportParts` paths, hydration skip optimization, fixed trigger thresholds, and region-scoped recovery.
  - MCP response noise: none observed beyond the standard `AI response:` wrapper and model footer.
- Post-implementation review: pending.
