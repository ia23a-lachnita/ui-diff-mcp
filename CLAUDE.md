# ui-diff-mcp — Claude Code Instructions

@AGENTS.md

`AGENTS.md` is the single agent contract for this repository. Follow it exactly; this file only adds Claude-Code-specific notes and must stay thin to prevent drift.

## Claude Code specifics

- The Antigravity review tool is named `mcp__antigravity-mcp__ask-ai` in Claude Code (hyphens). It is the same tool the contract calls `ask-ai`.
- Prefer built-in tools (`Read`, `Edit`, `Grep`, `Glob`, `Bash`/`PowerShell`) over shelling out; use `mcp__claude-context__search_code` for semantic codebase search before grep storms.
- Run long verifications (`npm run verify`, live gates) as background tasks and collect results before reporting.
- Track multi-step work with the task tools, but the durable record remains `docs/implementation-status.md` per the contract.
