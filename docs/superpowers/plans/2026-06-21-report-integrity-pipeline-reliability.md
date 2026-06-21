# Report Integrity And Pipeline Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a trustworthy automated UI-diff report containing consolidated final findings, separately tracked unresolved regions, deterministic evidence for projected mismatches, honest model accounting, and resumable release runs.

**Architecture:** Introduce a canonical region ledger between pixel coverage and reporting. All finding sources feed a hierarchy-aware consolidator, while unresolved clustered regions remain a separate report collection and never inflate `diffCount`. Auditor/reviewer output becomes qualitative unless backed by deterministic measurements; provider and run-state machines explicitly represent partial, exhausted, and interrupted work.

**Tech Stack:** TypeScript 5.9, Node.js 22+, Zod 4, Sharp, pixelmatch, Vitest, MCP TypeScript SDK, native NVIDIA and OpenRouter vision routes.

## Global Constraints

- The MCP reports visible UI differences only; no root causes, implementation advice, or configuration advice.
- No user-authored ROI maps, target maps, anchor dumps, or ignore masks.
- `report.diffs` contains final findings only. Raw or unresolved pixel regions are never final findings.
- Exact quantitative VLM claims are forbidden unless they reference deterministic measurements supplied by the pipeline.
- Projected actual coordinates remain the default comparison path.
- Free mode remains the default; paid or OpenCode model evaluation is outside this plan.
- Every implementation task uses TDD, updates `docs/implementation-status.md`, commits, and pushes.

## Current Failure Evidence

Full Calorix run `run-1781995654661-a86c16` established the baseline:

- 724 raw uncovered pixel components clustered to 109 recovery regions.
- Final reporting reprocessed the original components and emitted 706 `unclassified_visual_change` records.
- Only 10 records had a classification source: 8 projected mismatches, 1 VLM-reviewed finding, and 1 recovery finding.
- 639 audit criterion traces contained 446 deterministic skips, 184 auditor errors, 6 empty-evidence responses, 2 schema errors, and 1 accepted finding.
- Strict release attempts ended with checkpoint-only reports marked `status:"complete"` and `visualClassificationStatus:"not_run"`.

---

### Task 1: Separate Final Findings From Unresolved Regions

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/schemas/tool-schemas.ts`
- Modify: `src/report/report-writer.ts`
- Modify: `src/server.ts`
- Test: `tests/unit/report-writer.test.ts`
- Test: `tests/unit/server.test.ts`

**Interfaces:**
- Produces: `UnresolvedRegion`, `UiDiffReport.unresolvedRegions`, `CompactOutput.unresolvedRegionCount`
- Preserves: `UiDiffReport.diffs` as the final-finding array and `diffCount === diffs.length`

- [ ] **Step 1: Add failing schema and writer tests**

Assert that a report can contain one accepted finding and two unresolved regions while compact output reports `diffCount:1` and `unresolvedRegionCount:2`. Assert that `unresolvedRegions` cannot contain `reviewerStatus` or masquerade as a `DiffRecord`.

- [ ] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/report-writer.test.ts tests/unit/server.test.ts`

Expected: FAIL because `UnresolvedRegionSchema` and `unresolvedRegionCount` do not exist.

- [ ] **Step 3: Add the report contract**

Add a schema shaped as:

```ts
export const UnresolvedRegionSchema = z.object({
  id: z.string().min(1),
  location: BoxSchema,
  pixelCount: z.number().int().positive(),
  sourceComponentIds: z.array(z.string().min(1)).min(1),
  reason: z.enum([
    "not_classified",
    "audit_route_exhausted",
    "recovery_route_exhausted",
    "recovery_budget_exhausted",
    "interrupted"
  ]),
  artifactPaths: z.array(UiArtifactSchema).default([])
});
```

Add `unresolvedRegions: z.array(UnresolvedRegionSchema).default([])` to `UiDiffReportSchema`. Add `unresolvedRegionCount` to compact/tool outputs. Keep old report parsing compatible by defaulting the new array. An empty artifact list is schema-valid during early checkpoints, but a final unresolved region must have artifacts before final report validation.

- [ ] **Step 4: Pass the focused tests**

