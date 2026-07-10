# UI Diff Post-Session Catch-Up Audit

Date: 2026-07-10  
Scope: changes `0d09121..3a5efaa`, focused on `run-1783489317778-792f0e`, the semantic-hierarchy changes, their tests, and current status/plan prose. This is an audit, not a detailed implementation plan; Gemini and user review come first.

## Verification Level

- Exhaustive programmatic review of the cited source, plans, status text, and run-accounting evidence.
- Sampled visual validation only: the run-recorded auto-capture and selected overlays/legend were inspected, not every final-diff artifact.
- Fresh `npm run verify` on 2026-07-10 passed: 593 unit/e2e tests, 19 parser tests, build, and 22 integration checks.
- `npm run verify:calorix-release-live` is report-integrity/completeness evidence, not zero-diff Calorix parity evidence. Finding diffs is expected; do not make zero-diff an MCP production gate.

## Findings

### P1

1. **Provider trace contradicts the status narrative.** The `run-1783489317778-792f0e` trace records Gemini 3.5 Flash with 3 successful auditor calls and 0 successful reviewer calls; Mistral 14B with 32/31 successful auditor/reviewer calls; and Mistral 8B with 179/179. Both runs were primarily Mistral-8B, and retained actual images differ. The claim that Gemini completed the workload is unsupported, as is attributing `139 -> 9` to reviewer-model sensitivity.
2. **The nine findings are not repair-localized.** Six VLM findings use the full-screen `0,0,402,874` box and describe broad tab-bar regions. One deterministic finding is outside the expected canvas in actual-image space, and `final-diff-zoom-003.png` is 1x1. These are coordinate-space/artifact defects, not actionable element-localized repairs.
3. **The live semantic hierarchy is not repair-grade.** The legend is `Screen -> 8` flat leaves with no children. Leaves include OCR/text fragments and `cv` placeholders, so the artifact does not provide reliable container-to-descendant inspection.
4. **Parent assignment is order-dependent.** `buildElementMap` assigns a child to the first containing element passing its center/area test (`src/locator/element-map.ts:131-149`), not the nearest/smallest containing parent. Filtering a full-screen parent later has already flattened real nesting.

### P2

5. **Ordinary text and icon leaves are excluded.** Hierarchy and annotations filter to semantic container types, omitting the text/icon leaves needed for container-to-children inspection (`src/report/context-overlays.ts:52-59, 214-265`).
6. **Closing box tokens have an incomplete sanitization net.** The sidecar removes paired `<box>...</box>` tokens and the TypeScript check covers `<box>`, but an unmatched `</box>` can survive both paths and contaminate a label.
7. **Tracking prose and source references are stale or self-referential.** Status/plan text contains contradictory repair-grade/review states, `this commit` cells, and stale model-sensitivity prose. The expected-image source path is dangling because Calorix moved the reference image out of `reference-images`.

## Remediation Order

1. Reconcile run accounting and image identity, then enforce coordinate-space and artifact-size validation.
2. Use nearest/smallest parent selection and preserve ordinary text/icon leaves before judging hierarchy quality.
3. Harden malformed-token parsing, regenerate, and inspect the full final-diff set.
4. Keep release-live interpretation tied to report completeness; use separate sampled or exhaustive visual review for parity claims.

## Disposition

Tests are green, but live evidence exposes follow-up defects. No parity or model-sensitivity conclusion is accepted by this audit.

## External Review

Antigravity MCP conversation `ui-diff-calorix-post-fable-audit-2026-07-10`, using `gemini-3.1-pro-preview`, corroborated all production blockers and rejected none. Follow-up audit-document verdict: `AGREEMENT_STATUS: agree`, `MUST_FIX: none`, `SHOULD_FIX: none`, `PRODUCTION_BLOCKERS_RECORDED: yes`. Response noise: the first review glued the final `MUST_FIX` item to the `SHOULD_FIX` header; the follow-up was clean.
