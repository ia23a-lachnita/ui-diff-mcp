# Report Integrity Live Results - 2026-06-21

## Decision

**Production release is blocked.** The report-integrity implementation and diagnostic gates are green, but the strict Calorix release gate correctly rejects incomplete classification and unresolved canonical regions.

## Gate Results

| Gate | Result | Duration / evidence |
| --- | --- | --- |
| Deterministic verify | PASS | 450 unit/e2e + 22 integration + 16 Python sidecar tests; typecheck and build clean |
| Coverage | PASS | 88.76% statements / 73.04% branches / 91.21% functions / 91.06% lines |
| Critical dependency audit | PASS | 0 vulnerabilities |
| NVIDIA free live | PASS | 4/4 in 59.6s |
| OpenRouter free live | PASS | 2 active tests passed / 3 skipped in 56.9s |
| Default MCP live | PASS | 1/1 in 52.6s |
| Calorix bounded diagnostic | PASS | `run-1782076880836-cc3574`, 230.8s |
| Calorix full diagnostic | PASS (degraded) | `run-1782077590711-853911`, 260.9s; incomplete classification remains release-blocking |
| Calorix strict release | FAIL (correctly blocked) | `run-1782078470566-1c2641`, 290.8s |

## Calorix Evidence

| Field | Bounded | Full diagnostic | Strict release |
| --- | ---: | ---: | ---: |
| Final findings | 9 | 9 | 8 |
| Unresolved regions | 60 | 91 | 96 |
| Total pairs | 79 | 79 | 79 |
| Selected audit pairs | 3 | 71 | 71 |
| Entered pairs | 2 | 2 | 2 |
| Provider-called pairs | 2 | 2 | 2 |
| Valid auditor pairs | 1 | 1 | 0 |
| Reviewed pairs | 1 | 0 | 0 |
| Failed pairs | 1 | 1 | 2 |
| Remaining pairs | 1 | 69 | 69 |
| Pre-audit deterministic pairs | 8 | 8 | 8 |
| Audit stop | route exhausted | route exhausted | route exhausted |
| Recovery stop | component cap | deadline exceeded | deadline exceeded |

All three reports are durable final reports (`status:"complete"`, `isCheckpoint:false`). Their visual classification status is `incomplete`, so none is production sign-off evidence.

The strict report contains eight deterministic projected-mismatch findings and 96 separately tracked unresolved canonical regions. No raw region is emitted as an `unclassified_visual_change` final finding. The gate also found no unresolved review escalation and no accepted finding missing `classificationSource`.

## Provider Diagnostics

The final strict run records these structured failure classes without raw prompts, images, credentials, or full provider bodies:

- Auditor routes returned empty content; parsed outputs that reached audit validation contained empty evidence.
- NVIDIA target recovery returned HTTP 429, empty content, and a timeout across routes.
- OpenRouter target recovery returned empty content after fallback.
- Terminal auditor route exhaustion left 69 selected pairs unscheduled.
- Recovery preserved remaining work as unresolved regions when its deadline expired.

An earlier strict run exposed malformed recovery JSON with `finishReason:"length"`. Commit `c8a9f5f` adds a red/green regression and classifies provider length stops as `truncated_json` even when a fragment ends in a closing bracket, allowing the one bounded compact retry. The post-fix strict sample did not produce another length-stopped malformed response, so that branch is verified deterministically rather than by a repeated live occurrence.

## Independent Review

Gemini 3.1 Pro Preview reviewed the implementation and live evidence through the Antigravity MCP conversation `ui-diff-report-integrity-implementation-20260621`.

- `AGREEMENT_STATUS: agree`
- `MUST_FIX: none`
- `SHOULD_FIX: none`
- `QUESTIONS: none`

The reviewer found the current release block provider/capacity-caused: the pipeline reports route exhaustion, remaining work, unresolved regions, and durable partial evidence honestly. Production sign-off requires a route with enough reliable quota/capacity to complete the strict gate; a degraded diagnostic pass does not substitute for it.
