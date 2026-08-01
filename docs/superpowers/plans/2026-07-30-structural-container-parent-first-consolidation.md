# Structural Container Parent-First Consolidation

> Documentation-only implementation plan. Workers use test-first development, never commit or push, and the host performs verification and integration.

## Goal

Make final finding consolidation reflect the semantic UI hierarchy: a valid structural parent owns child findings when the parent explains the same criterion-level difference, while independent criteria remain separately visible inside a shared group. Remove nested redundant findings without relying on prose or keyword heuristics.

## Evidence And Diagnosis

- Fresh Calorix run `run-1785365640667-b52869` from commit `1af514c`: status/visual/locator complete; `auditLimited` false/absent; `74/74` audited; `146` accepted diffs, `75` groups, `0` unresolved; `154` accepted and `16` rejected audit findings.
- Usage: `502335` input, `42464` output, `3302` reasoning, `548101` total tokens; `7` errors, `4` fallbacks, `0` exhausted. Final model usage: `19` Ministral 14B findings and `127` Ministral 8B findings.
- Root cause: context overlays can infer a container from semantic type or at least two geometry-valid children, but `finding-consolidation` currently accepts only hardcoded semantic parent types. Live CV cards are often typed `text` while carrying valid `childIds`, so parent ownership, merge, and suppression are absent.
- Exact-evidence equality remains conservative and is not the primary parent-discovery mechanism. The implementation must use structured hierarchy, geometry, criterion, and lineage data only; never prose-keyword heuristics.

## Helmholtz Read-Only Investigation

- Run `run-1785365640667-b52869` used a mixed-coordinate geometry trigger: `run-ui-diff` compared expected `402x874` boxes with projected actual `1080x2400` boxes. Raw deltas exceeded `3px` for `74/74` pairs, ranging from `132.97` to `2036.11` pixels. Applying the comparison transform made `73/74` pairs exactly zero; the remaining difference was the `4.35px` full-width contain inset. The raw trigger therefore falsely produced geometry/spacing findings.
- VLM requests used native actual crops, while masks and overlays used actual-crop-comparison images normalized to expected-crop dimensions. These are not the same evidence coordinate/scale and must be made explicit and consistent.
- Normal-audit reviewer independence was absent: `153/154` accepted audit decisions used the same auditor/reviewer model. Final records were `127/146` Ministral 8B and `19/146` Ministral 14B; there were zero `no_diff` decisions, `154/170` accepted audit findings, and `124/125` layout findings without a geometry displacement measurement. The `146` findings are not trustworthy as repair truth; concrete suspect IDs are `95a17bc6d40b`, `ad40093084e2`, `ea513272dfd3`, and `0152ed9a642c`.
- Hierarchy quantification: `7` parent groups, `57` child groups, `87` repeated-criterion child records, `39` child-only duplicate groups, and `22` independent criteria across `18` child groups. A criterion-only upper bound is approximately `146 -> 59` records and `75 -> 36` groups, but `G42` and `G55` may span sibling cards, so blind suppression is unsafe.
- Scope expansion is implemented through Task 4 in the working tree: the comparison-space trigger and audit accounting corrections are green. Tasks 5–8 remain pending, and no live rerun should claim repair-grade truth until the remaining evidence, reviewer-independence, and invariant tasks are complete.

## Contract

- Parent eligibility is a neutral shared structural-container predicate/utility used consistently by context overlays and finding consolidation.
- A structural parent requires geometry-valid children and the configured child-count threshold; `text` is eligible when its validated lineage proves structural ownership, not merely because of its label.
- Same-criterion nested findings may merge into the structural parent when geometry and lineage support that ownership.
- Different criteria for the same structural region remain distinct child findings but share the parent group.
- A parent that covers an oversized portion of the viewport, at least `30%`, cannot absorb children solely because of containment.
- Stable results must not depend on input ordering or provider/model ordering.
- The final output must satisfy an algorithmic zero-unexplained-nested-redundancy invariant: every suppressed nested finding has an explicit retained parent/group lineage and every retained child is either independently meaningful or belongs to a distinct criterion.

## Tasks

### 1. Establish the shared predicate

- [x] Identify the existing context-overlay and finding-consolidation structural checks and define one neutral shared utility/predicate.
- [x] Specify geometry-valid child counting, lineage validity, semantic-type handling, viewport-area guard, and deterministic ordering in the utility contract.
- [x] Add unit tests for semantic container types, `text` parents with valid `childIds`, invalid/missing child geometry, zero/one/two-child thresholds, and the `>=30%` oversized guard.

