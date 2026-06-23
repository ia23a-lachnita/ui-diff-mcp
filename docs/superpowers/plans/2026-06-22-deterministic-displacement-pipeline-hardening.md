# Deterministic Displacement Pipeline Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` and `superpowers:test-driven-development`. Complete tasks in order, update this file and `docs/implementation-status.md`, and commit/push each task.

**Goal:** Convert large coherent UI movement into a small number of deterministic geometry findings, prevent locator fragments from becoming duplicate presence findings, make deterministic decision authority unambiguous, and remove the fixed recovery-component cutoff as an independent completion blocker.

**Architecture:** Refactor projected pre-audit into two passes. The first pass detects crop mismatches and generates broad coarse-to-fine translation candidates against one shared actual-image search index. The second pass resolves uniquely supported target translations, multi-target displacement consensus groups, and bounded structural-region mismatches when several independently proven crop mismatches do not share one honest translation. Child evidence remains available to the region ledger for shape-local coverage, while explicit group metadata drives final consolidation. Recovery processes canonical regions in batches until completion, route exhaustion, model-call exhaustion, or deadline exhaustion; batch size never becomes a terminal reason.

**Tech Stack:** TypeScript 5.9, Node.js 22+, Sharp, typed-array edge/color maps, Zod 4, Vitest.

## Scope And Constraints

- This plan changes deterministic pipeline behavior only. Provider/model routing, OpenCode, paid models, and quota policy are out of scope.
- Expected-coordinate projection remains the comparison contract.
- No user-authored target maps, ROI maps, anchors, ignore masks, or manual review step.
- Generic `text`/`merged` locator wrappers never become semantic owners by themselves. They may serve only as deterministic boundaries after at least two independently proven local mismatches form either a translation consensus or a connected structural cluster.
- Final findings remain exact and inspectable. Unresolved work remains separate in `unresolvedRegions`.
- Deterministic output may report measured translation; VLM output remains forbidden from inventing exact measurements.
- Every production-code change starts with a failing test and ends with `npm run verify`, status tracking, commit, and push.

## Current Failure Evidence

Strict Calorix run `run-1782078470566-1c2641` is the acceptance baseline:

- 79 total pairs; 8 projected mismatches bypassed VLM; 71 entered audit selection.
- The 8 final findings were all deterministic `presence` findings with `projectionMismatchKind:"absent_at_location"`.
- Six findings are fragments of one changed nutrition layout; two are fragments of one changed recent-scan area.
- All eight local crop mismatches are real, but the current `findProjectedDisplacement()` searches at most 32 px, so larger translations cannot become geometry findings.
- The only common ancestors are generic merged `text` wrappers. Current consolidation correctly rejects those wrappers as semantic parents, but has no independently proven group identity to replace them.
- Recovery had 111 eligible canonical regions and marked 85 `skipped_component_cap` before later deadline/provider outcomes. A fixed total component cap therefore creates unresolved work independently of model quality.
- Deterministic findings use `reviewerStatus:"accepted"`, which misleadingly suggests model review even though no reviewer ran.

## Design Decisions

### Translation search

Use a shared actual-image search index containing a binary edge map and quantized color map. For each mismatched projected target:

1. Sample at most 256 stable template edge points.
2. Search a viewport-relative window with a default coarse stride of 4 px, bounded to 20% of viewport width and 35% of viewport height, with absolute safety caps.
3. Retain the top five non-overlapping translation candidates.
4. Refine each candidate at one-pixel resolution in a small neighborhood.
5. Score edge overlap plus color agreement and retain score, improvement over origin, and runner-up margin.

This follows standard coarse-to-fine template-registration practice without adding a native OpenCV dependency. Direct web research was attempted on 2026-06-22 but the browsing backend returned HTTP 403; the external plan reviewer must independently check the algorithm against current image-registration guidance.

### Consensus and ownership

