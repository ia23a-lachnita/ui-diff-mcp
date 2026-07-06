# Agent Instruction & Config Audit — ui-diff-mcp (2026-07-06)

Scope: agent instruction files, agent/host configuration, and repo hygiene. This is not a code-correctness audit; code-level correctness is covered by the test suites, live gates, and the Antigravity review log in `docs/implementation-status.md`.

## Findings and status

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | `CLAUDE.md` duplicated roughly half of `AGENTS.md` (session-start list, tracking rules). Two copies of the same contract drift apart silently. | **Fixed**: `CLAUDE.md` now imports `AGENTS.md` and only carries Claude-specific notes; `AGENTS.md` is the single contract. |
| 2 | Medium | Antigravity review tool was documented only as `mcp__antigravity_mcp__ask_ai` (Codex underscore form). In Claude Code the tool is `mcp__antigravity-mcp__ask-ai`; an agent following the doc literally would fail the call or conclude the tool is missing. | **Fixed**: both host-specific names documented in the toolset-scope table. |
| 3 | Medium | `LOCATEANYTHING_PYTHON` was missing from the required-environment table even though interpreter drift (plain `python` resolving to a Torch-less venv) caused the 2026-07-06 real-model readiness failure. | **Fixed**: added to the env table with the known venv path. |
| 4 | Low | The Calorix smoke example command still set `UI_DIFF_LIVE_ACTUAL_IMAGE`/`UI_DIFF_LIVE_EXPECTED_IMAGE`, contradicting the rule that auto-capture is the default and the actual-image variable is a historical override only. | **Fixed**: example updated; env table row re-labeled override-only. |
| 5 | Low | `docs/implementation-status.md` lines ~17–27 restate contract rules (review tooling, commit/push cadence, handoff requirements) that now live in `AGENTS.md`. Same drift risk as finding 1. | **Open (recommendation)**: replace the restated bullets with a pointer to `AGENTS.md`; keep only state, blockers, and the progress log in the status file. |
| 6 | Low | No toolset scope was defined anywhere: agents did not know which capabilities (subagents, background tasks, plan tools) each host has, which matters because the repo is worked on by both Codex and Claude Code. | **Fixed**: toolset-scope table added to `AGENTS.md` section 4. |
| 7 | Medium | A pre-commit hook rejects commits containing model/tool names or `Co-Authored-By:` trailers, but no instruction file mentioned it; agents hit the block and had to discover the rule by trial. | **Fixed**: commit-message rule added to the non-negotiables in `AGENTS.md`. |
| 8 | Info | Google MCP connectors (`gcloud`, and the Firebase plugin in Codex) were enabled by default machine-wide although this project never uses them. | **Fixed** (machine-level config): disabled by default; contract now forbids silently re-enabling them. |

## Known open project blockers (from `docs/implementation-status.md`, unchanged by this audit)

- Fresh Calorix release-live gate with the real LocateAnything model is still pending; the latest release evidence (`run-1783333420302-fd11fb`) is a skip-model diagnostic pass.
- Calorix Today visual parity is not achieved (91 final diffs on the last hydrated report; device/reference aspect ratio differs by 2.16%).
- Provider instability: Gemini 3.1 Pro / 3.5 Flash quota (429), Mistral 14B 429 fallback to 8B, OpenRouter-only free route availability, OpenCode public/free probe failures.
