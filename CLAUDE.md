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
