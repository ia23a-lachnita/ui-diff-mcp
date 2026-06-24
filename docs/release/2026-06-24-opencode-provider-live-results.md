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

Rerun `verify:calorix-full-live`, then `verify:calorix-release-live`. Production approval requires complete visual classification, zero failed or remaining audit pairs, zero unresolved recovery regions, and successful semantic stage outcomes.