### 2. Make parent ownership structural

- [x] Replace the hardcoded `eligibleParent` semantic-type gate with the shared predicate while preserving conservative exact-evidence behavior.
- [x] Carry parent/child lineage through ownership selection, merge, suppression, retained IDs, and report group references.
- [x] Add tests for same-criterion nested layout/color findings merging into one parent-owned finding with complete lineage.

### 3. Preserve independent criteria

- [x] Add tests proving icon and content findings in the same structural region remain separate criterion-level findings while sharing one group.
- [x] Ensure no merge occurs for unrelated geometry, invalid overlap, missing lineage, or parent-only containment without sufficient child evidence.
- [x] Add stable-permutation tests with equivalent input orderings and assert identical retained IDs, child IDs, groups, and suppression decisions.

### 4. Comparison-Space Trigger Correctness

- [x] RED: add focused tests in `tests/unit/comparison-geometry.test.ts` and `tests/unit/criteria.test.ts` for a pure helper in `src/images/comparison-geometry.ts`. The pre-implementation run failed as intended: `6 failed, 19 passed` because the helper was absent and the trigger still depended on `boxDeltaPx`.
- [x] Cover identity, stretch, uniform contain/aspect mismatch, the real `402x874` expected versus `1080x2400` actual projection, genuine moved/resized actual boxes, and no comparable valid-rect intersection. The helper intersects/clips the expected box with `ImagePairTransform.validRect` before comparing it with `projectActualBoxToExpectedSource(actual)`; no-comparable input returns an explicit outcome.
- [x] Implement the helper and replace `TriggerContext.boxDeltaPx` in `src/pipeline/run-ui-diff.ts` with `positionDeltaPx`, `geometryDeltaPx`, and `comparisonComparable`. Geometry eligibility triggers only when `geometryDeltaPx > 3`; `spacing_alignment` eligibility uses `positionDeltaPx > 2` when matched. The helper controls eligibility only and adds no projected single-locator measurements.
- [x] GREEN: ideal projected boxes, including the full-width `402x874`/`1080x2400` case, produce zero deltas after valid-rect clipping; genuine independent moves/resizes within `validRect` remain nonzero. Focused trigger/geometry/audit tests passed `62/62`; the broader related suite passed `90/90`; `npm run typecheck` passed and `git diff --check` passed. The historical contain margin is neutralized by comparison-space clipping, not accepted as a trigger exception.

Task 4 execution was performed in the working tree under the authorized Luna fallback after the recorded OpenCode stall. No commit or live gate was performed; Tasks 5–8 remain pending.

Task 4 fix round: RED was captured with `6 failed, 86 passed` across the focused trigger/audit/accounting suite. After removing the zero-delta fallback, adding explicit non-comparable failure accounting, and correcting edge-delta magnitude, the focused suite passed `92/92`; the broader impacted suite passed `157/157`. The first repository-wide verification exposed two stale tests that still required model calls for unchanged projected pairs; their fixtures/accounting were corrected without changing production behavior. Final `npm run verify` passed `1,107` unit/E2E tests, `20` sidecar parser tests, and `22` integration tests with typecheck and build clean. `git diff --check` passed with only LF-to-CRLF warnings. No live gate was run.

### 5. Normalized Target Evidence

- [x] RED: add `tests/unit/audit.test.ts`, schema/artifact assertions where needed, and prompt/image-order regressions that inspect dimensions, pixel content, image slot order, and artifact roles for mismatched expected/actual crops.
- [x] In `src/audit/audit-target.ts`, preserve the native `actual_crop` artifact for diagnostics, but persist/add `UiArtifact` role `actual_comparison_crop` from the exact `prepareAspectPreservingComparison` PNG. Load that normalized PNG as VLM slot 2 instead of `actualCropB64`; pixel masks, overlays, and the sent image must use the same normalized comparison crop.
- [x] Update `imageRoles`, prompt descriptions, and required accepted artifact roles to distinguish native diagnostics from normalized comparison evidence. Ensure report JSON references both roles without ambiguity.
- [x] GREEN: verify native and comparison artifacts remain available, normalized expected/actual dimensions match, content is the exact persisted PNG sent to the VLM, and mismatched-size crops cannot silently use mixed evidence.

### 6. Runtime Independent Reviewer Routing

