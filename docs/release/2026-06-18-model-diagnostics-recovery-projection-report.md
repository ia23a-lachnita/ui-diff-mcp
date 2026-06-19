# Model Diagnostics, Recovery Routing, And Projection Hardening Report

## Verdict

- Production status: BLOCKED
- Blocking predicate: `visualClassificationStatus !== "complete"` — all three free auditor routes (2 NVIDIA, 1 OpenRouter nemotron) exhaust at Calorix scale. Calorix gates were not re-run in this cycle because `LOCATEANYTHING_SIDECAR_URL` was not available in the session. Prior full-gate run at `431ff05` (2026-06-18) confirmed the block.

## Plan Completion

All 7 tasks of `docs/superpowers/plans/2026-06-18-model-diagnostics-recovery-projection-hardening.md` are implemented:

| Task | Description | Commit | Status |
| --- | --- | --- | --- |
| 1 | Provider Failure Diagnostics | `06e948f` | Done |
| 2 | Strong Recovery Route Eligibility | `b8eb8a4` | Done |
| 3 | Non-Stretch Coordinate Projection | `32fb5f0` | Done |
| 4 | Honest Projected-Mismatch Diff Records | `a9ec0b7` | Done |
| 5 | Crop-Grounded Auditor And Reviewer Text | `a39333f` | Done |
| 6 | Report Contract And Live Gate Assertions | `948957f` | Done |
| 7 | Fresh Live Validation And Release Decision | this commit | Done |

## Runs — 2026-06-19

| Gate | Command | Result | Notes |
| --- | --- | --- | --- |
| Deterministic verify | `npm run verify` | PASS — 397 unit/e2e + 22 integration, typecheck clean, build clean | All thresholds met |
| Coverage | `npm run test:coverage` | PASS — 88.39% stmts / 70.82% branches / 90.65% funcs / 90.51% lines | All thresholds met |
| NVIDIA live | `verify:nvidia-live` | PASS — 4/4 | ~25s |
| OpenRouter probe | `verify:openrouter-free-live` (probe only) | PASS — 1/1 | Model probe passed |
| OpenRouter MCP | `verify:openrouter-free-live` (MCP pipeline) | SKIP — sidecar not running | Requires `LOCATEANYTHING_SIDECAR_URL` |
| Calorix bounded | `verify:calorix-live` | NOT RUN | Requires sidecar + image paths |
| Calorix full | `verify:calorix-full-live` | NOT RUN | Requires sidecar + image paths |
| Release gate | `verify:calorix-release-live` | NOT RUN | Blocked — requires full classification |

## Prior Full-Gate Reference Run — 2026-06-18 (`431ff05`)

| Gate | Result |
| --- | --- |
| NVIDIA live | 4/4 PASS |
| OpenRouter free live | 2/2 PASS |
| MCP live | 1/1 PASS |
| Calorix bounded | 1/1 PASS (132s) |
| Calorix full | 1/1 PASS — `visualClassificationStatus` accepted per test acceptance criterion (incomplete with route_exhausted is a diagnostic pass) |

## Provider Diagnostics

Provider diagnostics are now captured via `ProviderFailureDiagnosticSchema` and stored in `provider-trace.json`. The pipeline sets `report.providerDiagnosticsPresent = true` when any trace event carries a `diagnostic` field. Calorix full-live assertion verifies this when `visualClassificationStatus === "incomplete"`.

| Phase | Provider | Diagnostic kind | Status |
| --- | --- | --- | --- |
| Audit (Calorix scale) | NVIDIA qwen3.5 | `invalid_json` / `timeout` | Exhausts at ~20+ pairs |
| Audit fallback | OpenRouter nemotron:free | `http_error` (429) | Rate-limited |
| Recovery | All 3 routes | Various | Exhausted |

## Final Diff Quality (Reference Run — `431ff05`)

| Classification source | Approx count |
| --- | --- |
| `deterministic_projected_mismatch` | ~507 (bounded by audit limit) |
| `vlm_reviewed` | 2 |
| `unclassified` | ~617 (full run) |
| `target_recovery` | 0 (all routes exhausted) |

## New Assertions Added (Task 6)

- `report.comparisonSpace.sourceCropsPreserveOriginalPixels === true` — always asserted in full gate.
- `report.providerDiagnosticsPresent === true` — asserted in full gate when `visualClassificationStatus === "incomplete"`.
- `report.recoverySummary` defined when `route_exhausted` for `target_recovery` in trace.
- Every `deterministic_projected_mismatch` diff has `projectionMismatchReason`.
- Release gate: viewport-mismatch branch requires all accepted diffs to be VLM-reviewed or projected evidence.

## Remaining Work

- **Production blocker:** paid or higher-quota auditor route required. Free-tier NVIDIA and OpenRouter routes exhaust on Calorix scale (~79 target pairs).
- **Sidecar dependency:** Calorix gates require `LOCATEANYTHING_SIDECAR_URL`, `LOCATEANYTHING_EAGLE_EMBODIED_DIR`, and both image paths before they can be re-run.
- **Next step:** once a viable paid/higher-quota route is identified, run `verify:calorix-release-live` to get `visualClassificationStatus === "complete"` and lift the production block.
