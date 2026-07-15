# Fresh Release Recovery Hardening Results

**Date:** 2026-07-15  
**Verified code:** `c138175` on `master`  
**Recommendation:** Production-ready for automated Calorix UI-diff release gates. The current Today screen still has reported UI differences; that is application output, not a pipeline failure.

## Deterministic Verification

- `npm run verify`: PASS — 1,067 unit/e2e, 20 sidecar/parser, 22 integration.
- `npm run test:coverage`: PASS — 91.56% statements, 78.54% branches, 92.64% functions, 93.33% lines.
- Typecheck and build: PASS.

## Live Gates

| Gate | Result | Evidence |
|---|---|---|
| Mistral | PASS 2/2 | 1.8s |
| NVIDIA | PASS 4/4 | 271s; functional but slow |
| OpenRouter free | PASS | 2 tests passed, 3 intentionally skipped; 342s |
| Default MCP | PASS 1/1 | 139s |
| Gemini direct | FAIL 2/2 | HTTP 503 high demand; provider outage, not pipeline failure |
| OpenCode direct | FAIL 2 inference / PASS 1 config | HTTP 429 `FreeUsageLimitError` |
| Calorix deterministic | PASS | `run-1784137506128-793ccc`; fresh auto-capture |
| Calorix bounded | PASS diagnostic | `run-1784137777850-2aac5a`; intentionally limited/incomplete |
| Calorix full | PASS | `run-1784138368498-670b77`; complete, uncapped |
| Calorix strict release | PASS | `run-1784139601195-22f9d9`; fresh auto-capture, strict assertions |

## Strict Release Report

- Status `complete`; durable final report; `visualClassificationStatus: complete`; `auditLimited: false`.
- Pair accounting: 67/67 selected pairs provider-called and reviewed; 8 deterministic pre-audit pairs; 0 failed/remaining.
- Recovery: 10/10 eligible components completed; 0 remaining/unclassified; no deferred broad fragments.
- Final output: 111 diffs, 62 groups, 21 broad diagnostic records, 0 unresolved or escalated records.
- Sources: 97 `vlm_reviewed`, 8 `target_recovery`, 6 `deterministic_projected_mismatch`.
- Group integrity: 111 references, all unique; no missing/dangling references or self-child IDs; summary count equals legend count.
- Usage: 536,537 input tokens; 51,510 output tokens; 588,047 total; 460 calls; 12 errors; 3 fallbacks; 0 route exhaustion; 1,336,461ms aggregate provider-call duration.
- Selected auditor/reviewer/recovery: `mistral/ministral-14b-2512`. Recorded alternatives: Mistral 8B and NVIDIA Nemotron Omni 30B.
- Provider trace preserved probe 429/404/timeouts plus runtime Mistral schema-invalid, 429, 500, and truncated-JSON errors. Fallbacks completed the run.

## Artifact Inspection

- Inspected expected image, actual comparison image, full group overlay, unresolved overlay, legend, and all eight generated priority zooms.
- Every artifact exists with valid PNG dimensions. All 62 labels match `G<number>` and every group retains criteria and diff IDs.
- Priority zooms are readable and repair-local. The full-screen overlay remains dense at 62 groups, especially around the header, macro rows, and navigation. This is a usability follow-up, not a report-integrity blocker because references and zoom/legend navigation are complete.
- Visual validation was exhaustive for generated group-level artifacts, but not an independent semantic re-review of all 111 criterion-level findings; only eight priority groups receive zoom artifacts by design.

## External Review

Antigravity MCP post-review was requested with `gemini-3.1-pro-preview` and the required read-only/no-mutation prompt. The MCP rewrote it to invalid `gemini-3.1-pro` and failed before analysis. No substitute was used and no external review was counted as green.

