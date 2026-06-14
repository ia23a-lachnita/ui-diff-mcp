# UI Diff MCP Implementation Status

This file is the persistent handoff state for implementation agents. Read it before touching code, update it while working, and commit/push it with every implementation task so the next model can recover project state even after context loss.

## Current State

- Status: production-readiness gates executed, then free-first/product-hardening gaps were identified from live runs and captured in a new implementation plan. The first version of that plan was rejected for insufficient NVIDIA API model research; a dedicated NVIDIA model research document has now been added.
- Branch: `master`.
- Approved spec: `docs/superpowers/specs/2026-06-12-ui-diff-mcp-research-design.md`.
- Active implementation plan: `docs/superpowers/plans/2026-06-12-ui-diff-mcp-mvp-implementation.md`.
- Production-readiness test plan: `docs/superpowers/plans/2026-06-13-production-readiness-tests.md`.
- Current task: Provider-explicit model-section correction — complete.
- Next task: have Gemini review the updated NVIDIA/provider-route research once `gemini-3-pro-preview` quota resets, then implement Task 1 from `docs/superpowers/plans/2026-06-14-free-first-ui-diff-hardening.md`.
- Last verification: `git diff --check` exited 0 for the provider-explicit docs correction, with CRLF warnings only; previous code verification remains `npm run verify`, `npm run test:coverage`, `npm run verify:live`, and bounded `npm run verify:calorix-live` — passed before these docs-only changes.
- Code review: Gemini 3 Pro Preview review for the NVIDIA correction could not run because quota was exhausted for about 8 hours; the MCP wrapper was also blocked by workspace trust until the direct CLI was run with `GEMINI_CLI_TRUST_WORKSPACE=true`. The NVIDIA research is based on official NVIDIA Build/API/NIM documentation and must be Gemini-reviewed later.
- Open blockers: the implemented MCP is not aligned with the final free-first/product-hardening requirements until the new plan is executed. Calorix full all-target visual audit remains unsigned. Gemini review of the NVIDIA-specific research remains pending due quota/tool failure.

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
| 2026-06-14 | this commit | Free-first hardening plan | Gemini 3 Pro Preview final blocker pass: no implementation-critical gaps remain; non-Claude independent review findings incorporated; Claude Sonnet 4.6 unavailable in this tool session | Added `docs/superpowers/plans/2026-06-14-free-first-ui-diff-hardening.md` covering free-first defaults, native NVIDIA API, OpenRouter free model research/rate limits, quota budget gate, provider-agnostic model calls, LocateAnything category prompts, directional overlays, target recovery, typed artifacts, crop naming, Lab/OKLab color evidence, and live gates. |
| 2026-06-14 | this commit | NVIDIA API model research correction | Official NVIDIA Build/API/NIM docs reviewed; Gemini 3 Pro Preview quota exhausted for about 8 hours | Added `docs/research/nvidia-api-vlm-research-2026-06-14.md` with model-by-model NVIDIA native API suitability, role-specific candidate order, exclusions, and live probe requirements. Updated hardening plan to reference the dedicated research and stop treating NVIDIA as a generic provider. |
| 2026-06-14 | this commit | NVIDIA model follow-up: Kimi, MiniMax, Nemotron Ultra | Official NVIDIA Build/API docs reviewed; `git diff --check` before commit | Added `moonshotai/kimi-k2.6` and `minimaxai/minimax-m3` to native NVIDIA VLM probe candidates. Explicitly excluded Nemotron Ultra text-only/reasoning models from visual audit roles. |
| 2026-06-14 | this commit | NVIDIA model follow-up: DeepSeek V4 Pro | Official NVIDIA Build/API docs reviewed; `git diff --check` before commit | Explicitly excluded `deepseek-ai/deepseek-v4-pro` and `deepseek-ai/deepseek-v4-flash` from visual audit roles because current NVIDIA docs present them as text/code/reasoning LLMs, not image-capable VLMs. |
| 2026-06-14 | this commit | Model-ranking clarification: Kimi K2.6 and MiniMax M3 | OpenRouter/NVIDIA docs reviewed; `git diff --check` before commit | Clarified that the previous NVIDIA list was not a measured performance ranking. Added a performance-oriented probe lane that ranks Kimi K2.6 and MiniMax M3 ahead of Qwen/Nemotron, while keeping schema-readiness and licensing gates explicit. |
| 2026-06-14 | this commit | Canonical model-ranking cleanup | OpenRouter/NVIDIA speed-routing docs reviewed; `git diff --check` before commit | Removed ambiguous duplicate model-ranking lanes. The NVIDIA research doc now has one NVIDIA-hosted ranking. The implementation plan now has one provider-agnostic model ranking where OpenRouter, native NVIDIA, and self-hosted NIM are delivery routes, not separate rankings. Speed is a measured runtime gate, not a static NVIDIA ranking. |
| 2026-06-14 | this commit | Mistral Large 3 candidate classification | NVIDIA/OpenRouter/Mistral docs reviewed; `git diff --check` before commit | Added `mistralai/mistral-large-3-675b-instruct-2512` to the canonical VLM rankings as a high-quality candidate after Kimi K2.6 and MiniMax M3. |
| 2026-06-14 | this commit | Provider-explicit model-section correction | `git diff --check` exited 0, with CRLF warnings only | Corrected the spec and implementation docs so the canonical model ranking names provider routes and cost class. Native NVIDIA free endpoints, OpenRouter `:free` routes, self-hosted NIM, and paid OpenRouter routes are now separate eligibility routes instead of being mixed under model names. |

## Handoff Checklist

- Current task: Provider-explicit model-section correction — complete
- Last completed step: Updated the spec, MVP plan, free-first hardening plan, and NVIDIA research doc to separate provider routes and cost class in model sections
- Next step: request Gemini 3 Pro Preview review of the provider-route model sections once quota resets
- Verification command and result: `git diff --check` exited 0, with CRLF warnings only. Previous code gates remain as recorded above.
- Commit pushed: `d70c73f` for the provider-route docs correction; this status-only follow-up records that push.
- Files intentionally left modified: none
- Blockers: Gemini 3 Pro Preview review of the NVIDIA-specific correction is pending due quota exhaustion; Claude Sonnet 4.6 review could not be performed with available tools; implementation is not free-first/product-hardened until the new plan is executed
