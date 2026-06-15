# UI Diff MCP Implementation Status

This file is the persistent handoff state for implementation agents. Read it before touching code, update it while working, and commit/push it with every implementation task so the next model can recover project state even after context loss.

## Current State

- Status: production-readiness gates executed, then free-first/product-hardening gaps were identified from live runs and captured in a new implementation plan. The first version of that plan was rejected for insufficient NVIDIA API model research; a dedicated NVIDIA model research document has now been added.
- Branch: `master`.
- Approved spec: `docs/superpowers/specs/2026-06-12-ui-diff-mcp-research-design.md`.
- Active implementation plan: `docs/superpowers/plans/2026-06-12-ui-diff-mcp-mvp-implementation.md`.
- Production-readiness test plan: `docs/superpowers/plans/2026-06-13-production-readiness-tests.md`.
- Current task: Live gate hardening plan after corrected default-free MCP live runs — complete.
- Next task: execute `docs/superpowers/plans/2026-06-15-live-gate-hardening.md`.
- Last verification: `npm run build` passed. Corrected generic MCP live run in `mode: "free"` completed but returned `visualClassificationStatus: "incomplete"` with two `unclassified_visual_change` records. `npm run verify:calorix-live` timed out after about 10 minutes with `UI_DIFF_MAX_AUDIT_PAIRS=3`. `npm run verify:calorix-full-live` timed out after about 30 minutes. `git diff --check` for the plan commit exited 0 with CRLF warnings only.
- Code review: Gemini CLI using `gemini-3.1-pro-preview` reviewed `docs/superpowers/plans/2026-06-15-live-gate-hardening.md`; final blocker pass returned `AGREEMENT_STATUS: agree`, `MUST_FIX: None`, `SHOULD_FIX: None`.
- Open blockers: production sign-off is blocked until the live gate hardening plan is implemented and the corrected default MCP, bounded Calorix, and full Calorix live gates finish without MCP protocol timeouts.

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

| 2026-06-14 | `a75599b`–`9aa3d1f` | Tasks 1–9 (free-first hardening plan) | `npm run verify` — 184 tests passed, typecheck clean, build clean; Gemini 2.5 Flash reviewed each task | Tasks 1 (model registry/modes), 2 (NVIDIA provider), 3 (free quota/benchmark), 4 (locator category prompts), 5 (directional diff artifacts), 6 (auditor evidence payload), 7 (target recovery), 8 (crop naming), 9 (color evidence/OKLab). |
| 2026-06-14 | `06c1bd1` | Task 9 palette fix | Gemini 2.5 Flash MUST_FIX: dominant palette not in measurements | Added color_dominant_expected/actual_palette as JSON measurements. |
| 2026-06-14 | `8284bb4` | Task 10 (report contract hardening) | `npm run verify` — 192 tests passed, typecheck clean | Added visualClassificationStatus + auditLimited to CompactOutput/RunOutput/CompareUiImagesOutputSchema. Added ModelSelectionSchema to UiDiffReport. Gemini 2.5 Flash: no issues. |
| 2026-06-14 | `0238301` | Task 11 (live gates) | `npm run verify` — 192 tests passed, typecheck clean | Added verify:free-live (OpenRouter free probes + quota), verify:nvidia-live (NVIDIA VLM probes), verify:calorix-full-live (unbounded all-target audit). Updated require-live-env.js and checklist. Gemini 2.5 Flash: no issues. |
| 2026-06-14 | `423e799` | Task 12 (Documentation) | `npm run verify` — 192 tests passed, typecheck clean | Restructured README with free-first defaults and modes table. Expanded .env.example with inline documentation. Updated implementation-status.md through Task 11. Expanded free-model-benchmark.md with ranked candidates and methodology. Gemini 2.5 Flash: no issues. |
| 2026-06-14 | `f56f04a` | Post-Task-12 bug fixes | `npm run verify` — 192 unit + 19 integration tests passed, typecheck clean | P1: paid mode now probes paidRoutes. P1: calorix smoke mode "full"→"free". P1: getRequiredModels() returns all free candidates. P1: pixel diff pads mismatched crop sizes. P2: color evidence uses per-image element box. P2: audit.test.ts artifact-naming test committed. |
| 2026-06-14 | `84a9eb3` | Model-routing correction | `npm run verify` — 196 unit/e2e tests, 10 sidecar parser tests, build, 19 integration tests; `git diff --check` exited 0 with CRLF warnings only | Removed stale OpenRouter `moonshotai/kimi-k2.6:free` runtime route; kept native NVIDIA Kimi as free candidate and OpenRouter Kimi as paid-only. Promoted reviewer selection to strong model families before nano VL routes, avoids auditor's exact route when another strong route passes, requires `UI_DIFF_ENABLE_PAID_MODE=1` for paid selection, and records model `costClass` in report `modelSelection`. Gemini 3.1 Pro Preview: no findings. |
| 2026-06-14 | `612a9ab` | Calorix agent launch scripts | Not recorded in this status file before this update | Added `launch-calorix-claude.bat` and `launch-calorix-claude.ps1`. |
| 2026-06-14 | this commit | Live gate execution and pixel-mask fix | `npm run verify` — 196 unit/e2e tests, 10 sidecar parser tests, build, 19 integration tests. Live gates: `verify:free-live` passed; `verify:nvidia-live` passed; `verify:live` failed with incomplete visual classification; `verify:calorix-live` timed out after about 10 minutes; `verify:calorix-full-live` timed out after about 30 minutes. | Fixed `computePixelDiff` binary mask extraction so unchanged pixels are not counted as diff mass. Updated generic live MCP test to use valid `free_openrouter` mode and structured artifact/model-selection assertions. Generic live diagnostic selected auditor `openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` and reviewer `openrouter/nex-agi/nex-n2-pro:free`, but did not classify the simple shifted rectangle; Calorix runs produced recovery artifacts then hit MCP request timeouts. |
| 2026-06-15 | this commit | Corrected default-free MCP live runs and hardening plan | `npm run build` passed. Generic MCP `mode: "free"` run completed with native NVIDIA `moonshotai/kimi-k2.6` auditor and `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` reviewer but remained visually incomplete. `npm run verify:calorix-live` timed out after about 10 minutes. `npm run verify:calorix-full-live` timed out after about 30 minutes. Gemini final plan review: `AGREEMENT_STATUS: agree`, `MUST_FIX: None`, `SHOULD_FIX: None`. | Added `docs/superpowers/plans/2026-06-15-live-gate-hardening.md`. The plan covers correct default/openrouter live gate split, role-specific model probes, deterministic geometry diffs, weak locator label pairing, bounded target recovery, checkpoint reports, async MCP run handles, and final live gates. |

