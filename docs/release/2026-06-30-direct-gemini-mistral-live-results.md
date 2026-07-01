# Direct Gemini/Mistral Provider Live Results - 2026-06-30

## Implementation Result

Direct Gemini and direct Mistral provider adapters are implemented and probe-gated.

- Gemini adapter: `gemini-3.5-flash` is the current live-gate route. `gemini-3.1-pro-preview` is visible in the model list but returned free-tier quota `limit: 0` during direct probing, so it remains quality-ranked but fail-closed.
- Mistral adapter: `ministral-14b-2512` is the current live-gate route. `ministral-8b-2512` also passed the five-image role probe. `mistral-large-2512`, `mistral-medium-2604`, and `mistral-small-2603` were not selected because live probes misclassified or miscounted simple image payloads.

## Verification

Deterministic verification:

- `npm run verify` PASS after external-review fallback-cap fix: 517 unit/e2e tests, 16 sidecar parser tests, 22 integration tests, typecheck and build clean.

Provider gates:

| Gate | Result | Notes |
| --- | --- | --- |
| `verify:gemini-live` | PASS | `gemini-3.5-flash` passed one-image structured JSON and five-image role probes. |
| `verify:mistral-live` | PASS | `ministral-14b-2512` passed one-image structured JSON and five-image role probes. |
| `verify:nvidia-live` | FAIL | No native NVIDIA reviewer route passed the reviewer probe in this run. |
| `verify:openrouter-free-live` | FAIL | Provider smoke passed active OpenRouter checks, but the MCP OpenRouter-only run had no selected auditor/reviewer route. |
| `verify:opencode-live` | FAIL | OpenCode returned HTTP 429 `FreeUsageLimitError`. |
| `verify:mcp-live` | PASS | Default free-mode MCP smoke passed with the new provider set available. It was rerun after the fallback `maxCandidates` cap fix and remained green. |

Calorix gates:

| Gate | Result | Run ID | Notes |
| --- | --- | --- | --- |
| `verify:calorix-live` | PASS diagnostic | `run-1782825610895-462a0a` | Bounded 3-pair smoke, `auditLimited:true`, `visualClassificationStatus:"incomplete"` as expected for bounded mode. |
| `verify:calorix-full-live` | PASS diagnostic | `run-1782826139774-c53fd4` | Full unbounded diagnostic completed in about 16 minutes using Gemini 3.5 Flash, but remained `visualClassificationStatus:"incomplete"` with 2 unresolved regions. |
| `verify:calorix-release-live` | FAIL release | `run-1782827119715-d751f4` | Completed all 71 selected audit pairs with zero audit failures using Mistral Ministral 14B, but release failed because visual classification remained incomplete. |
| `verify:calorix-release-live` | FAIL release | `run-1782886503519-a3233c` | Fresh 2026-07-01 strict run reached the full pipeline with `LOCATEANYTHING_SKIP_MODEL=1`. It completed all 71 selected/provider-called audit pairs with zero failed or remaining audit pairs, `auditLimited:false`, and no `needs_escalation`, but release still failed because recovery left 2 unresolved edge-fragment regions. |

## Strict Release Blocker

The strict release run is not production-ready:

- `visualClassificationStatus:"incomplete"`
- `unresolvedRegions.length === 1`
- `recoverySummary.unclassifiedCount === 1`
- `recoverySummary.statusCounts.recovery_rejected === 1`
- One final diff remained `reviewerStatus:"needs_escalation"`

The one unresolved region (`region-0871`) is a small curved/ring edge around `x=860,y=173,w=41,h=76`. Its artifacts show expected nearly black pixels and an actual visible gray arc, so it appears to be a real visual difference that recovery did not resolve.

The `needs_escalation` diff (`984e090cb0e3`) concerns the text crop for `left`: expected shows the word `left`, actual is essentially a green bar/blank region, and the overlay shows missing/misaligned expected text. This is also a real mismatch, but the reviewer left it unresolved, so the release gate correctly failed.

## Fresh Strict Release Rerun - 2026-07-01

Run ID: `run-1782886503519-a3233c`.

Startup note: two attempts without `LOCATEANYTHING_SKIP_MODEL=1` failed before the pipeline because `/health` returned HTTP 200 but did not report `ready:true` inside the 120s helper window while the heavyweight LocateAnything worker loaded. The successful pipeline run used the sidecar v2 deterministic parser lanes with the worker skipped.

