# Release Repair-Grade Corrections

> **For agentic workers:** Stage A is the active bounded remediation. Use test-first development for behavior changes, keep ownership limited to the files named by the task, and never commit or push; the main agent commits and pushes after review and verification under `AGENTS.md`.

**Goal:** Make final UI-diff findings repair-local and artifact-complete after the mechanically green full and strict release runs.

**Architecture:** Finalization canonicalizes all finding boxes into the expected comparison canvas once, then carries that same context into consolidation. Ownership compares findings with element boxes projected from `normalizedBox` into that canvas; normalized area controls oversized-parent rejection. Scope audits attach the four full-screen evidence artifacts already supplied to the audit function.

**Tech Stack:** TypeScript, Vitest, Zod schemas, Sharp-backed PNG artifacts.

## Global Constraints

- Work only in the Stage A ownership set: `src/report/finding-consolidation.ts`, `tests/unit/finding-consolidation.test.ts`, `src/signals/color.ts`, `tests/unit/color.test.ts`, `src/audit/audit-scope.ts`, `tests/unit/audit-scope.test.ts`, this plan, and `docs/implementation-status.md`.
- Do not touch Stage B claim-guard or recovery files.
- Use `normalizedBox` projected to the comparison canvas for every ownership overlap/area operation; use normalized area directly for oversized repair-parent checks.
- Preserve explicit finding groups and canonicalization idempotency.
- Workers never commit or push; the main agent reviews, verifies, commits, and pushes each meaningful implementation stage under `AGENTS.md`.

## Stages

### Stage A: Repair-Local Finalization And Evidence Completeness

- [x] Add a mixed-coordinate `finalizeFindings` regression with a 402x874 expected canvas, a full-screen expected nav, a local Protein target, and actual-space 1080x2400 elements. Assert the local finding remains local and is not renamed to nav ownership.
- [x] Add boundary tests for palette quantization at white and near-white RGB values; clamp all quantized channels to `0..255`.
- [x] Add scope-audit assertions that every accepted scope `DiffRecord` contains expected, actual-comparison, directional-overlay, and pixel-mask artifacts using existing `UiArtifact` roles.
- [x] Retain comparison context through `finalizeFindings` consolidation without double-transforming already canonical findings. Project normalized element boxes for ownership and use normalized area for oversized checks.
- [x] Pass `pairs` into contextual canonicalization inside direct `consolidateFindings` and cover an extra deterministic-presence finding in actual source space.
- [x] Run focused RED/GREEN tests, `npm run typecheck`, `npm run verify`, and `git diff --check`. Record exact outcomes here and in the implementation status.

### Stage B: Claim Guards And Recovery Integrity

- [ ] Add one common claim guard shared by target audit, scope audit, and recovery so unsupported claims are rejected consistently.
- [ ] Require crop-grounded evidence for global-absence claims, including the full expected/actual comparison crop context used by audit, scope, and recovery paths.
- [ ] Parse and validate both `px²` and percentage measurements before they enter claim guards or report semantics.
- [ ] Add deterministic recovery measurements and prompts that expose the measured crop area, changed-pixel percentage, and source/comparison coordinate space.
- [ ] Convert unsupported recovery claims into explicit `unresolved` findings rather than accepted repair-local findings.
- [ ] Add focused tests covering the shared guard, crop-grounded global absence, `px²`/percentage parsing, deterministic recovery prompts/measurements, and unsupported-claim unresolved output.

### Stage C: Fresh Release Evidence And Exhaustive Artifact Sign-Off

- [ ] Run fresh full and strict release gates with the committed Stage A/B corrections and preserve their run IDs.
- [ ] Inspect every final diff artifact and confirm final counts by status/source, `auditLimited`, `visualClassificationStatus`, provider fallback/error summaries, and unresolved/escalated blockers.
- [ ] Mark production readiness only after artifact review is exhaustive and all required release checks are green.

## Verification Record

- Baseline full run: `run-1783950538695-5165dc` passed mechanically; production remains blocked by artifact findings.
- Baseline strict release run: `run-1783951526567-123bd2` passed mechanically; production remains blocked by artifact findings.
- Antigravity pre-review: conversation `task-9-release-repair-grade-corrections-2026-07-13`, `AGREEMENT_STATUS: agree`, `MUST_FIX: none`; wrapper/concatenated-label/model-footer response noise recorded separately, with no repository mutation.
- Stage A initial RED: `npx vitest run tests/unit/finding-consolidation.test.ts tests/unit/color.test.ts tests/unit/audit-scope.test.ts` failed `2` tests (`256` palette channels and empty scope artifacts); the mixed-coordinate test initially passed because the target itself was a semantic card, then failed as intended after making Protein a local text target (`expected nav: geometry`).
- Stage A initial GREEN: the same focused command passed `3` files and `54/54` tests after implementation.
- Stage A follow-up RED: `npx vitest run tests/unit/finding-consolidation.test.ts` failed `1` direct contextual extra-finding test because `consolidateFindings` omitted `pairs` during canonicalization and returned no finding.
- Stage A follow-up GREEN: `npx vitest run tests/unit/finding-consolidation.test.ts tests/unit/color.test.ts tests/unit/audit-scope.test.ts` passed `3` files and `55/55` tests; `npm run typecheck` passed.
- Stage A final verification after the follow-up: `npm run verify` passed with 63 test files, 733 unit/e2e tests, 20 sidecar parser tests, build, and 22 integration tests; `git diff --check` passed with only the repository's LF-to-CRLF working-copy warnings. Stage A is ready for main-agent commit/push; production remains blocked by release artifact findings.
- Stage A main-agent post-review correction record: conversation `task-9-release-repair-grade-corrections-2026-07-13` identified `SHOULD_FIX: pass pairs to canonicalization` with `AGREEMENT_STATUS: agree` and `MUST_FIX: none`; the correction is applied in `consolidateFindings` and covered by the direct extra deterministic-presence regression. Response noise: first line falsely said it would check permission status, wrapper, concatenated headings, file links, split words/model footer. `git status` showed no mutation.
- Stage A same-conversation main-agent follow-up after applying that correction: `AGREEMENT_STATUS: agree`, `MUST_FIX: none`, `SHOULD_FIX: none`. Response noise: prefatory false permission-status sentence, wrapper, file links/model footer, and repeated Recent-scans question. `git status` showed no external mutation.
