# Project Instructions

- After making any repository changes, always commit them and push the branch to `origin`.
- Do not commit secrets, API keys, generated dependency folders, build output, or local run artifacts.
- If push fails because credentials, branch tracking, or remote access are unavailable, report the exact failure and leave the local commit intact.

## Required Context At Session Start

Before implementation work, every agent must read these files in order:

1. `AGENTS.md`
2. `docs/implementation-status.md`
3. `docs/superpowers/specs/2026-06-12-ui-diff-mcp-research-design.md`
4. `docs/superpowers/plans/2026-06-12-ui-diff-mcp-mvp-implementation.md`

The implementation status file is the persistent source of truth for where the project stands. If conversation context is missing, compacted, or contradictory, trust the tracked status file and then verify with `git status`, `git log -1 --oneline`, and the implementation plan checkboxes.

## Implementation Tracking Rules

- Keep `docs/implementation-status.md` accurate during implementation.
- At the start of each implementation turn, update the status file only if the current repo state differs from it.
- Before starting a plan task, set `Current Task` to that task and record the branch, commit, and intended verification command.
- After completing a task, update the plan checkbox, append a progress-log entry, record verification results, commit hash, push status, and the next task.
- If work stops mid-task, record the exact last completed step, the next command to run, open files, and any blocker.
- Never leave the status file saying a task is complete unless its verification command passed or the failure is explicitly recorded.
- Every implementation commit should include the code/docs changed for that task plus the tracking updates for the same task.
- The status file must not contain secrets, API keys, raw model credentials, or large generated artifact paths outside committed docs/examples.

## External Review Tooling

- Do not use the deprecated Gemini CLI or the `agy` Antigravity CLI for new reviews.
- Use the Antigravity MCP tool `mcp__antigravity_mcp__ask_ai`.
- For production plans, request `model: "gemini-3.1-pro-preview"`, `approvalMode: "plan"`, and a persistent `conversationId` so revisions can be reviewed in the same conversation.
- A review is green only when the response explicitly reports `AGREEMENT_STATUS: agree` and `MUST_FIX: none`. Apply must-fix feedback, then continue the same MCP conversation until green.
- If the MCP tool or requested model is unavailable, record the exact tool error. Do not silently substitute a CLI review or count an empty response as successful.

## Required Environment Variables

These must be set in the shell before running live tests or the sidecar. They are never committed to the repo.

| Variable | Required for | Value on this machine |
|---|---|---|
| `OPENCODE_API_KEY` | Optional OpenCode Zen credential override | Current public free route defaults to `public` |
| `OPENCODE_ZEN_BASE_URL` | Optional OpenCode endpoint override | `https://opencode.ai/zen/v1` (default) |
| `OPENROUTER_API_KEY` | Live model tests, free-mode pipeline | OpenRouter secret key |
| `NVIDIA_API_KEY` | NVIDIA model probes and free-mode inference | NVIDIA API secret key |
| `LOCATEANYTHING_SIDECAR_URL` | Any non-deterministic run | `http://127.0.0.1:39731` (default) |
| `LOCATEANYTHING_EAGLE_EMBODIED_DIR` | Sidecar startup | `C:\Users\xursc\projects\Eagle\Embodied` |
| `UI_DIFF_LIVE_EXPECTED_IMAGE` | Calorix live tests | Path to expected screenshot |
| `UI_DIFF_LIVE_ACTUAL_IMAGE` | Calorix live tests | Path to actual screenshot |

### Starting the LocateAnything sidecar

```powershell
# From the ui-diff-mcp project root:
.\scripts\start-locateanything-sidecar.ps1
```

The script defaults `LOCATEANYTHING_EAGLE_EMBODIED_DIR` to `C:\Users\xursc\projects\Eagle\Embodied` if not set.
The live tests (`RUN_CALORIX_UI_DIFF_LIVE=1`) auto-start the sidecar via `ensureSidecarRunning()` in
`tests/helpers/sidecar-manager.ts` — no manual startup needed as long as `LOCATEANYTHING_EAGLE_EMBODIED_DIR` is set.

### Running live gates

```powershell
# OpenRouter free-mode smoke (fixture images, ~5 min):
$env:RUN_OPENROUTER_FREE_LIVE="1"; $env:OPENROUTER_API_KEY="sk-..."; $env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"; npx vitest run tests/live/mcp-openrouter-free.live.test.ts

# Calorix smoke (real project images, sidecar auto-starts, ~20 min):
$env:RUN_CALORIX_UI_DIFF_LIVE="1"; $env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:/path/to/expected.png"; $env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:/path/to/actual.png"; $env:LOCATEANYTHING_EAGLE_EMBODIED_DIR="C:\Users\xursc\projects\Eagle\Embodied"; npx vitest run tests/live/calorix-smoke.live.test.ts
```
