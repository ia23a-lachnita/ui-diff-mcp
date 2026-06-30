# OpenCode Provider Live Results - 2026-06-24

## Decision

Production release is **not yet approved**. OpenCode MiMo V2.5 Free is a viable visual provider, but corrected full and strict Calorix evidence is still required.

## Passing Evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| OpenCode provider | PASS | 3/3 tests in 7.07 s: catalog eligibility, one-image structured vision, and one deduplicated five-image auditor/reviewer/recovery probe. Provider returned `xiaomi/mimo-v2.5-20260422`. |
| Default MCP | PASS | 1/1 current-head live test; exact provider/model selection and indexed comparison-space artifact were present. |
| Calorix bounded diagnostic | PASS (degraded by design) | `run-1782240070312-58e556`: 3/3 selected pairs called, validated, and reviewed; 28/28 runtime provider calls succeeded; no fallback or provider error. Classification remained incomplete because the run was intentionally limited and recovery reached its deadline with 36 unresolved regions. |
| Deterministic suite | PASS | 498 unit/e2e, 16 sidecar, and 22 integration tests; typecheck/build clean. |
| Coverage | PASS | 89.70% statements, 75.44% branches, 91.53% functions, 91.69% lines. |
| Security audit | PASS | Zero critical vulnerabilities. |

## Full Diagnostic Finding

Run `run-1782240372957-238969` completed all 71 selected VLM pairs and wrote a durable report, but it is not release evidence:

- one reviewer request encountered four consecutive transient route timeouts;
- the fallback caller permanently exhausted the reviewer route set for the run;
- 161 later criteria became `reviewer_error` without a new provider call;
- pair accounting treated `reviewer_error` as valid and reported the audit stage as successful;
- recovery stopped at `model_call_cap` with 23 unclassified regions.

Two TDD fixes now supersede that behavior:

1. Timeouts, network failures, and HTTP 5xx responses fall back for the current request but are eligible again on the next request. HTTP 429 and repeated malformed structured output remain run-sticky.
2. `reviewer_error`, auditor errors, schema errors, and empty evidence mark the pair failed, which makes the audit stage semantically incomplete.

## Next Gate

Corrected full diagnostic run `run-1782273698879-b00df7` passed its diagnostic harness in 1,192.6 seconds and produced truthful incomplete outcomes:

- all 71 selected pairs entered the VLM path and all 71 received reviewer attempts;
- 22 pairs failed because OpenCode intermittently returned HTTP 400 `Multimodal data is corrupted` for locally valid PNG evidence;
- audit outcome: `incomplete / failed_pairs`;
- recovery outcome: `incomplete / model_call_cap`, with 21 unresolved regions;
- the comparison-space artifact was indexed.

Replaying one failed five-image payload proved that OpenCode accepted the same valid images afterward, so this provider-specific 400 is now retryable across routes for the current request. It does not permanently quarantine OpenCode.

Run `verify:calorix-release-live` from the corrected commit. Production approval requires complete visual classification, zero failed or remaining audit pairs, zero unresolved recovery regions, and successful semantic stage outcomes.

## Strict Gate Finding

Strict run `run-1782275065154-88c1e0` failed after 1,352.7 seconds, but isolated the remaining pipeline issue cleanly:

- audit: 71/71 pairs entered, 71 reviewed, zero failed, zero remaining, semantic outcome `success`;
- provider routing: 33 intermittent OpenCode multimodal HTTP 400s fell through successfully, proving the provider correction works at full scale;
- recovery: 22/24 attempted regions were rejected as `box_no_component_overlap`, one region was skipped by the 24-call cap, and 23 remained unresolved;
- recovery outcome: `incomplete / model_call_cap`;
- strict result: FAIL, correctly blocked on `visualClassificationStatus: incomplete`.

Root cause: recovery supplied only region-local crops but demanded a full-screen box, then compared the crop-local model answer to absolute component coordinates. The deterministic pixel component already owns the full-screen location. Recovery now asks the VLM only for semantic classification, anchors accepted findings to deterministic component geometry, raises the default model-call cap to 200, and raises the default recovery deadline to 15 minutes. A fresh strict run is required.