Report summary:

- `status:"complete"`
- `visualClassificationStatus:"incomplete"`
- `locatorCoverageStatus:"complete"`
- `viewportCompatibilityStatus:"mismatch"`
- `auditLimited:false`
- Audit scope: 79 total pairs, 71 selected, 71 audited/provider-called, 0 failed pairs, 0 remaining pairs, `stoppedReason:"none"`
- Final diffs: 167 total; 165 accepted, 2 `not_reviewed`
- Classification sources: 141 `vlm_reviewed`, 24 `target_recovery`, 2 `deterministic_projected_mismatch`
- Criteria: 59 geometry, 51 spacing/alignment, 44 color/appearance, 7 icon/image, 5 typography/content, 1 presence

Model/provider behavior:

- Probe ranking selected `gemini/gemini-3.5-flash` as auditor, reviewer, and target-recovery route. `gemini/gemini-3.1-pro-preview` still failed probes with HTTP 429 quota.
- Runtime fallback worked: Gemini 3.5 hit HTTP 429 after initial calls, then Mistral 14B was tried, then Mistral 8B handled most audit/reviewer calls after Mistral 14B rate-limited on audit/reviewer.
- Provider trace call successes: 436 total. Token trace total: 485,933 total tokens and 1,266 reasoning tokens where providers reported them.
- Recovery used Mistral 14B successfully for 28 target-recovery calls after Gemini 3.5 recovery hit HTTP 429.

Release blocker after rerun:

- No `needs_escalation` diffs remain.
- The two deterministic `not_reviewed` projected mismatches are valid final deterministic findings, not blockers:
  - `396c1ca6c6b3` / `projected_crop_low_overlap`
  - `6f642ae8f9e7` / `projected_crop_high_diff_mass`
- Recovery remains incomplete:
  - `recoverySummary.unclassifiedCount === 2`
  - unresolved `region-0847`
  - unresolved `region-0861`

Visual validation performed: sampled, not exhaustive. The two deterministic projected group overlays were inspected and both looked like real structural UI mismatches. The two unresolved recovery regions were inspected and both looked like tiny edge/corner fragments rather than meaningful standalone UI diffs. This suggests the next pipeline work should focus on residual edge-fragment filtering or coverage attribution after structural projected findings, not broad provider failure.

## External Run Review

Antigravity MCP with `gemini-3.1-pro-preview` independently reviewed the strict run after implementation.

- Review result: `AGREEMENT_STATUS: agree`; the run is not production-ready.
- The reviewer confirmed the exact blockers: unresolved recovery `region-0871` and active escalation diff `984e090cb0e3`.
- The reviewer found that diff `984e090cb0e3` is visually a missing-text/presence issue rather than a reliable spacing-baseline finding.
- The reviewer confirmed the report/trace defect that reviewer reasons were parsed but not persisted onto final diff records. This is fixed for future reports by adding `reviewerReason` to VLM and target-recovery diff records.
- MCP response noise: the first strict-run review was clean. The follow-up implementation-plan review on 2026-06-30 returned the requested green verdict, but prefixed it with implementation-like "I will update..." lines even though the MCP did not edit files; treat that as harmless wrapper/tool noise, not as repo changes.
- **Gemini Runtime Update**: During the strict Calorix run runtime, the Gemini API routes failed with HTTP 429 due to quota limitations. However, the Gemini API itself works fine under ordinary quota.
- **Fresh Gemini Live Check**: A follow-up `npm run verify:gemini-live` using the user-level `GEMINI_API_KEY` also reached Gemini and failed with HTTP 429 before structured parsing. The user's separate Git Bash curl demonstrates that a Gemini key/model can work under a different quota state or environment value; the local gate result remains quota-blocked for the key visible to this PowerShell/Codex process.
- **Bug Fixes Applied**:
  1. Fixed a separate client bug where Gemini's `MAX_TOKENS` finishReason was not treated as a truncation signal, preventing `withStructuredRetry` from retrying the request.
  2. Fixed target recovery tracing so reviewer rejection reasons are successfully persisted in `recovery-trace.json` and outcome summaries for future reports.

## Production Decision