- [x] RED: add tests in `tests/unit/audit.test.ts`, `tests/unit/audit-scope.test.ts`, model-routing tests, and relevant stage tests proving normal audit review is dynamically independent of the successful auditor response, not a static primary route.
- [x] Change `AuditContext` in `src/audit/audit-target.ts` to accept `reviewerResolver: (auditorProvider, auditorModel) => VisionJsonCaller | undefined` or an equivalent typed resolver. Resolve it only after the auditor response; apply the same design to `auditScopeSummaries` in `src/audit/audit-scope.ts`.
- [x] Build the resolver in `src/pipeline/run-ui-diff.ts` using `orderIndependentReviewerCandidates` and fallback callers. Exclude the exact route and its `modelFamilyKey`; prefer a different provider. Keep the runtime fallback list family-independent and retain all candidate diagnostics. Existing recovery resolver behavior is the reference.
- [x] Add `AuditDecisionStatus: "independent_reviewer_unavailable"` where the schema does not already provide the equivalent. If no independent resolver exists, emit a `needs_escalation` trace/record excluded by `filterAcceptedDiffs`, not a silent drop.
- [x] Add the status to `auditTraceHasFailure`; feed target and scope traces into failed-pair/stage accounting so `deriveVisualClassificationStatus` becomes incomplete. Scope audits must return trace/failure facts rather than throw or discard them. Keep existing escalation semantics; do not duplicate `needs_escalation` filtering.
- [x] Update `modelSelection.reviewer` to the initial independent route relative to the primary auditor while retaining route diagnostics. GREEN: assert no successful normal audit has the same provider and model family as its auditor, and unavailable independence is visible as incomplete/escalated.

### 7. Structural Invariants

Task 7 design correction from the read-only pre-review:

- The source of truth is an explicit immutable consolidation ledger built from pre-consolidation candidates through retained final findings. Validation must not reconstruct lineage from post-consolidation output alone.
- New suppression decisions use typed fields: `suppressedFindingId`, `retainedFindingId`, `parentElementId`, `childElementId`, `criterion`, `sameCriterion`, `semanticDescendant`, `parentAreaRatio`, `locality`, `displacementRelation`, `measurementRelation`, and later `retainedGroupId`. The existing `FindingSuppression` field may remain only for compatibility and is deprecated as truth; new decisions contain no free-form evidence text.
- Consolidation and validation share one `classifyStructuralRelation` helper. Its inputs are typed semantic ancestry, criterion, canonical geometry, projection kind, and deterministic measurement signature; keyword or prose heuristics are prohibited.
- Validation status is `pass`, `fail`, or `not_evaluated`, with structured violations: `missing_retained_lineage`, `unexplained_nested_same_criterion`, `oversized_parent`, `sibling_boundary`, and `invalid_measurement_relation`. Legacy hydrated reports use `not_evaluated` when the ledger is absent.
- Persist a dedicated `structural_consolidation` report part/artifact and keep only a compact summary in the main report. Build groups after ledger decisions, then map each decision to its retained group.
- A fresh full run is incomplete and the release gate is blocked when structural status is `fail` or `not_evaluated`.

The classifier contract is executable and closed-world: `classifyStructuralRelation` returns exactly one of
`suppress`, `retain_distinct`, `violation`, or `unrelated`, and every result carries exactly one
`StructuralRelationReason` from the exact enum `same_finding`, `no_semantic_relation`, `sibling_boundary`,
`distinct_criterion`, `oversized_parent`, `nonlocal`, `distinct_projection_kind`, `equivalent_explicit_group`,
`invalid_measurement_relation`, `independent_geometry`, `coherent_translation`, `coherent_resize`,
`unexplained_nested_same_criterion`. No other classifier-reason strings are allowed. Its inputs and facts use closed
enums rather than prose: semantic ancestry, criterion, canonical expected-space geometry, typed `projectionMismatchKind`, and a deterministic
measurement signature. Canonical measurement aliases are `horizontal_shift`/`deltaX` for translation x,
`vertical_shift`/`deltaY` for translation y, `deltaWidth` for resize width, and `deltaHeight` for resize height.
`displacementRelation` is one of `coherent_translation`, `distinct_translation`, `not_applicable`, or
`missing_measurement`; `measurementRelation` is one of `same`, `distinct_resize`, `resize_vs_translation`,
`distinct_projection_kind`, `explicit_equivalence`, or `missing_measurement`.

`coherent_translation` requires complete x and y pairs, equal sign per axis, and absolute per-axis differences of at
most 4 comparison-space pixels. Complete translation outside that tolerance or with a sign difference is
`retain_distinct` with reason `independent_geometry`; a complete resize versus a complete translation has fact
`resize_vs_translation` and reason `independent_geometry`; complete width or height resize differences above 4 pixels
are `retain_distinct` with reason `independent_geometry`; differing typed projection kinds are
`distinct_projection_kind`. Equal explicit `findingGroupId` plus `findingGroupKind` is typed equivalence. Missing or
incomplete measurement signatures for nested same-criterion records are violations, never independent findings.

