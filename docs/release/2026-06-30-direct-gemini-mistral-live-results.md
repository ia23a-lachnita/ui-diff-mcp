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

## Strict Release Blocker

The strict release run is not production-ready:

- `visualClassificationStatus:"incomplete"`
- `unresolvedRegions.length === 1`
- `recoverySummary.unclassifiedCount === 1`
- `recoverySummary.statusCounts.recovery_rejected === 1`
- One final diff remained `reviewerStatus:"needs_escalation"`

The one unresolved region (`region-0871`) is a small curved/ring edge around `x=860,y=173,w=41,h=76`. Its artifacts show expected nearly black pixels and an actual visible gray arc, so it appears to be a real visual difference that recovery did not resolve.

The `needs_escalation` diff (`984e090cb0e3`) concerns the text crop for `left`: expected shows the word `left`, actual is essentially a green bar/blank region, and the overlay shows missing/misaligned expected text. This is also a real mismatch, but the reviewer left it unresolved, so the release gate correctly failed.

## External Run Review

Antigravity MCP with `gemini-3.1-pro-preview` independently reviewed the strict run after implementation.

- Review result: `AGREEMENT_STATUS: agree`; the run is not production-ready.
- The reviewer confirmed the exact blockers: unresolved recovery `region-0871` and active escalation diff `984e090cb0e3`.
- The reviewer found that diff `984e090cb0e3` is visually a missing-text/presence issue rather than a reliable spacing-baseline finding.
- The reviewer confirmed the report/trace defect that reviewer reasons were parsed but not persisted onto final diff records. This is fixed for future reports by adding `reviewerReason` to VLM and target-recovery diff records.
- MCP response noise: none.

## Production Decision

Not production-ready yet. The provider capacity blocker is materially improved: the full run no longer times out, and Mistral completed all audit pairs. The remaining blockers are now pipeline/report semantics around unresolved recovery rejection and `needs_escalation` final diff handling, not total provider unavailability.