Run: `npx vitest run tests/unit/report-writer.test.ts tests/unit/server.test.ts`

Expected: PASS.

- [ ] **Step 5: Update tracking, commit, and push**

Commit message: `feat(report): separate findings from unresolved regions`

---

### Task 2: Build One Canonical Region Ledger

**Files:**
- Create: `src/report/region-ledger.ts`
- Modify: `src/report/component-clustering.ts`
- Modify: `src/report/coverage.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Test: `tests/unit/coverage.test.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`

**Interfaces:**
- Consumes: raw `PixelComponent[]`, coverage decisions, recovered diff IDs
- Produces: `RegionLedger` with raw metrics, clustered canonical regions, and resolved/unresolved state

- [ ] **Step 1: Write the 724-to-109 regression shape as a small fixture**

Create a synthetic set where multiple adjacent child components cluster into two canonical regions. Assert that final unresolved output contains exactly two regions and never recreates the raw children.

- [ ] **Step 2: Verify the regression fails**

Run: `npx vitest run tests/unit/coverage.test.ts tests/e2e/compare-ui-images.test.ts`

Expected: FAIL because final reporting still calls `assignDiffComponentsToRecords()` with raw components.

- [ ] **Step 3: Implement `buildRegionLedger()`**

Use an explicit ledger:

```ts
interface CanonicalRegion {
  id: string;
  box: Box;
  pixelCount: number;
  sourceComponentIds: string[];
  state: "unresolved" | "covered" | "recovered" | "noise";
  coveringFindingIds: string[];
}

interface RegionLedger {
  rawComponentCount: number;
  belowThresholdCount: number;
  regions: CanonicalRegion[];
}
```

Cluster once after initial coverage. Recovery and final reporting must consume and update this ledger. Remove `assignDiffComponentsToRecords()` from the final pipeline path; retain raw component decisions only in debug traces.

- [ ] **Step 4: Prove no raw-component re-expansion**

Assert these invariants:

```ts
expect(report.diffs.every(d => d.criterion !== "unclassified_visual_change")).toBe(true);
expect(report.unresolvedRegions).toHaveLength(2);
expect(report.debugSummary?.coverageComponents).toBe(rawComponents.length);
```

- [ ] **Step 5: Run focused and full verification, update tracking, commit, and push**

Run: `npm run verify`

Commit message: `fix(coverage): keep canonical clustered regions through reporting`

---

### Task 3: Consolidate Hierarchical Fragment Findings

**Files:**
- Create: `src/report/finding-consolidation.ts`
- Modify: `src/audit/review-findings.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/schemas/core.ts`
- Test: `tests/unit/finding-consolidation.test.ts`

**Interfaces:**
- Consumes: deterministic, projected, VLM-reviewed, and recovery findings plus the expected element hierarchy
- Produces: consolidated `DiffRecord[]` with `childFindingIds`, `targetIds`, and preserved evidence/artifacts

- [ ] **Step 1: Write fragment-consolidation tests**

Cover:

- three colored chart dots and two chart bars under one chart parent become one chart finding;
- unrelated adjacent controls remain separate;
- a recovery finding overlapping an existing parent finding becomes supporting evidence rather than a duplicate;
- different criteria on the same parent remain separate findings.
- anonymous/unknown containing boxes cannot become consolidation parents.

- [ ] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/finding-consolidation.test.ts`

Expected: FAIL because current deduplication keys only criterion plus pair/location.

- [ ] **Step 3: Implement hierarchy-aware consolidation**

Resolve each finding to the smallest common stable parent using `parentId`, `childIds`, containment, and pair ownership. Parent eligibility is restricted to semantic types `card`, `chart`, `nav`, `list_item`, `button`, and `image`; `unknown`, `text`, `icon`, anonymous CV containers, and generic merged wrappers cannot own a consolidation group. Consolidate only when parent identity and the exact criterion agree. If there is no eligible parent, require the same pair ID plus strong box containment/overlap. Preserve every child artifact and evidence string; never merge by proximity alone.

- [ ] **Step 4: Add consolidation metadata**

Extend `DiffRecordSchema` with defaulted `childFindingIds` and `targetIds`. The consolidated title names the parent visual object, while child evidence names affected subparts.