The classifier has this total ordered precedence, applied before explicit grouping or measurements: (1) self or
unrelated invalid ancestry returns `unrelated`; semantic siblings return `retain_distinct` with reason
`sibling_boundary`; (2) different criteria return `retain_distinct` with `distinct_criterion`; (3) parent area or union
locality at or above `0.30` of the canvas, or child containment below `0.70` in canonical expected space, returns
`retain_distinct` with `oversized_parent` or `nonlocal`; (4) different typed `projectionMismatchKind` values return
`retain_distinct` with `distinct_projection_kind`; (5) equal explicit `findingGroupId` plus `findingGroupKind` returns
`suppress` with `equivalent_explicit_group`; (6) derive the canonical measurement signature enum
`none|translation|resize|mixed|invalid`; `mixed` or `invalid` returns `violation` with
`invalid_measurement_relation`; (7) translation versus resize returns `retain_distinct` with
`independent_geometry`; (8) complete translation pairs with equal sign per axis and absolute per-axis differences of
at most 4 comparison-space pixels return `suppress` with `coherent_translation`, otherwise `retain_distinct` with
`independent_geometry`; (9) complete resize pairs with width and height differences of at most 4 pixels return
`suppress` with `coherent_resize`, otherwise `retain_distinct` with `independent_geometry`; (10) one or both missing
required signatures for a nested same-criterion relation return `violation` with
`unexplained_nested_same_criterion`, or `invalid_measurement_relation` for a partial signature. The displacement and
measurement relation enums are closed fact classifications, not additional structural reasons; no free-form evidence
text is part of a new decision.

Ledger validation uses a separate `StructuralValidationViolation` enum with exactly these values:
`missing_retained_lineage`, `unexplained_nested_same_criterion`, `oversized_parent`, `sibling_boundary`,
`invalid_measurement_relation`, `missing_retained_group`, `ambiguous_retained_group`. No other validation-violation
strings are allowed. The overlapping names have distinct meanings: `oversized_parent` and `sibling_boundary` are valid
non-failing classifier reasons when returned with `retain_distinct`, but are validation violations only when a malformed
suppression decision crosses the corresponding guard.

`sibling_boundary` and `oversized_parent` are non-failing classifier reasons for valid `retain_distinct` decisions. The
same-named structured validation violations are emitted only when a malformed suppression decision illegally crosses the
corresponding sibling or size/locality guard. Siblings, including the `G42`/`G55` boundary shape, therefore produce
`retain_distinct`, structural `pass`, and no incomplete status; malformed suppression ledgers crossing those guards
produce `sibling_boundary` or `oversized_parent` validation violations and structural `fail`.

Every newly written non-checkpoint report always persists `structuralConsolidation`. A new run with no candidates is a
structural `pass`; legacy hydration without a ledger is `not_evaluated`. A `fail` forces
`visualClassificationStatus: incomplete`, and release gates reject `fail`, `not_evaluated`, or a missing structural
part. Every `retainedFindingId` referenced by a decision maps to exactly one stable group; violations include
`missing_retained_group` and `ambiguous_retained_group`.

- [x] RED: add the immutable pre-to-post consolidation ledger, typed suppression decisions, shared `classifyStructuralRelation` helper, and focused tests. The old `FindingSuppression` shape remains compatibility-only and is explicitly excluded from new truth.
- [x] Require typed retained lineage and the shared classifier before groups are built; preserve parent-first same-criterion merging, cross-criterion distinct findings, stable permutations, sibling boundaries, and the `>=30%` oversized-parent guard. Add one focused case for every classifier terminal/reason: `same_finding`, `no_semantic_relation`/unrelated, `sibling_boundary`, `distinct_criterion`, `oversized_parent`, `nonlocal`, `distinct_projection_kind`, `equivalent_explicit_group`, `invalid_measurement_relation` for mixed and invalid partial measurements, `independent_geometry` for translation-vs-resize and out-of-tolerance geometry, `coherent_translation`, `coherent_resize`, and `unexplained_nested_same_criterion`. Include the synthetic `146` candidates/`75` groups failure and permutation stability. Siblings and `>=30%` parents must retain distinctly with no violations and structural `pass`; malformed suppression ledgers crossing those guards must fail.
- [x] Add the dedicated `structural_consolidation` report part/artifact, compact main-report summary, post-ledger group mapping, fresh-run incomplete/release-blocking semantics, and legacy-hydration `not_evaluated`. Test no-candidate `pass`, legacy missing-ledger hydration, compact-report hydration, fail/status propagation, release rejection, exact retained-group mapping, `missing_retained_group`, and `ambiguous_retained_group`.
- [x] GREEN: assert zero unexplained redundancy, complete retained/suppressed lineage, valid group mapping, and machine-checkable status/violations. Add malformed-ledger validation cases for every exact `StructuralValidationViolation`: `missing_retained_lineage`, `unexplained_nested_same_criterion`, `oversized_parent`, `sibling_boundary`, `invalid_measurement_relation`, `missing_retained_group`, and `ambiguous_retained_group`. No prose labels, keyword heuristics, or human manual inspection may determine release behavior.