| 2026-06-15 | `758d8d1` | Hardening Task 1 (Correct Live Gate Semantics) | `npm run verify` — 227 unit/e2e tests, 19 integration, build, typecheck clean | Split default-free (`verify:mcp-live` with NVIDIA+OpenRouter) from OpenRouter-only (`verify:openrouter-free-live`) live gates. Added `verify:mcp-live` script. Updated require-live-env.js and production-readiness-checklist.md. |
| 2026-06-15 | `ca935e8`+`668efca` | Hardening Task 2 (Role-Specific Model Probes) | `npm run verify` — 227 unit/e2e tests, 19 integration, build, typecheck clean | Added `jsonMode` to VisionJsonRequest. Added role-specific probes (5 images auditor/reviewer, 4 recovery). Added ModelRouteCapabilities to model-registry. findValidProbe() requires schemaValid+contentAccurate+maxImages. Fixed Gemma typo and e2e mock fields. |
| 2026-06-15 | `c040047` | Hardening Task 3 (Deterministic Geometry Diffs) | `npm run verify` — 227 unit/e2e tests, 19 integration, build, typecheck clean | Added deterministic-diffs.ts with unionBox and buildDeterministicDiffs. Integrated into pipeline before model audit. Documented known coverage limitation. |
| 2026-06-15 | `37fa29d`+`5691de1` | Hardening Task 4 (Weak Label Pairing) | `npm run verify` — 228 unit/e2e tests, 19 integration, build, typecheck clean | Added normalizeElementLabel() to element-map.ts. Geometry-aware type score in pair-elements.ts. Gemini improvement: textScore uses label for deterministic-source elements. |
| 2026-06-15 | this commit | Hardening Task 5 (Bound Target Recovery) | `npm run verify` — 229 unit/e2e tests, 19 integration, build, typecheck clean | Added RecoveryBudget interface with env overrides. Components sorted (pixelCount desc) and capped at maxComponents. Deadline and model-call-cap checks. RecoverySummarySchema in core.ts. recoverySummary recorded in pipeline. |

## Handoff Checklist

| 2026-06-15 | this commit | Hardening Task 6 (Checkpoint Reports) | `npm run verify` — 234 unit/e2e tests, 19 integration, build, typecheck clean | Added StageStatusSchema to core.ts, stages field to UiDiffReportSchema. writeReportCheckpoint() in report-writer.ts (atomic tmp→rename). Checkpoints after locator+pairing, probing, audit, and recovery in pipeline. New report-writer.test.ts. |

| 2026-06-15 | this commit | Hardening Task 7 (MCP Long-Run Handle) | `npm run verify` — 234 unit/e2e tests, 21 integration, build, typecheck clean | Created run-store.ts (in-memory + filesystem). Added start_ui_diff_run and get_ui_diff_run_status tools. discover_ui_diffs enforces UI_DIFF_FOREGROUND_BUDGET_MS (default 45000ms) and returns structured incomplete on timeout. recoverySummary added to CompareUiImagesOutputSchema. |

| 2026-06-15 | `5eae958` | Hardening Task 7 schema/type fixes | `npm run verify` — 241 unit/e2e tests, 21 integration, build, typecheck clean | Fixed stray `ptional()` in tool-schemas.ts, added missing `label` to StartUiDiffRunInputSchema, corrected `handleStartUiDiffRun` label param type for exactOptionalPropertyTypes. |
| 2026-06-15 | `4fab69d` | Coverage repair: new test files | `npm run test:coverage` — 85.14% stmts / 71.37% branches / 87.83% funcs / 86.83% lines (all thresholds met) | Added unit tests for run-store, server handlers (start/status/queued), writeJsonArtifact, deduplicateDiffs severity-upgrade branch, and selectTriggeredCriteria icon/overlap/state/chart branches. |