- [ ] **Step 5: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit message: `feat(report): consolidate hierarchical fragment findings`

---

### Task 4: Preserve Projected Pre-Audit Evidence And Classify Displacement

**Files:**
- Modify: `src/audit/projected-mismatch.ts`
- Modify: `src/diff/projected-preaudit.ts`
- Modify: `src/schemas/core.ts`
- Test: `tests/unit/projected-mismatch.test.ts`
- Test: `tests/unit/projected-preaudit.test.ts`

**Interfaces:**
- Produces: `ProjectedMismatchResult.kind: "absent_at_location" | "displaced"`, deterministic shift measurements when available, and four typed artifacts per finding

- [ ] **Step 1: Add failing displacement and artifact tests**

Use a colored dot shifted partly outside its projected box. Assert `kind:"displaced"`, criterion `geometry`, and deterministic shift evidence. Place a matched sibling dot inside the search area and assert it is not selected. Use a genuinely absent target fixture and assert `kind:"absent_at_location"`, criterion `presence`. Assert both paths save expected crop, actual crop, overlay, and mask.

- [ ] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/projected-mismatch.test.ts tests/unit/projected-preaudit.test.ts`

Expected: FAIL because all projected mismatches are currently high-severity presence findings without artifacts.

- [ ] **Step 3: Add bounded deterministic translation search**

Compare the expected template against an actual search region expanded around the projected box. Search an edge-map offset grid bounded independently per axis by `min(32, max(4, ceil(projectedDimension * 0.5)))` pixels. Reject candidate centers that fall inside another projected matched sibling box, and mask sibling-owned pixels before scoring repetitive grids/lists. If translated overlap clears the structural threshold, return deterministic displacement and measured offsets. If no plausible translated match exists, return absent-at-projected-location. Do not claim global absence. Add a performance test requiring a 256x256 search fixture to finish within 100 ms on the test machine.

- [ ] **Step 4: Write pre-audit artifacts**

Add typed artifact roles for projected expected crop, actual crop, directional overlay, and mask. Attach them to each deterministic finding before it bypasses VLM selection.

- [ ] **Step 5: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit message: `feat(preaudit): preserve evidence and classify displacement`

---

### Task 5: Prohibit Unsupported Quantitative VLM Claims

**Files:**
- Modify: `src/audit/prompts.ts`
- Modify: `src/audit/criteria.ts`
- Modify: `src/audit/review-findings.ts`
- Modify: `src/audit/audit-target.ts`
- Test: `tests/unit/prompts.test.ts`
- Test: `tests/unit/review-findings.test.ts`

**Interfaces:**
- Consumes: deterministic measurements supplied by pipeline code
- Produces: qualitative VLM evidence plus deterministic measurement references; rejects unsupported `px`, `%`, degree, font-size, and spacing claims

- [ ] **Step 1: Write failing prompt and guard tests**

Assert that `"shifted left by 3px"` is rejected when no deterministic `3 px` measurement exists, while quoted or OCR-backed literal UI content such as `"420"`, `"10%"`, and `"of 2,400"` remains allowed. Assert that a claim matching a supplied `horizontal_shift: 3 px` measurement is allowed.

- [ ] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/prompts.test.ts tests/unit/review-findings.test.ts`

Expected: FAIL because the current prompt explicitly encourages fabricated pixel coordinates.

- [ ] **Step 3: Remove model-authored measurements**

Remove `measurements` from the auditor response schema. Attach only pipeline-computed `ctx.measurements` to final records. Rewrite the prompt to require qualitative descriptions unless it cites a supplied measurement by name.

- [ ] **Step 4: Add `hasUnsupportedQuantitativeClaim()`**

Detect measurement language rather than arbitrary UI numbers. Treat numbers as content when they match expected/actual OCR text, appear inside quotes, or are explicitly introduced as visible text/value. Reject unsupported layout units (`px`, `dp`, degrees, font sizes), numeric movement/spacing comparisons, and percentages described as geometric change unless they match a supplied deterministic measurement. The reviewer prompt must enforce the same distinction.

