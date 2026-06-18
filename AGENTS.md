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

- Do not start new plan reviews with the deprecated Gemini CLI.
- Use Google Antigravity via `agy` for Gemini-family external reviews.
- If the current terminal session does not see `agy`, refresh PATH from the Windows user/machine environment or call `C:\Users\xursc\AppData\Local\agy\bin\agy.exe` directly.
- As of 2026-06-18, `agy --print` can complete with exit code 0 but emit no stdout when launched from a non-TTY subprocess. Treat an empty captured response as a tooling failure, not a successful review. Prefer an interactive/TTY Antigravity session until upstream issue `google-antigravity/antigravity-cli#76` is fixed.

## Required Environment Variables

These must be set in the shell before running live tests or the sidecar. They are never committed to the repo.

| Variable | Required for | Value on this machine |
|---|---|---|
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
