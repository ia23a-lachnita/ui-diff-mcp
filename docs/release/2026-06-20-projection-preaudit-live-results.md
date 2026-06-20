# Projection Pre-Audit Hardening — Live Gate Results (2026-06-20)

**Plan:** `docs/superpowers/plans/2026-06-20-projection-preaudit-full-gate-hardening.md`
**Tasks completed:** 1–6 (code), 7 (partial — provider gates run, Calorix blocked by sidecar)

## Gate Results

| Gate | Command | Result | Duration | Notes |
|------|---------|--------|----------|-------|
| Deterministic verify | `npm run verify` | PASS | ~45s | 410 unit/e2e + 22 integration tests, typecheck clean, build clean |
| Coverage | `npm run test:coverage` | PASS | ~20s | 88.91% stmts / 71.34% branches / 90.87% funcs — all thresholds met |
| NVIDIA free live | `verify:nvidia-live` | **4/4 PASS** | ~15s | All 4 NVIDIA probe targets healthy |
| OpenRouter free live | `verify:openrouter-free-live` | SKIP | — | `LOCATEANYTHING_SIDECAR_URL` not set — sidecar not running |
| Default MCP live | `verify:mcp-live` | SKIP | — | `LOCATEANYTHING_SIDECAR_URL` not set — sidecar not running |
| Calorix bounded smoke | `verify:calorix-live` | SKIP | — | Sidecar not running |
| Calorix full audit | `verify:calorix-full-live` | SKIP | — | Sidecar not running |
| Calorix release gate | `verify:calorix-release-live` | SKIP | — | Sidecar not running |

## Production Readiness Decision

**BLOCKED.** Calorix gates require the LocateAnything sidecar running at `LOCATEANYTHING_SIDECAR_URL`. The NVIDIA provider gates pass. MCP, OpenRouter, and Calorix gates require the sidecar to be started first.

### To complete Task 7

Start the sidecar:

```powershell
# From the ui-diff-mcp project root:
$env:LOCATEANYTHING_SKIP_MODEL = "1"  # skip model load for bounded run
.\scripts\start-locateanything-sidecar.ps1
```

Then run:

```powershell
$env:LOCATEANYTHING_SIDECAR_URL = "http://127.0.0.1:39731"
$env:RUN_OPENROUTER_FREE_LIVE = "1"
npm run verify:openrouter-free-live

$env:RUN_UI_DIFF_LIVE = "1"
npm run verify:mcp-live

$env:RUN_CALORIX_UI_DIFF_LIVE = "1"
$env:UI_DIFF_MAX_AUDIT_PAIRS = "3"
$env:UI_DIFF_LIVE_EXPECTED_IMAGE = "C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE = "C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-17-adb-seeded-2.png"
npm run verify:calorix-live
```

Expected bounded smoke assertions that were failing before this plan:
- `projectedPreAudit` defined ✓ (added in Task 4)
- `vlmAuditedPairs > 0` ✓ (pre-audit now only skips definite mismatches, not all projected pairs)
- `auditLimited: true` (expected with `UI_DIFF_MAX_AUDIT_PAIRS=3`)