- [ ] **Step 5: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit message: `fix(audit): reject unsupported quantitative model claims`

---

### Task 6: Make Audit Accounting Represent Successful Work

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/audit/audit-target.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/models/fallback-caller.ts`
- Modify: `src/debug/run-debug.ts`
- Test: `tests/unit/audit.test.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`

**Interfaces:**
- Produces: selected, entered, provider-called, valid-auditor, reviewed, skipped-no-trigger, and failed pair counts

- [ ] **Step 1: Write the misleading-71-pairs regression test**

Simulate three pairs: one no-trigger, one valid auditor/reviewer result, and one route-exhausted failure. Assert that `selectedPairs:3`, `providerCalledPairs:2`, `validAuditorPairs:1`, `reviewedPairs:1`, `failedPairs:1`, and `skippedNoTriggeredPairs:1`.

- [ ] **Step 2: Verify the test fails**

Run: `npx vitest run tests/unit/audit.test.ts tests/e2e/compare-ui-images.test.ts`

Expected: FAIL because current `vlmAuditedPairs` conflates entry into the auditor path with successful classification.

- [ ] **Step 3: Extend `AuditScopeSchema`**

Add the explicit counters and `stoppedReason: "none" | "route_exhausted" | "interrupted"`. Keep old counters as compatibility aliases for one schema version, but live gates must use the new fields.

- [ ] **Step 4: Stop after route exhaustion**

Add a typed `RouteExhaustedError` and `isExhausted(): boolean` to the fallback caller. `auditElementPair()` must rethrow terminal exhaustion instead of converting it to a normal `auditor_error`. The pipeline catches that exact error, stops scheduling later criteria/pairs, and records one structured summary with remaining pair/criterion counts. Remaining work becomes unresolved audit targets, not repeated `auditor_error` rows.

- [ ] **Step 5: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit message: `fix(audit): report successful audit coverage honestly`

---

### Task 7: Harden Structured Model Responses Without Inventing Content

**Files:**
- Modify: `src/models/vision-json.ts`
- Modify: `src/models/nvidia-client.ts`
- Modify: `src/models/openrouter-client.ts`
- Modify: `src/models/fallback-caller.ts`
- Modify: `src/debug/provider-trace.ts`
- Test: `tests/unit/vision-json.test.ts`
- Test: `tests/unit/fallback-caller.test.ts`
- Test: `tests/unit/provider-trace.test.ts`

**Interfaces:**
- Consumes: provider content and finish metadata
- Produces: distinct `truncated_json`, `empty_content`, `schema_invalid`, and `timeout` outcomes plus bounded retry/failover behavior

- [ ] **Step 1: Add exact live-failure fixtures**

Cover the observed 564-character truncated auditor JSON, zero-length Nemotron content, 416-character truncated recovery JSON, and a timeout. Assert safe diagnostic snippets remain in provider trace.

- [ ] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/vision-json.test.ts tests/unit/fallback-caller.test.ts tests/unit/provider-trace.test.ts`

Expected: FAIL because all malformed responses currently collapse to generic invalid JSON.

- [ ] **Step 3: Implement bounded response recovery**

Use provider JSON-schema mode where supported. For non-empty truncated JSON, retry the same route once with a compact response instruction and an adequate role-specific output-token budget. Empty content marks the route unhealthy immediately. Schema-invalid complete JSON may receive one schema-correction retry. Never auto-complete or repair semantic JSON in code.

- [ ] **Step 4: Preserve precise diagnostics and terminal state**

Record finish reason, content length, start/end JSON flags, retry decision, and terminal route outcome. After terminal exhaustion, subsequent calls short-circuit without duplicate provider events.

- [ ] **Step 5: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit message: `fix(models): distinguish and contain structured response failures`

---

### Task 8: Complete Recovery Against Canonical Regions