- A uniquely strong target candidate may become an individual geometry finding when edge overlap is at least `0.65`, improvement over the projected origin is at least `0.15`, and runner-up margin is at least `0.10`.
- Ambiguous/repetitive candidates require a consensus cluster containing at least two distinct target pairs.
- Translation vectors cluster within `max(8 px, 1.5% of viewport width)`. A greedy bipartite assignment, ordered by candidate score and then stable pair ID, prevents two targets from claiming the same actual feature.
- Groups split by translation cluster first, then by shared ancestor boundary or expected-space connectedness. A generic ancestor can bound an already-proven group but cannot create one.
- Live search evidence may show several valid local mismatches in one bounded region without a common translation. In that case, two or more spatially connected mismatches receive `findingGroupKind:"structural_region_mismatch"`; the finding reports only that the region layout differs and never invents a shared `dx`/`dy`.
- Structural connectedness uses local gap plus same-row continuity inside the bounded ancestor. Same-row evidence may bridge a wide horizontal gap, while vertically remote clusters remain separate.
- Explicit `findingGroupId` and a matching `findingGroupKind` (`coherent_displacement` or `structural_region_mismatch`) authorizes consolidation. Proximity or a generic parent alone never does.

### Coverage and final findings

Projected child findings remain in the internal finding list until region coverage is assigned, preserving their local footprints. Final consolidation occurs afterward. This avoids treating an entire rectangular group union as covered when only child shapes were proven.

### Recovery scheduling

The existing component count becomes an internal batch size. All eligible regions are processed across batches while model-call and wall-clock budgets remain. Remaining regions are recorded only for a real terminal condition and retain a cursor for continuation.

---

## Task 1: Make Deterministic Decision Authority Explicit

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/diff/projected-preaudit.ts`
- Modify: `src/diff/deterministic-diffs.ts`
- Modify: `src/report/finding-consolidation.ts`
- Modify: `tests/unit/schemas.test.ts`
- Modify: `tests/unit/projected-preaudit.test.ts`
- Modify: `tests/unit/deterministic-diffs.test.ts`

- [x] **Step 1: Write failing authority-contract tests**

Assert deterministic classification sources require `reviewerStatus:"not_reviewed"`; `vlm_reviewed` accepted findings require reviewer status `accepted`; consolidation never upgrades deterministic children to accepted.

- [x] **Step 2: Run the focused tests and confirm the expected failure**

Run: `npx vitest run tests/unit/schemas.test.ts tests/unit/projected-preaudit.test.ts tests/unit/deterministic-diffs.test.ts tests/unit/finding-consolidation.test.ts`

- [x] **Step 3: Enforce the schema and producer contract**

Use a `superRefine` rule on `DiffRecordSchema` and update deterministic producers. Keep `classificationSource` as the authority field rather than adding a redundant second authority enum.

- [x] **Step 4: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit: `fix(report): distinguish deterministic findings from reviews`

## Task 2: Add Shared Coarse-To-Fine Displacement Search

**Files:**
- Create: `src/diff/displacement-search.ts`
- Modify: `src/audit/projected-mismatch.ts`
- Test: `tests/unit/displacement-search.test.ts`
- Modify: `tests/unit/projected-mismatch.test.ts`

**Interface:**

```ts
interface DisplacementCandidate {
  dx: number;
  dy: number;
  score: number;
  edgeOverlap: number;
  colorAgreement: number;
  improvement: number;
  runnerUpMargin: number;
}

interface DisplacementSearchIndex {
  width: number;
  height: number;
  edgeMap: Uint8Array;
  colorMap: Uint16Array;
}
```

- [x] **Step 1: Write failing large-shift and ambiguity tests**

Cover a 140 px vertical shift, differently sized projected crop, repeated same-color dots with ambiguous candidates, a truly absent target, and a viewport-edge target. Assert top-K ordering and deterministic results.

- [x] **Step 2: Confirm failures against the 32 px implementation**

Run: `npx vitest run tests/unit/displacement-search.test.ts tests/unit/projected-mismatch.test.ts`

- [x] **Step 3: Build one reusable search index**

Extract edge/color map creation from `projected-mismatch.ts`. Sample template edges deterministically and avoid rebuilding the full actual edge set for every target.

- [x] **Step 4: Implement coarse search, non-maximum suppression, and pixel refinement**

Use bounded viewport-relative search with a default 4 px coarse stride, top-five translation-space suppression, one-pixel local refinement, and explicit score/margin output. Do not accept a candidate merely because it is the best available candidate.

- [x] **Step 5: Add a stable performance regression**

Warm once, run three times, and assert the best execution stays within the documented bound on a 256x512 fixture. Keep the algorithmic bound independent of scheduler noise.

- [x] **Step 6: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit: `feat(preaudit): find large projected translations`

## Task 3: Resolve Displacement And Structural Mismatch Groups

**Files:**
- Create: `src/diff/displacement-consensus.ts`
- Modify: `src/schemas/core.ts`
- Test: `tests/unit/displacement-consensus.test.ts`

**Interfaces:**

```ts
interface DisplacementEvidence {
  pairId: string;
  expectedId: string;
  projectedActualId: string;
  candidates: DisplacementCandidate[];
}

