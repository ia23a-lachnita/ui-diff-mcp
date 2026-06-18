# Production Readiness Checklist

Run this checklist before calling `ui-diff-mcp` production-ready.

## Deterministic Gates

```powershell
npm run verify
npm run test:coverage
npm audit
```

Required result:

- Typecheck passes.
- Unit and integration tests pass.
- Coverage thresholds pass.
- `npm audit` reports no critical vulnerability.

## OpenRouter-Only Free Live Gate

```powershell
$env:RUN_OPENROUTER_FREE_LIVE="1"
$env:OPENROUTER_API_KEY="<real-openrouter-key>"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
npm run verify:openrouter-free-live
```

Required result:

- OpenRouter quota is available and recorded.
- At least one `:free` auditor and reviewer pass probes.
- `modelSelection.auditor.provider` and `modelSelection.reviewer.provider` are both `openrouter`.
- Probe results (model, provider, status) are logged.

## NVIDIA Endpoint Live Gate

```powershell
$env:RUN_NVIDIA_LIVE="1"
$env:NVIDIA_API_KEY="<real-nvidia-key>"
# $env:NVIDIA_VLM_BASE_URL="https://integrate.api.nvidia.com/v1"  # default
npm run verify:nvidia-live
```

Required result:

- At least one native NVIDIA free VLM passes auditor probe.
- At least one native NVIDIA free VLM passes reviewer probe.
- `modelSelection.provider` is `nvidia` in the probe summary.

## Default Free MCP Live Gate

```powershell
$env:RUN_UI_DIFF_LIVE="1"
$env:OPENROUTER_API_KEY="<real-openrouter-key>"
$env:NVIDIA_API_KEY="<real-nvidia-key>"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
$env:LOCATEANYTHING_IN_TOKEN_LIMIT="4096"
$env:LOCATEANYTHING_GENERATION_MODE="hybrid"
$env:LOCATEANYTHING_MAX_NEW_TOKENS="512"
$env:LOCATEANYTHING_TIMEOUT_MS="300000"
npm run verify:mcp-live
```

Required result:

- Auditor and reviewer are selected from `nvidia` or `openrouter` providers with `costClass: "free"`.
- LocateAnything sidecar returns valid in-bounds boxes.
- `discover_ui_diffs` completes through the MCP stdio server.
- The report has `status !== "failed"`.
- Exact selected provider, model, and costClass are recorded in `modelSelection`.
- Required model health entries for selected routes are `pass`.
- The report includes normalized images, pixel diff, overlay, report JSON, and artifact index.

## Known Coverage Limitation

Deterministic geometry diffs use a union box that covers both the expected and actual element positions. This prevents shifted elements from being reported as unclassified pixel fragments during target recovery. However, unrelated pixel changes that fall inside the union box may be considered covered and not sent to recovery until shape-aware coverage is implemented in a future task.

## Bounded Calorix Smoke Gate

```powershell
$env:RUN_CALORIX_UI_DIFF_LIVE="1"
$env:OPENROUTER_API_KEY="<real-openrouter-key>"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
$env:LOCATEANYTHING_IN_TOKEN_LIMIT="4096"
$env:LOCATEANYTHING_GENERATION_MODE="hybrid"
$env:LOCATEANYTHING_MAX_NEW_TOKENS="512"
$env:LOCATEANYTHING_TIMEOUT_MS="300000"
$env:UI_DIFF_MAX_AUDIT_PAIRS="3"
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-17-adb-seeded-2.png"
npm run verify:calorix-live
```

Required result:

- Calorix image pair runs through `discover_ui_diffs`.
- Report path is recorded in the release note.
- Result is not `failed`.
- If visual classification is incomplete, the release note records the exact reason, including whether `UI_DIFF_MAX_AUDIT_PAIRS` bounded the smoke run.
- `auditLimited` is `true` and `visualClassificationStatus` is `incomplete` when pairs are limited.
- `locatorActualMode` is `"projected"` — dual-locator must not be active in the release gate.
- `modelSelection.auditorRoutes` and `modelSelection.reviewerRoutes` are present with at least one entry each.
- If any provider fallback occurred during the run, `report.warnings` must contain explicit fallback text (never silent).

## Full Calorix All-Target Audit Gate