Not production-ready yet. The provider capacity blocker is materially improved: the full run no longer times out, and Mistral completed all audit pairs. The remaining blockers are now pipeline/report semantics around unresolved recovery rejection and `needs_escalation` final diff handling, not total provider unavailability. The new MAX_TOKENS fix and recovery rejection reason persistence are verified and active for the next run.

## Region Context And Residual Dedup Rerun - 2026-07-01

Implementation plan: `docs/superpowers/plans/2026-07-01-region-context-and-residual-dedup.md`.

Verification:

| Gate | Result | Notes |
| --- | --- | --- |
| `npm run verify` | PASS | 530 unit/e2e tests, 16 Python sidecar parser tests, build/typecheck clean, 22 integration tests. |
| `verify:gemini-live` | PASS | 2/2. |
| `verify:mistral-live` | PASS | 2/2. |
| `verify:nvidia-live` | PASS | 4/4. |
| `verify:mcp-live` | PASS | 1/1 after final escalation filtering. |
| `verify:calorix-live` | PASS | Bounded smoke passed with `UI_DIFF_MAX_AUDIT_PAIRS=3`. |
| `verify:calorix-full-live` | PASS diagnostic | Passed before the final escalation filtering patch. |
| `verify:calorix-release-live` | PASS release | Strict run `run-1782901487720-7911f4`. |
| `verify:openrouter-free-live` | FAIL | OpenRouter-only MCP run did not select an OpenRouter auditor/reviewer route. Treat as provider-route availability, not core pipeline evidence. |
| `verify:opencode-live` | FAIL | OpenCode public/free route returned HTTP 429 `Too many requests`. |

Strict release run: `run-1782901487720-7911f4`.

Report summary:

- `status:"complete"`
- `visualClassificationStatus:"complete"`
- `locatorCoverageStatus:"complete"`
- `viewportCompatibilityStatus:"mismatch"` with source crops preserved and safe classification sources
- `auditLimited:false`
- Audit scope: 79 total pairs, 8 deterministic pre-audit pairs, 71 VLM-audited pairs, 0 failed pairs, 0 remaining pairs, `stoppedReason:"none"`
- Recovery: 24 uncovered regions after clustering, 23 eligible/attempted, 23 completed, 21 recovered final diffs, 2 `classified_false`, 1 below threshold, 0 unclassified, `stoppedReason:"none"`
- Final diffs: 210 total; 208 accepted, 2 deterministic `not_reviewed`, 0 `needs_escalation`
- Classification sources: 187 `vlm_reviewed`, 21 `target_recovery`, 2 `deterministic_projected_mismatch`
- `unresolvedRegions.length === 0`
- Residual fragment handling: `debugSummary.coverageResidualNoise === 7`

Provider behavior:

- Selected route for auditor/reviewer/target recovery: `mistral/ministral-14b-2512` with `costClass:"free"`.
- Provider trace: 427 `call_success`, 0 `call_error`, 0 `fallback`, 0 `route_exhausted`.
- Provider trace total token count: 474,409.

New artifacts:

- `artifacts/final-diff-regions-overlay.png`
- `artifacts/unresolved-regions-overlay.png`
- `artifacts/region-context-overlay.png`
- `artifacts/coverage-trace.json`
- `artifacts/recovery-trace.json`

Visual validation performed: sampled, not exhaustive. The latest unresolved overlay was inspected and contains no unresolved magenta boxes because the final report has zero unresolved regions. The combined context overlay was inspected and shows final finding boxes plus element/card outlines, making the full-screen origin of diffs visible. The overlay is dense on Calorix-scale screens, so later polish can improve readability, but it satisfies the report-truth/debuggability requirement.

External post-implementation review:

- Antigravity MCP with `gemini-3.1-pro-preview`: `AGREEMENT_STATUS: agree`, `MUST_FIX: none`, `SHOULD_FIX: none`.
- No unrelated MCP wrapper/noise was observed in the post-implementation review response.

Updated production decision:

The core UI-diff pipeline and Calorix strict release path are green as of run `run-1782901487720-7911f4`. Remaining caveats are provider-specific: OpenRouter-only free-mode route selection and OpenCode public/free quota are not green. Do not describe visual validation as exhaustive; only sampled artifact inspection was performed.