interface DisplacementGroup {
  id: string;
  pairIds: string[];
  boundaryElementId?: string;
  dx: number;
  dy: number;
  confidence: number;
}

interface StructuralMismatchGroup {
  id: string;
  kind: "structural_region_mismatch";
  pairIds: string[];
  boundaryElementId: string;
  label: string;
}
```

- [x] **Step 1: Write failing consensus tests**

Cover coherent shifts, repeated dots with conflicting candidate assignments, a single unique target, six non-coherent nutrition fragments inside one bounded region, same-row fragments separated horizontally, and two vertically remote sections under one generic parent.

- [x] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/displacement-consensus.test.ts`

- [x] **Step 3: Implement deterministic clustering and assignment**

Cluster within `max(8 px, 1.5% of viewport width)`, require two distinct pair IDs for ambiguous evidence, rank by support then mean score/margin, enforce one-to-one translated-box assignment with a stable greedy matcher, and reject tied consensus. Individual candidates require edge overlap `>=0.65`, origin improvement `>=0.15`, and runner-up margin `>=0.10`.

- [x] **Step 4: Derive safe group boundaries and labels**

After consensus exists, split displacement groups by shared ancestor boundary or expected-space connectedness. Separately cluster independently proven non-coherent mismatches by bounded structural connectedness, including same-row continuity. Select the first meaningful OCR/text label when available; otherwise use the neutral label `UI region`, never a raw `cv-component-*` label in a grouped title.

- [x] **Step 5: Add schema metadata**

Add optional `findingGroupId`, `findingGroupKind:"coherent_displacement" | "structural_region_mismatch"`, and `groupLabel` to `DiffRecordSchema`, plus separate displacement/structural group counts to `ProjectedPreAuditSummarySchema`.

- [x] **Step 6: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit: `feat(preaudit): resolve coherent displacement groups`

## Task 4: Integrate Two-Pass Projected Pre-Audit

**Files:**
- Modify: `src/diff/projected-preaudit.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/schemas/core.ts`
- Modify: `tests/unit/projected-preaudit.test.ts`
- Modify: `tests/e2e/compare-ui-images.test.ts`

- [x] **Step 1: Write failing two-pass tests**

Assert direct matches remain VLM candidates, large unique translations become geometry, coherent translated fragments receive one shared group ID, connected non-coherent mismatches receive one structural group ID, and genuinely unmatched targets remain `presence`/`absent_at_location`.

- [x] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/projected-preaudit.test.ts tests/e2e/compare-ui-images.test.ts`

- [x] **Step 3: Refactor pre-audit into collect and resolve passes**

Collect all mismatches first, build the shared search index once, obtain candidate evidence, resolve displacement consensus and structural clusters, then create child findings. Do not finalize `absent_at_location` before broad search and both grouping passes are exhausted.

- [x] **Step 4: Preserve local artifacts and add group overview artifacts**

Keep the four child projected artifacts. Add group expected crop, translated actual crop, directional overlay, and mask roles based on the union of member boxes. Attach group artifacts to each member so final consolidation preserves them.

- [x] **Step 5: Preserve shape-local coverage ordering**

Prove with an end-to-end test that region-ledger coverage sees child locations before consolidation, while report output contains consolidated groups only. Unrelated changes inside a group union must remain unresolved.

- [x] **Step 6: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit: `refactor(preaudit): resolve projected mismatches in two passes`

## Task 5: Consolidate Only Explicit Deterministic Groups

**Files:**
- Modify: `src/report/finding-consolidation.ts`
- Modify: `tests/unit/finding-consolidation.test.ts`
- Modify: `tests/e2e/compare-ui-images.test.ts`

- [x] **Step 1: Write failing explicit-group tests**

Assert six deterministic child findings with one group ID become one geometry finding; two group IDs under the same generic parent remain separate; generic parent without group ID still cannot consolidate; artifacts, measurements, target IDs, and child IDs survive.

- [x] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/finding-consolidation.test.ts tests/e2e/compare-ui-images.test.ts`