### 8. Verification And Live Validation

- [x] Run focused RED/GREEN tests for Tasks 4–7, `npm run typecheck`, `npm run verify`, and `git diff --check`; record exact counts and failures. Final isolated verification passed: 72 files, 1,262 unit/E2E tests, 20 sidecar parser tests, typecheck/build clean, 22 integration tests; `git diff --check` passed with warnings only.
- [ ] Run relevant provider/live gates permitted by credentials, quota, and sidecar availability, including the normal MCP and Calorix gates. Record unavailable routes, fallbacks, errors, and route exhaustion exactly.
- [ ] Run a fresh physical Calorix full audit with `auditLimited=false` only after Tasks 4–7 are green. Inspect exhaustive final diffs, group/parent-child lineage, artifacts, masks, overlays, and comparison crops through automation; human manual inspection is never release behavior.
- [ ] Compare trigger counts before/after, assert no same-family auditor/reviewer decisions, and record exact provider/model routes, input/output/reasoning/total tokens, errors, fallbacks, accepted/rejected/escalated/unresolved counts, and artifact coverage.
- [ ] Do not claim production readiness unless classification is complete, the fresh run is exhaustive, zero unresolved/escalated findings remain, the structural invariant is green, coordinate/evidence contracts pass, and the report artifacts are machine-verifiably repair-grade.

## Review Record

- Antigravity conversation: `ui-diff-ai-history-live-grouping-20260730`.
- Explicit Gemini 3.6 request failed because the MCP omitted the required effort parameter; the default route used Gemini 3.5 Flash High.
- The first review proposed an unsafe keyword-based direction; that was challenged and removed from this plan.
- Scope-expansion review: `AGREEMENT_STATUS agree`, `MUST_FIX none`, `SHOULD_FIX none`.
- MCP response noise: three false "wait for search" prefatory statements, concatenated words/sections, and inconsistent model identity (`Gemini 1.5 Pro Standard Output` in the body versus `gemini-3.5-flash agy` in the footer). No repository mutation.
- Task 4 pre-review route attempts were unavailable because the Antigravity MCP omitted the required effort parameter: Gemini 3.6 Flash, Gemini 3.1 Pro, and Gemini 3.5 Flash each returned an invalid-model-selection error stating that `--effort` is required. No green pre-review was counted and no repository mutation occurred.
- Task 4 post-implementation review retry at `2026-08-01 11:07 +02:00` failed for the same MCP schema defect in the required fallback order: `gemini-3.6-flash` required low/medium/high effort, `gemini-3.1-pro` required low/high effort, and `gemini-3.5-flash` required low/medium/high effort, but `ask-ai` exposes no effort argument. No response body or mutation occurred and no external green was claimed; the earlier scope review plus host tests/review remain the available evidence.
- Task 4 fix-round review attempt in conversation `ui-diff-task4-fix-round1-20260730` was unavailable for the same MCP routing defect: `gemini-3.5-flash` returned `invalid model selection (--model "gemini-3.5-flash" --effort ""): --model gemini-3.5-flash requires --effort (available: low, medium, high)`. No green review was counted and no repository mutation occurred.
- Release policy: human manual inspection is explicitly rejected as release behavior; exhaustive automated artifacts, accounting, routing, and structural invariants are required.

## Execution Blocker

- OpenCode `opencode/mimo-v2.5-free` headless attempt stalled for `904` seconds with no output and no edits at approximately `2026-07-30 01:27` Europe/Zurich; the process was terminated. This exact timeout/stall activated the authorized Luna editing fallback for a later implementation stage. This document-only stage makes no production-readiness claim.
