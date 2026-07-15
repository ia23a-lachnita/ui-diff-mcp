# Fresh Release Recovery, Grouping, and Report Hardening

> **For agentic workers:** Use test-first development for behavior changes. Workers never commit or push; the main agent reviews, verifies, commits, and pushes each meaningful stage under `AGENTS.md`.

**Goal:** Eliminate all remaining release blockers: broad-evidence deferral leaks in uncapped runs, recovery evidence context gaps, repair prompt decontamination, recovery-group readability, and release-gate truth assertions.

**Grounding:** Strict auto-capture run `run-1784124169373-1e697b`. Calorix base `b09892b`, locator complete. `auditLimited=false`, 64/64 selected/called/valid/reviewed, 212 auditor successes, no audit failure/exhaustion. Final 136 diffs: 125 `vlm_reviewed`, 6 `deterministic_projected_mismatch`, 5 `target_recovery`; 24 broad evidence; 4 unresolved; visual classification incomplete. Recovery: 10 clusters, 7 attempted, 5 accepted, 1 `still_invalid`, 1 `reviewer_rejected`, 3 deferred broad fragments (2 remaining after final coverage). Usage 518192 input / 46979 output / 565171 total; 432 successful calls with usage, 9 errors, 5 fallbacks, no route exhaustion. Mistral ministral-14b-2512 primary; Mistral 8B and OpenCode MiMo alternatives. Release failed: region-0082 and 0083 broad-only 1x408 border deferrals; region-0085 repeated unsupported exact hex claims after repair; region-0090 reviewer rejected wording change although both candidates described gradient-vs-flat color difference. Final overlay 75 groups for 136 diffs, unreadable due criteria labels and overlap. Expected 402x874, actual 1080x2400, 2.16% aspect delta; projection/source crop preservation worked. Antigravity pre-review conversation `fresh-release-recovery-hierarchy-20260715` failed before analysis: `gemini-3.1-pro-preview` rewritten to invalid `gemini-3.1-pro`; no substitute, no mutation.

**Tech Stack:** TypeScript, Vitest, Zod schemas, Sharp-backed PNG artifacts.

## Constraints

- Work only in files named by each task.
- Never commit or push; the main agent reviews, verifies, commits, and pushes.
- `npm run typecheck` and `npm run verify` must pass after every task.
- No production-readiness claim until strict auto-capture release passes with `visualClassificationStatus: complete`, `auditLimited: false`, zero unresolved/escalated final diffs.

## Tasks

### Task 1: TDD Exhaustive Recovery Semantics

- [x] In unbounded / `auditLimited=false` runs, broad VLM evidence must never prevent canonical regions from entering recovery. Broad-fragment deferral may only apply to explicitly limited diagnostics (`auditLimited=true`), which stay incomplete.
- [x] Add focused tests in `tests/unit/target-recovery.test.ts` asserting selected recovery IDs and exact summary/accounting, not implementation-private flags.
- [x] Assert zero `deferred_broad_evidence_fragment` statuses in uncapped run summaries.
- [x] Files likely touched: `src/recovery/target-recovery.ts`, `src/diff/scope-summary.ts`, `src/schemas/core.ts`, `tests/unit/target-recovery.test.ts`.

### Task 2: TDD Recovery Evidence Context

- [x] Replace 2px minimum with centered 64 expected-space pixels per short axis, clamped to viewport.
- [x] Independently project/center actual source context.
- [x] Keep `componentBox` and final finding location authoritative and unchanged.
- [x] Existing actual source crop remains source-resolution; comparison crop remains Lanczos expected-context dimensions.
- [x] Prompt must truthfully call images "context-expanded" and say overlay/mask localize authoritative changed pixels.
- [x] Tests cover interior/edges, 1x408 borders, 172x20 bars, projection, artifact roles/dimensions, no coordinate drift.
- [x] Files likely touched: `src/images/crop.ts`, `src/recovery/target-recovery.ts`, `src/audit/prompts.ts`, `tests/unit/crop.test.ts`, `tests/unit/target-recovery.test.ts`.