- [x] **Step 3: Add explicit-group precedence**

Group by `findingGroupId + criterion` before semantic ownership. Require matching `findingGroupKind`; never combine grouped and ungrouped findings. Use the union of expected and translated member locations for the final geometry location.

- [x] **Step 4: Produce useful deterministic titles**

Use `<groupLabel> displaced from expected position` only for coherent translation groups and include their measured consensus translation. Use `<groupLabel> layout differs from expected` for structural groups and make no common translation claim. Keep the final `reviewerStatus:"not_reviewed"`.

- [x] **Step 5: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit: `fix(report): consolidate proven displacement groups`

## Task 6: Make Recovery Component Limits Batch Work

**Files:**
- Modify: `src/recovery/target-recovery.ts`
- Modify: `src/schemas/core.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `.env.example`
- Modify: `tests/unit/target-recovery.test.ts`
- Modify: `tests/e2e/compare-ui-images.test.ts`

- [x] **Step 1: Write failing multi-batch tests**

Provide 25 eligible regions with batch size 12 and a successful deterministic fake caller. Assert all 25 are attempted across three batches and none are `skipped_component_cap`. Add deadline and model-call exhaustion cases that preserve exact remaining region IDs in the cursor.

- [x] **Step 2: Verify the tests fail**

Run: `npx vitest run tests/unit/target-recovery.test.ts tests/e2e/compare-ui-images.test.ts`

- [x] **Step 3: Replace terminal component cap with batching**

Treat the current component limit as `batchSize`. Continue batches until no eligible region remains or a real terminal budget/provider condition occurs. Preserve legacy `component_cap` parsing for old reports but do not emit it in new runs.

- [x] **Step 4: Extend recovery accounting**

Add `eligibleComponents`, `completedComponents`, `remainingComponents`, and `batchCount`. Cursor order must be stable. Deadline/model-call exhaustion leaves only unprocessed regions unresolved; processed noise decisions remain terminal.

- [x] **Step 5: Update environment documentation without adding required user configuration**

Document the old variable as a compatibility alias and expose no new required setup. Internal defaults must work for generic mobile screenshots.

- [x] **Step 6: Verify, update tracking, commit, and push**

Run: `npm run verify`

Commit: `fix(recovery): process canonical regions in batches`

## Task 7: Add Provider-Independent Quality Gates And Validate

**Files:**
- Modify: `tests/live/calorix-smoke.live.test.ts`
- Modify: `docs/release/production-readiness-checklist.md`
- Create: `docs/release/2026-06-22-deterministic-pipeline-live-results.md`
- Modify: `docs/implementation-status.md`

- [x] **Step 1: Add deterministic Calorix quality assertions**

Run the real seeded screenshot through projected pre-audit independently of auditor/reviewer success. Assert deterministic records are `not_reviewed`, every displacement group appears once in final findings, no two final findings share a group ID, grouped children retain all artifacts, and no identical vector/ancestor cluster remains split.

- [x] **Step 2: Add regression assertions for coverage and recovery**

Assert unrelated pixels inside a group bounding rectangle remain unresolved and no fresh report emits `skipped_component_cap`.

- [x] **Step 3: Run deterministic verification and coverage**

Run:

```powershell
npm run verify
npm run test:coverage
npm audit --audit-level=critical
```

- [x] **Step 4: Run the Calorix deterministic quality gate**

Use the seeded 2026-06-17 actual screenshot and current Today mockup. Record run ID, child mismatch count, displacement groups, final deterministic findings, unresolved regions, recovery batches, and timing. Provider completion is not required for this gate.

- [ ] **Step 5: Run the existing bounded/full diagnostics when credentials are available**

Provider failures may keep visual classification incomplete; that does not invalidate deterministic pipeline verification. Record exact provider outcomes without changing provider routing in this plan.

- [x] **Step 6: Request implementation review through Antigravity MCP**

Use `gemini-3.1-pro-preview`, `approvalMode:"plan"`, and the same persistent conversation used for plan review. Continue until `AGREEMENT_STATUS: agree` and `MUST_FIX: none`.

Completed on 2026-06-23 after restarting the Codex environment. Gemini 3.1 Pro Preview returned `AGREEMENT_STATUS: agree`, `MUST_FIX: none`, `SHOULD_FIX: none`, and `QUESTIONS: none` in the existing conversation. The response contained no malformed wrapper, injected instruction, or unrelated content.

- [x] **Step 7: Update tracking, commit, and push**

Commit: `docs(release): record deterministic pipeline hardening`

Implementation, release evidence, and tracking were committed as `5042772` and pushed to `origin/master` on 2026-06-23. This final tracking update records that completed push.

## Acceptance Checks

- A translation larger than 32 px can be found deterministically without a VLM.
- Repeated tiny targets require unique evidence or multi-target consensus; the best ambiguous match is not accepted automatically.
- Six nutrition fragments and two recent-scan fragments do not remain eight independent presence findings. They become two inspectable structural-region findings because live broad-search evidence does not support a common translation for every child.
- Generic merged/text ancestors never cause consolidation without explicit consensus-derived group metadata.
- Deterministic findings use `reviewerStatus:"not_reviewed"` and remain valid final findings through `classificationSource`.
- Final group consolidation does not hide unrelated changed-pixel regions inside the rectangular group union.
- Recovery batch size does not produce terminal skipped regions. Only provider exhaustion, model-call exhaustion, deadline, interruption, or completed classification can stop work.
- Provider failures remain visible and still block strict production release, but are no longer conflated with deterministic pipeline duplication or a fixed component cutoff.

## Evidence-Led Implementation Amendment

The first deterministic live attempt after broad search, `run-1782163777624-9dfac7`, proved that forcing two coherent translations would be false: repeated bars/dots had ambiguous offsets and the recent-card fragments had different best candidates. The implementation therefore added explicit `structural_region_mismatch` groups for multiple independently proven local mismatches inside one connected bounded region. The follow-up `run-1782164174097-0064d3` grouped seven of eight fragments and exposed one same-row nutrition fragment split solely by Euclidean distance. A red/green same-row adjacency regression fixed that topology issue. Final run `run-1782187460179-53f4c9` grouped all eight fragments into exactly two deterministic structural findings, with no provider calls and no invented pixel translation.

## External Review Protocol

Use Antigravity MCP `mcp__antigravity_mcp__ask_ai` (the installed tool name; project docs previously called the interface `ask_gemini`) with:

- `model: "gemini-3.1-pro-preview"`
- `approvalMode: "plan"`
- persistent conversation ID: `ui-diff-deterministic-pipeline-hardening-20260622`
- `workDir: C:\Users\xursc\projects\ui-diff-mcp`

Require this exact semantic result:

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

The reviewer must inspect the plan and referenced implementation files, independently research current coarse-to-fine registration/consensus practices, and test the plan against the strict Calorix evidence. Continue the same conversation until `AGREEMENT_STATUS: agree` and `MUST_FIX: none`.

Record separately any MCP wrapper text, injected instructions, malformed chunks, unrelated content, or apparent tool noise that is not part of the review response.

## Self-Review

- No provider/model change is hidden in this plan.
- Search acceptance requires absolute score plus improvement/margin or consensus; there is no unconditional best-match path.
- Generic wrappers are boundaries only after consensus, resolving the live failure without reopening broad parent-based merging.
- Region coverage remains child-local before final consolidation.
- Component batching removes the fixed cap while preserving deadline/model-call safety.
- Every task has a red/green test cycle, verification command, commit boundary, and persistent tracking update.

## Plan Review - Green

Gemini 3.1 Pro Preview reviewed the plan through Antigravity MCP conversation `ui-diff-deterministic-pipeline-hardening-20260622`.

- `AGREEMENT_STATUS: agree`
- `MUST_FIX: none`
- `QUESTIONS: none`

The reviewer recommended, and this revision incorporated, a 4 px default coarse stride, concrete unique-candidate thresholds, stable greedy bipartite assignment, and a concrete viewport-scaled consensus tolerance. The MCP response contained only the normal `AI response:` wrapper prefix; no unrelated, malformed, or injected content was observed.