**Files:**
- Modify: `src/recovery/target-recovery.ts`
- Modify: `src/report/region-ledger.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Test: `tests/unit/target-recovery.test.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`

**Interfaces:**
- Consumes: unresolved canonical regions
- Produces: recovered findings, noise decisions, or explicit unresolved reasons; never silently skipped final work

- [ ] **Step 1: Write cap/deadline regression tests**

Assert that a diagnostic bounded run may stop with explicit unresolved regions, while release mode cannot return complete when component cap, model-call cap, deadline, or caller unavailability leaves regions unresolved. Assert skipped regions already have deterministic crop/mask/overlay artifacts before any model budget check.

- [ ] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/target-recovery.test.ts tests/e2e/compare-ui-images.test.ts`

Expected: FAIL because current recovery skips capped regions without preserving canonical unresolved records.

- [ ] **Step 3: Update ledger state per recovery result**

Generate expected crop, actual crop, local directional overlay, and mask for every canonical region before applying model-call caps or deadlines. Every region must then end as recovered, classified noise, or unresolved with an exact reason. Recovery boxes must map to and overlap their canonical region before acceptance. Attach the pre-generated artifacts to the ledger and any resulting finding.

- [ ] **Step 4: Add resumable recovery cursor**

Persist the next canonical region index and remaining budgets in checkpoint state. A resumed run continues unresolved work instead of probing and auditing completed regions again.

- [ ] **Step 5: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit message: `feat(recovery): resolve canonical regions with resumable progress`

---

### Task 9: Make Checkpoints And Interrupted Runs Honest

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/pipeline/run-store.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/server.ts`
- Modify: `src/schemas/tool-schemas.ts`
- Modify: `tests/helpers/mcp-client.ts`
- Test: `tests/unit/run-store.test.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`
- Test: `tests/live/calorix-smoke.live.test.ts`

**Interfaces:**
- Produces: one shared run ID, optional explicit resumption, atomic checkpoint reports with `isCheckpoint:true`, honest `running/interrupted` status, heartbeat/progress, and captured child exit diagnostics

- [ ] **Step 1: Write interruption tests**

Start a run and assert the MCP handle ID, run-store ID, artifact directory ID, and report ID are identical. Persist a checkpoint, terminate the worker, and reload state. Assert that neither report nor run handle says complete; state must be `interrupted` with last stage, pair index, criterion index, and checkpoint path. Resume with that ID and assert completed stages are not repeated.

- [ ] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/run-store.test.ts tests/e2e/compare-ui-images.test.ts`

Expected: FAIL because checkpoint reports currently inherit `status:"complete"`.

- [ ] **Step 3: Add atomic checkpoint state**

Create a single `createRunId()` owner in `run-store.ts`. `handleStartUiDiffRun()` generates the ID once and passes it into `runUiDiff({ runId })`; direct pipeline calls may omit it and receive an internally generated ID. Add optional `resumeRunId` to `StartUiDiffRunInputSchema`; when present, validate and reuse that exact ID, load its checkpoint cursor, and continue in the existing artifact root. Extend run/report status with `running` and `interrupted`, plus `isCheckpoint`, heartbeat, and progress fields. Write JSON to a same-directory temporary file and rename atomically. Final `complete` is written only after traces and report index are durable.

- [ ] **Step 4: Capture MCP child termination**

`startUiDiffMcpClient()` must retain bounded stderr, exit code/signal, and last run status. Live tests must print these diagnostics when the child exits before a terminal report.

- [ ] **Step 5: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit message: `fix(runs): persist honest resumable checkpoint state`

---

### Task 10: Correct Release Gates And Re-run Calorix

**Files:**
- Modify: `tests/live/calorix-smoke.live.test.ts`
- Modify: `docs/release/production-readiness-checklist.md`
- Create: `docs/release/2026-06-21-report-integrity-live-results.md`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Consumes: final findings, unresolved regions, new audit scope, provider traces, checkpoint state
- Produces: bounded diagnostic, full diagnostic, and strict release evidence with unambiguous pass/fail semantics

- [ ] **Step 1: Fix accepted-finding predicates**

Use `reviewerStatus === "accepted"` for accepted findings. Assert separately that release has zero `needs_escalation`, zero unresolved regions, no route exhaustion, and complete successful-audit accounting.

- [ ] **Step 2: Add duplicate and artifact assertions**

Assert no final finding is `unclassified_visual_change`; every projected deterministic finding has expected/actual/overlay/mask artifacts; consolidated child IDs are unique; and no two final findings share parent, criterion, and strongly overlapping location.