### Task 3: TDD Repair Decontamination and Continuity

- [ ] Repair prompt must not echo invalid original title/evidence/offending exact excerpt for unsupported-claim diagnostics.
- [ ] It should include criterion, diagnostic code/message, deterministic measurements, and clean images.
- [ ] Reviewer prompt must say removal of unsupported specificity and label wording changes are expected (not semantic substitution) if criterion/core qualitative observation remain; true visual substitution still rejects.
- [ ] Add exact regression prompts for region-0085 repeated hex and region-0090 gradient-vs-flat wording.
- [ ] Files likely touched: `src/audit/prompts.ts`, `src/audit/review-findings.ts`, `tests/unit/target-recovery.test.ts`, `tests/unit/review-findings.test.ts`.

### Task 4: TDD Repair-Group Output

- [ ] `buildFindingGroups` must merge geometrically equivalent local boxes regardless of missing/different semantic target IDs when overlap >=0.9 and area ratio <=1.25; retain all criterion-level diff IDs/details.
- [ ] Do not merge merely nearby/parent-child boxes without semantic ownership or coherent displacement.
- [ ] Overlay labels become compact `G<number>` only; legend retains criteria/counts.
- [ ] Remove self IDs from `childFindingIds` while preserving real merged/suppressed child lineage.
- [ ] Add `finalGroupCount` to `DiffSummary`; compute groups once in pipeline; use same groups for summary/overlay.
- [ ] Add schema/hydration/backward-compat tests.
- [ ] Files likely touched: `src/report/finding-consolidation.ts`, `src/report/context-overlays.ts`, `src/diff/scope-summary.ts`, `src/schemas/core.ts`, `src/report/report-parts.ts`, `tests/unit/finding-consolidation.test.ts`, `tests/unit/context-overlays.test.ts`, `tests/unit/schemas.test.ts`, `tests/e2e/compare-ui-images.test.ts`.

### Task 5: Release Gate / Report Truth

- [ ] Assert uncapped runs have zero `deferred_broad_evidence_fragment` statuses.
- [ ] Assert group references are valid; `finalGroupCount <= finalDiffCount` and exact equivalent-box fixtures reduce groups.
- [ ] Assert unsupported exact claims cannot reach accepted output.
- [ ] Assert unresolved remains a hard blocker.
- [ ] Do not impose an arbitrary reduction ratio for every UI.
- [ ] Files likely touched: `tests/live/calorix-smoke.live.test.ts`, `src/report/residual-fragments.ts`, `src/pipeline/run-ui-diff.ts`, `src/diff/scope-summary.ts`, `src/schemas/core.ts` (or equivalent).

### Task 6: Verification

- [ ] Focused tests per task.
- [ ] `npm run typecheck`.
- [ ] `npm run verify`.
- [ ] Relevant provider/MCP gates permitted by credentials.
- [ ] Bounded Calorix diagnostic, full Calorix, then strict auto-capture release.
- [ ] Inspect all unresolved/final-group artifacts.
- [ ] Report exact run IDs, providers, models, counts, input-output tokens, errors, fallbacks.
- [ ] Do not claim production ready unless strict release passes with `visualClassificationStatus` complete, `auditLimited` false, zero unresolved/escalated final diffs.

### Task 7: Tracking / Commit Stages

- [ ] Update `docs/implementation-status.md` and plan checkboxes per task.
- [ ] Main agent commits/pushes after each meaningful stage.
- [ ] OpenCode workers never commit/push.

## Verification Record

- Fresh strict auto-capture run: `run-1784124169373-1e697b`
- Calorix base: `b09892b`
- Expected 402x874, actual 1080x2400, 2.16% aspect delta
- Antigravity pre-review unavailable: conversation `fresh-release-recovery-hierarchy-20260715` failed before analysis (`gemini-3.1-pro-preview` rewritten to invalid `gemini-3.1-pro`)