```powershell
$env:RUN_CALORIX_FULL_LIVE="1"
$env:OPENROUTER_API_KEY="<real-openrouter-key>"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
$env:LOCATEANYTHING_IN_TOKEN_LIMIT="4096"
$env:LOCATEANYTHING_GENERATION_MODE="hybrid"
$env:LOCATEANYTHING_MAX_NEW_TOKENS="512"
$env:LOCATEANYTHING_TIMEOUT_MS="300000"
# Do NOT set UI_DIFF_MAX_AUDIT_PAIRS — unbounded audit required
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-17-adb-seeded-2.png"
npm run verify:calorix-full-live
```

Required result:

- Unbounded all-target Calorix audit completes.
- `auditLimited` is `false`.
- `visualClassificationStatus` is recorded (complete or incomplete with reason).
- `modelSelection` is present in `report.json` with auditor and reviewer model/provider.
- All diffs have at least one evidence string.
- `locatorActualMode` is `"projected"` — dual-locator must not be active in the release gate.
- `modelSelection.auditorRoutes` and `modelSelection.reviewerRoutes` are present with at least one entry each.
- If recovery ran (`recoverySummary.attemptedComponents > 0`), `modelSelection.targetRecoveryRoutes` is present.
- Any NVIDIA→OpenRouter provider fallback in `free` mode is recorded explicitly in `report.warnings`.

## Dual-Locator Diagnostic Command

Dual-locator mode is **not** part of any release gate and must not be enabled without an explicit guard:

```powershell
# Only for diagnostics — must NOT be used in release gate runs
$env:UI_DIFF_DUAL_LOCATOR="1"
$env:UI_DIFF_ALLOW_DUAL_LOCATOR="1"
$env:UI_DIFF_DUAL_LOCATOR_REASON="investigating lane coverage discrepancy on <date>"
```

Without all three variables, `UI_DIFF_DUAL_LOCATOR=1` alone is silently ignored and the run falls back to projection mode with a warning in `report.warnings`.

## Debug Insight Gate

A production sign-off run must include `debugSummary`, `audit-trace.json`,
`coverage-trace.json`, and `recovery-trace.json`. The traces must explain every
auditor/reviewer/recovery loss point using structured statuses. A run that only
reports final diff counts without these traces is not acceptable for Calorix sign-off.

## Provider Trace Gate

Every run writes `artifacts/provider-trace.json` alongside the audit, coverage,
and recovery traces.

Production release sign-off is **blocked** whenever `visualClassificationStatus !== "complete"`.
A `provider-trace.json` that explains route exhaustion makes an incomplete result an acceptable
**diagnostic/degraded gate pass** — it does **not** satisfy the production sign-off requirement.
Incomplete-with-trace means "the tool instrumented its failure correctly," not "the tool finished."

**Triage recipe:**

1. Check `report.json` → `warnings` for provider fallback or quota messages.
2. Open `provider-trace.json` and filter by `role/event`:
   - `event === "probe_result"` → which models passed/failed role probes at startup.
   - `event === "call_start"` / `call_success"` / `call_error"` → per-call latency and errors.
   - `event === "route_unhealthy"` → which route triggered sticky-skip and why.
   - `event === "fallback"` → which route the caller switched to.
   - `event === "route_exhausted"` → all candidates failed; run is incomplete.
3. Cross-reference `audit-trace.json` for `auditor_error` / `auditor_schema_error` entries only after the provider-level route health is understood.

**What `provider-trace.json` contains:**
- Metadata-only events: provider, model, modelFamilyKey, routeIndex, attempt, timing, errorKind, httpStatus, retryable, reason, and safe usage stats (token counts, ttftMs, finishReason).

**What `provider-trace.json` deliberately omits:**
- Prompt text, image data URLs or base64, raw provider response bodies, API keys, and local crop payloads.

**Why OpenRouter activity export may not match:**
- Native NVIDIA API calls are not routed through OpenRouter and will not appear in OpenRouter's activity export. Failed HTTP attempts that never reached the provider may also be absent from provider dashboards. The local `provider-trace.json` is the authoritative source for all call attempts and route-health decisions.

## Sign-Off Record

Append a dated note to `docs/implementation-status.md` with:

- Commit SHA.
- Deterministic gate output summary.
- Free live gate output summary.
- NVIDIA live gate output summary or reason it was not run.
- Bounded Calorix gate output summary or reason it was not run.
- Full Calorix gate output summary or reason it was not run.
- Any remaining P2 risks.