- [ ] **Step 3: Run deterministic and provider gates**

Run:

```powershell
npm run verify
npm run test:coverage
npm audit --audit-level=critical
$env:RUN_NVIDIA_LIVE="1"; npm run verify:nvidia-live
$env:RUN_OPENROUTER_FREE_LIVE="1"; npm run verify:openrouter-free-live
$env:RUN_UI_DIFF_LIVE="1"; npm run verify:mcp-live
```

- [ ] **Step 4: Run bounded, full, and release Calorix gates**

Use the seeded 2026-06-17 screenshot and current mockup. Record run IDs, final finding count, unresolved count, consolidation groups, audit-scope counters, route diagnostics, and durations.

- [ ] **Step 5: Record production decision, update tracking, commit, and push**

Production is ready only when the strict release run finishes with `status:"complete"`, `visualClassificationStatus:"complete"`, zero unresolved regions, no escalation, no interrupted checkpoint, and all required artifacts/traces.

Commit message: `docs(release): record report integrity live gates`

---

## Acceptance Checks

- Raw pixel components never become final diff records.
- `diffCount` counts consolidated final findings only.
- Unresolved canonical regions are separate, inspectable, and artifact-backed.
- Chart/card child fragments consolidate without merging unrelated controls.
- Projected mismatches bypass VLM only with saved deterministic evidence.
- A partially shifted target becomes geometry/displacement, not global absence.
- VLM evidence cannot contain unsupported exact measurements.
- Audit accounting distinguishes selected, called, valid, reviewed, skipped, and failed work.
- MCP handle, run store, report, artifacts, and resumed execution use one stable run ID.
- Route exhaustion produces one terminal summary, not hundreds of repeated errors.
- Invalid JSON diagnostics distinguish truncated, empty, schema-invalid, and timeout responses.
- Recovery cannot report complete while caps, deadlines, or provider failures leave unresolved regions.
- Checkpoints and interrupted processes never report `status:"complete"`.
- Strict release requires zero unresolved regions and a final durable report with traces.

## External Review

Review this plan with `mcp__antigravity_mcp__ask_gemini`, model `gemini-3.1-pro-preview`, `approvalMode:"plan"`, and one persistent conversation ID. Required response format:

```text
AGREEMENT_STATUS: agree|disagree
MUST_FIX:
- blockers or none
SHOULD_FIX:
- improvements or none
QUESTIONS:
- questions or none
RATIONALE:
- concise explanation
```

Continue the same MCP conversation after each revision until `AGREEMENT_STATUS: agree` and `MUST_FIX: none`.

### Review Round 1

Gemini 3.1 Pro Preview via Antigravity MCP returned `AGREEMENT_STATUS: disagree` with four must-fix findings. This revision incorporates all four:

- single run-ID ownership plus optional `resumeRunId` and a concrete resume flow;
- typed terminal route exhaustion that escapes `auditElementPair()` and stops the pipeline;
- a maximum 32-pixel, sibling-masked displacement search with a performance bound;
- quantitative-claim rules that preserve quoted/OCR-backed visible numbers.

It also incorporates the should-fix items: semantic-parent allowlisting, exact-criterion consolidation, and artifacts generated before recovery budget skips.

### Review Round 2 - Green

Gemini 3.1 Pro Preview re-read the revised plan and relevant implementation files through the same Antigravity MCP conversation.

- `AGREEMENT_STATUS: agree`
- `MUST_FIX: none`
- `SHOULD_FIX: none`
- `QUESTIONS: none`

The reviewer confirmed that single run-ID ownership/resumption, canonical unresolved-region handling, bounded sibling-aware displacement search, typed route exhaustion, quantitative-claim enforcement, semantic consolidation, and pre-budget recovery artifacts are structurally sound and ready for implementation.

## Self-Review

- Scope stays within automated visible-diff reporting and release reliability.
- No manual configuration or ROI workflow is introduced.
- Every new type is defined before later tasks consume it.
- Every task names focused tests and a full verification command where appropriate.
- Model-provider purchasing or OpenCode routing is intentionally deferred until report semantics are trustworthy.
