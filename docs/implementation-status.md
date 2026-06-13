# UI Diff MCP Implementation Status

This file is the persistent handoff state for implementation agents. Read it before touching code, update it while working, and commit/push it with every implementation task so the next model can recover project state even after context loss.

## Current State

- Status: production-readiness gates executed with real OpenRouter and real local LocateAnything sidecar.
- Branch: `master`.
- Approved spec: `docs/superpowers/specs/2026-06-12-ui-diff-mcp-research-design.md`.
- Active implementation plan: `docs/superpowers/plans/2026-06-12-ui-diff-mcp-mvp-implementation.md`.
- Production-readiness test plan: `docs/superpowers/plans/2026-06-13-production-readiness-tests.md`.
- Current task: live release gate execution — complete.
- Next task: decide whether to require an unbounded Calorix all-target audit as a release blocker or accept bounded Calorix smoke for first production use.
- Last verification: `npm run verify`, `npm run test:coverage`, `npm run verify:live`, and bounded `npm run verify:calorix-live` — passed.
- Code review: Gemini 3 Pro Preview reviewed the live-gate changes on 2026-06-14 — no blockers found.
- Open blockers: none for the generic MCP live path. Calorix full all-target visual audit was not signed off; the passing Calorix gate used `UI_DIFF_MAX_AUDIT_PAIRS=3` and correctly leaves visual classification incomplete.

## Standing Implementation Rules

- Follow the active implementation plan task-by-task.
- Use the required Superpowers execution skill named in the plan before implementing tasks.
- Keep the plan checkboxes and this status file in sync.
- Research current best practices before changing model/provider, MCP SDK, image-processing, or testing-library behavior.
- Do not introduce manual user-authored target maps, ROI maps, ignore masks, anchor dumps, causality explanations, app-edit recommendations, or MCP-edit recommendations.
- Commit and push after every repository change.

## Progress Log

| Date | Commit | Task | Verification | Notes |
| --- | --- | --- | --- | --- |
| 2026-06-12 | `5badb60` | Implementation plan approved | Gemini 3 Pro Preview final blocker pass: `AGREEMENT_STATUS: agree`, `MUST_FIX: none` | Ready to start Task 1. |
| 2026-06-13 | `656e112` | All 12 tasks implemented | `npm run verify` — 65 tests passed, typecheck clean, build clean | All tasks complete. |
| 2026-06-13 | `5bee6f9` | Post-implementation bug fixes | `npm run verify` — 65 tests passed, typecheck clean, build clean | Fixed P1: rawBox1000 schema (array not object), not_checked models falsely marked available, image size mismatch crash, read_ui_diff_report path traversal. Fixed P2: crop artifacts saved to disk, plan checkboxes synced. |
| 2026-06-13 | `81b6201` | Remaining P2 fixes | `npm run verify` — 65 tests passed, typecheck clean, build clean | Fixed: read_ui_diff_report accepts any projectRoot .ui-diff/runs/ path; pixel-diff.png written and referenced by unclassified diffs; diff-overlay.png written via writeOverlay; status TBD placeholders resolved. |
| 2026-06-13 | `448d5a8` | Overlay discoverability + status sync | `npm run verify` — 65 tests passed, typecheck clean, build clean | Added runArtifacts field to UiDiffReport schema; overlay and pixel-diff paths included in report and index.json; status commit SHA updated. |
| 2026-06-13 | `8576473` | Status SHA catch-up | docs only | Updated handoff checklist to reflect current HEAD after status-only commit. |
| 2026-06-13 | `c7cbe40` | Production-readiness test plan drafted | Plan self-review complete; Gemini review attempted but blocked by `QUOTA_EXHAUSTED` | Plan saved at `docs/superpowers/plans/2026-06-13-production-readiness-tests.md`; retry Gemini 3 Pro Preview before execution. |
| 2026-06-13 | `57a783c` | Production-readiness tests | `npm run verify`; `npm run test:coverage` | Added MCP SDK integration tests, capture tests, live OpenRouter/LocateAnything/full MCP gates, and Calorix live smoke gate. |
| 2026-06-13 | `697571e` | LocateAnything sidecar wrapper | `npm run verify`; `npm run test:coverage`; `python -m unittest sidecars.locateanything.test_parser`; `git diff --check` | Gemini 3 Pro Preview reviewed the sidecar design; image-path filesystem coupling was resolved by adding `imageBase64`/`imageMimeType` to locator requests. |
| 2026-06-13 | `4fa9631` | Live release gate execution started | Intended verification: `npm run verify:live`; `npm run verify:calorix-live`; Gemini 3 Pro Preview release-readiness review | Calorix images are known; LocateAnything sidecar setup/run is the active external dependency. |
| 2026-06-14 | this commit | Real live gates executed | `npm run verify` passed (97 unit + 6 integration); `npm run test:coverage` passed (87.28 stmts / 69.85 branches / 87.85 funcs / 89.25 lines); `npm run verify:live` passed (3 live, 1 skipped); `npm run verify:calorix-live` passed with `UI_DIFF_MAX_AUDIT_PAIRS=3`; Gemini 3 Pro Preview blocker review found no blockers; `git diff --check` exited 0 with CRLF warnings only | Installed local Eagle/LocateAnything sidecar, fixed sidecar runtime controls for 8 GB GPU, avoided LocateAnything `top_k=0` crash, made locator calls sequential, added explicit bounded Calorix smoke behavior. Generic MCP live path is production-ready; Calorix bounded smoke is green, but unbounded all-target Calorix audit remains unsigned. |

## Handoff Checklist

- Current task: Live release gate execution — complete
- Last completed step: Ran real OpenRouter + real LocateAnything live gates, including bounded Calorix smoke with provided images
- Next step: choose release wording/policy for unbounded Calorix all-target audit
- Verification command and result: `npm run verify` passed (97 unit + 6 integration); `npm run test:coverage` passed (87.28 stmts / 69.85 branches / 87.85 funcs / 89.25 lines); `npm run verify:live` passed (3 live, 1 skipped); `npm run verify:calorix-live` passed with `UI_DIFF_MAX_AUDIT_PAIRS=3`; `git diff --check` exited 0 with CRLF warnings only
- Commit pushed: this commit after push
- Files intentionally left modified: none
- Blockers: none for generic MCP live readiness; unbounded Calorix all-target audit still needs a separate long-running sign-off if it is required for Calorix-specific production readiness