Strict run `run-1782276794272-5f4ab7` validated that recovery correction: 23/24 eligible regions resolved, including 13 accepted semantic findings and 10 noise verdicts. One reviewer rejection remained unresolved. Audit stopped at pair 48 after OpenCode reached its free 429 and each remaining route returned one empty structured response; 23 audit pairs remained.

The same run finalized seconds after the gate's 24-minute poll loop, exposing a harness race even though the outer test timeout is 40 minutes. The next correction:

- only HTTP 429 permanently quarantines a route for the run;
- empty/malformed structured responses and timeouts remain request-scoped;
- all-route transient exhaustion is recorded as a failed pair instead of aborting every later pair;
- auditor output budget is 8,192 tokens so reasoning models can emit their JSON;
- the strict poll window is 38 minutes.

A fresh strict run is still required. Release remains blocked until that gate returns complete classification with zero failed/remaining audit pairs and zero unresolved regions.

## 2026-06-30 Current-Head Rerun

Production release is still **blocked**. The provider smoke gates and bounded diagnostic path are useful, but the unbounded full Calorix run did not finish inside the 40-minute gate window and therefore did not produce a final, non-checkpoint report.

| Gate | Result | Evidence |
| --- | --- | --- |
| NVIDIA live | PASS | 4/4 tests, 163.7s. |
| OpenRouter free live | PASS | 2 active tests passed, 3 skipped, 53.4s. |
| MCP default live | PASS | 1/1 passed, 55.5s. |
| OpenCode live | FLAKY | First scripted run failed the five-image role probe. Direct replay passed all three roles in 1.85s. Scripted rerun failed one-image JSON with `ProviderJsonParseError: invalid_json`; direct replay recovered with `retryDecision: same_route_compact_retry` and provider usage `prompt_tokens=281`, `completion_tokens=7`. |
| Calorix bounded diagnostic | PASS (degraded by design) | `run-1782801862055-65807d`, 3/3 selected VLM pairs audited/reviewed, `auditLimited:true`, 42 diffs. Recovery completed 39 eligible components, accepted 34 recovery diffs, and left zero unclassified components. |
| Calorix full diagnostic | FAIL / TIMEOUT | `run-1782802261817-8895d7` timed out at 40 minutes. The checkpoint has `status:"running"`, `visualClassificationStatus:"incomplete"`, 71/71 selected VLM pairs audited/reviewed, and 170 checkpoint diffs (8 deterministic projected mismatches, 162 VLM-reviewed accepted). It did not write a final report, provider-trace artifact, debug artifacts, or recovery summary before the test process ended. |
| Calorix strict release | NOT RUN | Skipped after the full diagnostic timeout. Strict release remains blocked until full diagnostic completes as a final report. |

### Diffs Visible In The Full Checkpoint

The full checkpoint is not production evidence, but it does show the VLM audit path was exercised:

- 8 deterministic projected mismatches, grouped around structural displacement/region mismatches.
- 162 VLM-reviewed accepted diffs.
- Criterion counts: 65 geometry, 56 spacing/alignment, 49 color/appearance.
- Example accepted VLM findings include vertical shifts in the calorie summary text block, shifted/tighter nutrient-label spacing, the Chicken Rice Bowl list item being lower/differently spaced, and displaced ring/text content.

The number of checkpoint diffs is still not a clean user-facing final count because consolidation and final recovery/report writing did not complete.

### Follow-Up Implemented

The timeout exposed an observability hole: checkpoint reports only contained `runArtifacts` from early deterministic stages, while `provider-trace.json` was written only during final report creation. Future interrupted runs now:

- flush `provider-trace.json` on every checkpoint, including token usage when providers return it;
- include the provider trace artifact in checkpoint `runArtifacts`;
- write a `target_recovery` stage checkpoint with `status:"running"` before long recovery work starts.

Verification after this change: `npm run verify` passed with 509 unit/e2e tests, 16 Python sidecar parser tests, and 22 integration tests.