| 2026-06-15 | `5c20e53` | Live gate test fixes (foreground budget + async handle) | `npm run typecheck` clean | Updated mcp-openrouter-free and mcp-full live tests to pass UI_DIFF_FOREGROUND_BUDGET_MS=240000; switched Calorix bounded and full tests to start_ui_diff_run + polling so the MCP server never holds a request open longer than 45s. |

## Live Gate Hardening Sign-Off — 2026-06-15 (SUPERSEDED)

> **SUPERSEDED by fresh gate run at `7ab7733` on 2026-06-15T16:54Z.**
> The Calorix rows below were green at commit `5c20e53` but the fresh run failed with
> `locatorCoverageStatus: "weak"`. The current release is blocked. See the fresh-run
> results in `docs/release/2026-06-15-production-readiness-report.md`.

**Commit at sign-off:** `5c20e53`

| Gate | Command | Duration | Result |
| --- | --- | --- | --- |
| Deterministic verify | `npm run verify` | ~45s | 241 unit/e2e + 21 integration tests passed, typecheck clean, build clean |
| Coverage | `npm run test:coverage` | ~15s | 85.14% stmts / 71.37% branches / 87.83% funcs / 86.83% lines — all thresholds met |
| NVIDIA free live | `verify:nvidia-live` | ~12s | 4/4 passed |
| OpenRouter free live | `verify:openrouter-free-live` | ~86s | 2/2 passed; OpenRouter auditor and reviewer selected and passing probe |
| Default MCP live | `verify:mcp-live` | ~104s | 1/1 passed; `status !== "failed"`, `visualClassificationStatus: "complete"`, deterministic geometry diffs recorded |
| Calorix bounded smoke | `verify:calorix-live` (`UI_DIFF_MAX_AUDIT_PAIRS=3`) | ~412s | 1/1 passed — **result invalidated by fresh run failure** |
| Calorix full audit | `verify:calorix-full-live` (unbounded) | ~432s | 1/1 passed — **result invalidated by fresh run failure** |

**Remaining known risk:** Union-box deterministic geometry coverage may over-cover: unrelated pixel changes inside a union box are not sent to recovery until shape-aware coverage is implemented. Documented in the production-readiness checklist.

- Current task: Screen parser locator hardening research and implementation plan - **COMPLETE in this commit**
- Active plan: `docs/superpowers/plans/2026-06-15-live-gate-hardening.md` — all 8 tasks complete
- Last verification: Full live gate suite run on 2026-06-15T16:54Z at HEAD `7ab7733`. Results in `docs/release/2026-06-15-production-readiness-report.md`.
- Next task: Execute `docs/superpowers/plans/2026-06-15-screen-parser-locator-hardening.md`, starting with per-image locator diagnostics and coverage scoring.
- Blockers: **RELEASE BLOCKED** — `verify:calorix-live` failed with `locatorCoverageStatus: "weak"` on real Calorix UI screenshots. The new screen-parser hardening plan addresses this by demoting LocateAnything from single source of truth, adding multi-lane screen parsing, NMS, per-image coverage gates, and cold-start hardening.

## Screen Parser Locator Hardening Plan - 2026-06-15

**Document:** `docs/superpowers/plans/2026-06-15-screen-parser-locator-hardening.md`

**Reason:** The fresh Calorix gate showed LocateAnything-only discovery is not reliable enough for dense real mobile screenshots. The plan researches and replaces that single-lane locator strategy with a measured screen parser architecture: deterministic CV, OCR boundary, optional OmniParser, optional local YOLO UI detector, LocateAnything as a demoted grounding lane, lane-aware NMS, per-image coverage scoring, target-map diagnostics, and stricter live gates.

**Gemini review:** Gemini 3.1 Pro Preview independently reviewed the locator problem and recommended pivoting from LocateAnything-only discovery to a dedicated screen parser, preferring OmniParser-style parsing or YOLO+OCR. It later reviewed the plan and identified duplicate multi-lane boxes as the main implementation risk; Task 7 now includes explicit NMS tests and `suppressDuplicateElements()`. Final blocker-only retry did not return the exact requested template but stated that the multi-lane screen parser, deterministic CV/OCR, optional OmniParser/YOLO, NMS, and strict per-image coverage plan addresses the root cause.

## Last Persisted Run Review - 2026-06-15

**Document:** `docs/release/2026-06-15-last-run-readiness-review.md`

**Result:** the latest persisted Calorix report does not prove production readiness. It records `locatorCoverageStatus: "weak"` and `visualClassificationStatus: "incomplete"`. That shape is useful regression evidence because the current hardened live gates should reject it.

**Code follow-up:** fixed the P3 live-test wording so the comments match the actual predicate: live gates now require a non-deterministic, model-reviewed diff and do not imply `not_reviewed` covers deterministic records by itself.
