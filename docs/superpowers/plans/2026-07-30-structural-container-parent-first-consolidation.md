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
- Scope expansion is pending Antigravity review: correct the coordinate-space trigger, normalize VLM evidence, enforce normal reviewer-family independence, and add a structured mechanism key plus invariant. Tasks 1–3 remain complete; Task 4 is not checked and no live rerun should claim repair-grade truth until this review/implementation sequence is complete.

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

### 4. Enforce output invariants

- [ ] Add an algorithmic helper/assertion that detects unexplained nested redundancy after consolidation.
- [ ] Require every suppression to reference a retained parent/group and every retained nested record to have a distinct criterion or valid independent geometry reason.
- [ ] Add report-contract and end-to-end fixtures covering zero unexplained redundancy, valid group lineage, oversized parents, and cross-criterion shared groups.

### 5. Verification and live validation

- [ ] Run focused structural-container and consolidation tests.
- [ ] Run `npm run typecheck` and `npm run verify`.
- [ ] Run a fresh full semantic Calorix audit with `auditLimited=false` when the sidecar and provider routes permit.
- [ ] Inspect exhaustive final/group/parent-child artifacts, not only aggregate counts; record exact run ID, model/provider usage, tokens, errors, fallbacks, rejected findings, groups, and unresolved findings.
- [ ] Do not claim production readiness unless the fresh semantic run is complete, has zero unresolved/escalated findings, and the structural invariant passes.

## Review Record

- Antigravity conversation: `ui-diff-ai-history-live-grouping-20260730`.
- Explicit Gemini 3.6 request failed because the MCP omitted the required effort parameter; the default route used Gemini 3.5 Flash High.
- The first review proposed an unsafe keyword-based direction; that was challenged and removed from this plan.
- Final review: `AGREEMENT_STATUS agree`, `MUST_FIX none`, `SHOULD_FIX none`.
- MCP response noise: permission-search wrapper, concatenated headings/words, file URLs, and duplicate footer. No repository mutation.

## Execution Blocker

- OpenCode `opencode/mimo-v2.5-free` headless attempt stalled for `904` seconds with no output and no edits at approximately `2026-07-30 01:27` Europe/Zurich; the process was terminated. This exact timeout/stall activated the authorized Luna editing fallback for a later implementation stage. This document-only stage makes no production-readiness claim.
