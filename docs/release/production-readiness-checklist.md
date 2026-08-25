# Production Readiness Checklist

Run this checklist before calling `ui-diff-mcp` production-ready.

## Canonical Calorix Expected Reference

The Calorix owner restored the active reference at Calorix commit `8cc20bb` (`restore canonical design references`). Every Calorix visual gate uses `docs/design-handoff/placeholder-app/reference-images/today--dark.png`, as configured by `ui-diff.config.json`, and validates it against `docs/design-handoff/placeholder-app/reference-images-manifest.json` before capture or pipeline work. The approved SHA-256 is `73BA85F25489C8D45BEAB57DD1B317138870CE8360FE0F4399AB0737A5E505F1`; the restored manifest records its source content commit `307dfc04ee23bee022f85059cc09dc363b2e80f6`.

`reference-images-buggy` and `good-screenshots` are not fallback expected evidence. `UI_DIFF_LIVE_EXPECTED_IMAGE` is an explicit readable override; setting it to the canonical path still performs manifest and hash validation. For fresh release evidence, `UI_DIFF_LIVE_ACTUAL_IMAGE` must be unset so the actual source is recorded as `auto_capture`; a supplied actual path is recorded as `env_override` with a freshness warning. The MCP capture and Calorix live helper now accept `adbExecutable`/`adbSerial` options (or `UI_DIFF_ADB_EXECUTABLE`/`UI_DIFF_ADB_SERIAL` env fallbacks) and route every ADB invocation through the resolved executable with optional `-s` serial prefix. Fresh physical-phone auto-capture evidence is still pending: the plumbing is implemented but fresh physical-phone release evidence from the authorized Samsung has not yet been captured through the new route.

## Physical Samsung Preflight

The only default local Android target is the dedicated Samsung `SM-G780G`, Android `13`, serial `R58R61161NA`. Never use plain `adb` or implicit device selection. Cuttlefish, `android-vm`, ReDroid, desktop AVDs, and local emulators are retired and are not release-evidence routes.

```bash
/home/agent-runner/.local/bin/phone-adb devices -l
/home/agent-runner/.local/bin/phone-adb shell getprop ro.product.model
/home/agent-runner/.local/bin/phone-adb shell getprop ro.build.version.release
/home/agent-runner/.local/bin/phone-adb get-serialno
```

Required result: exactly the authorized device is online, with model `SM-G780G`, Android `13`, and serial `R58R61161NA`.

The persisted `report.json` must contain report-safe `inputProvenance` for Calorix: the pipeline computes expected and actual SHA-256 identities from the image bytes, and a manifest entry appears only after it matches the computed expected identity. `auto_capture` and `env_override` remain `caller_attested` acquisition sources, never independently verified claims. Public MCP input accepts no computed hashes; it can supply only this attestation and an expected-manifest path for pipeline verification. On resume, omission inherits the prior effective provenance; a replacement requires matching recomputed expected and actual identities. Do not place environment values, provider keys, or other credentials in this object.

## Deterministic Gates

```bash
npm run verify
npm run test:coverage
npm audit --audit-level=critical
```

Required result:

- Typecheck passes.
- Unit and integration tests pass.
- Coverage thresholds pass.
- `npm audit` reports no critical vulnerability.

## OpenCode Zen Free Visual Gate

```bash
export RUN_OPENCODE_LIVE="1"
# OPENCODE_API_KEY is optional; the current free route defaults to public.
npm run verify:opencode-live
```

Required result:

- The live catalog contains `mimo-v2.5-free`.
- A real PNG produces locally validated structured JSON.
- One five-image provider call produces passing auditor, reviewer, and target-recovery probe records.
- The provider-returned concrete model, duration, finish reason, and token usage are logged without prompts, image data, or credentials.
- `deepseek-v4-flash-free` is not selected for visual roles while its current metadata remains text-only.

## OpenRouter-Only Free Live Gate

```bash
export RUN_OPENROUTER_FREE_LIVE="1"
export OPENROUTER_API_KEY="<real-openrouter-key>"
export LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
npm run verify:openrouter-free-live
```

Required result:

- OpenRouter quota is available and recorded.
- At least one `:free` auditor and reviewer pass probes.
- `modelSelection.auditor.provider` and `modelSelection.reviewer.provider` are both `openrouter`.
- Probe results (model, provider, status) are logged.

## NVIDIA Endpoint Live Gate

```bash
export RUN_NVIDIA_LIVE="1"
export NVIDIA_API_KEY="<real-nvidia-key>"
# export NVIDIA_VLM_BASE_URL="https://integrate.api.nvidia.com/v1"  # default
npm run verify:nvidia-live
```

Required result:

- At least one native NVIDIA free VLM passes auditor probe.
- At least one native NVIDIA free VLM passes reviewer probe.
- `modelSelection.provider` is `nvidia` in the probe summary.

## Default Free MCP Live Gate

```bash
export RUN_UI_DIFF_LIVE="1"
export LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
export LOCATEANYTHING_IN_TOKEN_LIMIT="4096"
export LOCATEANYTHING_GENERATION_MODE="hybrid"
export LOCATEANYTHING_MAX_NEW_TOKENS="512"
export LOCATEANYTHING_TIMEOUT_MS="300000"
npm run verify:mcp-live
```

Required result:

- Auditor and reviewer are selected from `opencode`, `nvidia`, or `openrouter` with `costClass: "free"`.
- LocateAnything sidecar returns valid in-bounds boxes.
- `discover_ui_diffs` completes through the MCP stdio server.
- The report has `status !== "failed"`.
- Exact selected provider, model, and costClass are recorded in `modelSelection`.
- Required model health entries for selected routes are `pass`.
- The report includes normalized images, `actual_comparison_space`, pixel diff, overlay, report JSON, and artifact index.
- Provider stages contain explicit semantic outcomes; a lifecycle `complete` value alone is not release evidence.

## Shape-Local Coverage

Deterministic displacement findings retain separate expected and translated child locations for region-ledger coverage. The rectangular corridor between those shapes is not marked covered, so unrelated changed pixels inside a final group's display union remain eligible for recovery.

## LocateAnything Direct Live Preflight

Run this preflight before full or strict Calorix release evidence. It must use a freshly restarted sidecar with the model enabled; a sidecar started with `LOCATEANYTHING_SKIP_MODEL=1` is not valid release evidence.

```bash
# Run from the ui-diff-mcp root. A sidecar already started with the skip flag
# must be stopped through its recorded owner/PID before this block; never kill
# an unidentified listener on port 39731.
unset LOCATEANYTHING_SKIP_MODEL
bash scripts/start-locateanything-sidecar.sh

export LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
export RUN_LOCATEANYTHING_LIVE="1"
npm run verify:locateanything-live
```

Required result:

- The direct locator gate runs rather than skipping and uses the restarted sidecar.
- `metadata.lanes.locateanything.status === "complete"`.
- `metadata.lanes.locateanything.count > 0`.

The strict Calorix release gate below repeats the same lane contract from its persisted report; a skipped or zero-count LocateAnything lane blocks release even when the rest of the report is complete.

## Deterministic Calorix Pipeline Gate

Run this before provider-backed Calorix gates so displacement, consolidation, coverage, and recovery scheduling are evaluated independently of model availability:

```bash
export RUN_CALORIX_DETERMINISTIC_LIVE="1"
export UI_DIFF_LIVE_EXPECTED_IMAGE="/home/agent-runner/projects/calorix/docs/design-handoff/placeholder-app/reference-images/today--dark.png"
export LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
export UI_DIFF_ADB_EXECUTABLE="/home/agent-runner/.local/bin/phone-adb"
unset UI_DIFF_ADB_SERIAL
unset UI_DIFF_LIVE_ACTUAL_IMAGE
npm run verify:calorix-deterministic-live
```

The gate is designed to build/install Calorix only when the APK is stale, open `calorix://debug/reseed`, and auto-capture into `/home/agent-runner/projects/calorix/.ui-diff/captures`. Set `UI_DIFF_ADB_EXECUTABLE` to the authorized wrapper (which already pins the serial) and leave `UI_DIFF_ADB_SERIAL` unset for serial-safe auto-capture. For generic executables, set `UI_DIFF_ADB_SERIAL` to the target device serial. Fresh physical-phone auto-capture evidence from the authorized Samsung has not yet been captured through the new route. Set `UI_DIFF_LIVE_ACTUAL_IMAGE` only for an explicit diagnostic or historical-file override.

Required evidence:

- Large uniquely supported translations are reported as coherent geometry groups. Multiple independently proven non-coherent mismatches in one connected bounded region are reported as one structural layout finding rather than duplicate presence fragments.
- Deterministic findings use `reviewerStatus:not_reviewed`.
- Group and child artifacts are present.
- Same-vector findings under one ancestor are consolidated.
- Recovery emits no `skipped_component_cap`; the compatibility component value is batch size only.

Latest provider-independent result: `run-1782187460179-53f4c9` on 2026-06-23. It checked 79 projected pairs, grouped 8 deterministic mismatches into 2 structural findings, and made no auditor/reviewer calls. See `docs/release/2026-06-22-deterministic-pipeline-live-results.md`.

## Bounded Calorix Smoke Gate

```bash
export RUN_CALORIX_UI_DIFF_LIVE="1"
export LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
export LOCATEANYTHING_IN_TOKEN_LIMIT="4096"
export LOCATEANYTHING_GENERATION_MODE="hybrid"
export LOCATEANYTHING_MAX_NEW_TOKENS="512"
export LOCATEANYTHING_TIMEOUT_MS="300000"
export UI_DIFF_MAX_AUDIT_PAIRS="3"
export UI_DIFF_LIVE_EXPECTED_IMAGE="/home/agent-runner/projects/calorix/docs/design-handoff/placeholder-app/reference-images/today--dark.png"
export UI_DIFF_ADB_EXECUTABLE="/home/agent-runner/.local/bin/phone-adb"
unset UI_DIFF_ADB_SERIAL
unset UI_DIFF_LIVE_ACTUAL_IMAGE
npm run verify:calorix-live
```

Required result:

- Calorix image pair runs through `discover_ui_diffs`.
- Report path is recorded in the release note.
- Result is not `failed`.
- If visual classification is incomplete, the release note records the exact reason, including whether `UI_DIFF_MAX_AUDIT_PAIRS` bounded the smoke run.
- `auditLimited` is `true` and `visualClassificationStatus` is `incomplete` when pairs are limited.
- `report.diffs` contains final findings only; raw/unclassified pixel regions appear only in `unresolvedRegions`.
- `locatorActualMode` is `"projected"` — dual-locator must not be active in the release gate.
- `modelSelection.auditorRoutes` and `modelSelection.reviewerRoutes` are present with at least one entry each.
- If any provider fallback occurred during the run, `report.warnings` must contain explicit fallback text (never silent).

## Before Running Full Or Release Calorix Gates

Before running `verify:calorix-full-live` or `verify:calorix-release-live`, confirm all of the following from the most recent bounded smoke report:

- `locatorCoverageStatus` is `"complete"` — not `"weak"` or `"failed"`
- `auditScope.providerCalledPairs > 0` — at least one pair reached the VLM auditor (if zero, the projection pre-audit or criterion selection consumed all bounded slots, which means the bounded smoke did not exercise its intended path)
- `projectedPreAudit` exists in the report — confirms the pre-audit stage ran
- Every accepted diff has `classificationSource` — no untagged diffs
- `recoverySummary.statusCounts` exists when recovery ran

If any of these fail in the bounded smoke, fix the underlying code issue before proceeding to the full or release gate.

## Full Calorix All-Target Audit Gate

```bash
export RUN_CALORIX_FULL_LIVE="1"
export LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
export LOCATEANYTHING_IN_TOKEN_LIMIT="4096"
export LOCATEANYTHING_GENERATION_MODE="hybrid"
export LOCATEANYTHING_MAX_NEW_TOKENS="512"
export LOCATEANYTHING_TIMEOUT_MS="300000"
# Do NOT set UI_DIFF_MAX_AUDIT_PAIRS — unbounded audit required
unset UI_DIFF_MAX_AUDIT_PAIRS
export UI_DIFF_LIVE_EXPECTED_IMAGE="/home/agent-runner/projects/calorix/docs/design-handoff/placeholder-app/reference-images/today--dark.png"
export UI_DIFF_ADB_EXECUTABLE="/home/agent-runner/.local/bin/phone-adb"
unset UI_DIFF_ADB_SERIAL
unset UI_DIFF_LIVE_ACTUAL_IMAGE
npm run verify:calorix-full-live
```

Required result:

- Unbounded all-target Calorix audit completes.
- `auditLimited` is `false`.
- `visualClassificationStatus` is recorded. `incomplete` is a diagnostic result and blocks production even when traces explain it.
- `auditScope.selectedPairs + auditScope.preAuditDeterministicPairs === auditScope.totalPairs`.
- `auditScope.enteredPairs + auditScope.remainingPairs === auditScope.selectedPairs`.
- `auditScope.providerCalledPairs + auditScope.skippedNoTriggeredPairs === auditScope.enteredPairs`.
- `modelSelection` is present in `report.json` with auditor and reviewer model/provider.
- All diffs have at least one evidence string.
- No final finding uses `unclassified_visual_change`; unresolved canonical regions remain in `unresolvedRegions`.
- Every deterministic projected finding has projected expected/actual crops, directional overlay, and pixel-diff mask.
- Consolidated child finding IDs are unique, and no final findings duplicate target + criterion + strongly overlapping location.
- `locatorActualMode` is `"projected"` — dual-locator must not be active in the release gate.
- `modelSelection.auditorRoutes` and `modelSelection.reviewerRoutes` are present with at least one entry each.
- If recovery ran (`recoverySummary.attemptedComponents > 0`), `modelSelection.targetRecoveryRoutes` is present.
- Any OpenCode→NVIDIA/OpenRouter or NVIDIA→OpenRouter fallback in `free` mode is recorded explicitly in `report.warnings`.

## Strict Calorix Release Gate

```bash
export RUN_CALORIX_RELEASE_LIVE="1"
export LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
export UI_DIFF_LIVE_EXPECTED_IMAGE="/home/agent-runner/projects/calorix/docs/design-handoff/placeholder-app/reference-images/today--dark.png"
export UI_DIFF_ADB_EXECUTABLE="/home/agent-runner/.local/bin/phone-adb"
unset UI_DIFF_MAX_AUDIT_PAIRS
unset UI_DIFF_ADB_SERIAL
unset UI_DIFF_LIVE_ACTUAL_IMAGE
npm run verify:calorix-release-live
```

Required result:

- `status === "complete"`, `isCheckpoint === false`, and the MCP child remains healthy through final report persistence.
- `visualClassificationStatus === "complete"` and `auditLimited === false`.
- `report.locatorMetadata.lanes.locateanything.status === "complete"` and `report.locatorMetadata.lanes.locateanything.count > 0`; the direct locator preflight must have passed after a sidecar restart without `LOCATEANYTHING_SKIP_MODEL`.
- `unresolvedRegions.length === 0`, `auditScope.remainingPairs === 0`, and `auditScope.stoppedReason === "none"`.
- `auditScope.providerCalledPairs + auditScope.skippedNoTriggeredPairs === auditScope.selectedPairs` and `auditScope.failedPairs === 0`.
- No final finding has `reviewerStatus:"needs_escalation"`, lacks `classificationSource` when reviewer-accepted, or uses `unclassified_visual_change`.
- Recovery leaves zero unclassified regions, and all required debug/provider traces and artifacts are durable.
- `model_probe.outcome === "success"`, `audit.outcome === "success"`, and `target_recovery.outcome` is `success` or `not_applicable`.
- `actual-comparison-space.png` is typed as `actual_comparison_space` and indexed in `artifacts/index.json`.

A bounded or full diagnostic pass never substitutes for this gate.

This strict gate is currently blocked before execution because fresh physical-phone auto-capture evidence from the authorized Samsung has not yet been captured through the new serial-safe routing. Do not weaken the unset-actual requirement to work around that defect; run fresh bounded/full/release gates with `UI_DIFF_ADB_EXECUTABLE` set to the authorized wrapper and `UI_DIFF_ADB_SERIAL` left unset (the wrapper already pins the serial).

## Dual-Locator Diagnostic Command

Dual-locator mode is **not** part of any release gate and must not be enabled without an explicit guard:

```bash
# Only for diagnostics — must NOT be used in release gate runs
export UI_DIFF_DUAL_LOCATOR="1"
export UI_DIFF_ALLOW_DUAL_LOCATOR="1"
export UI_DIFF_DUAL_LOCATOR_REASON="investigating lane coverage discrepancy on <date>"
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
- Strict Calorix release output summary, including final finding count, unresolved count, consolidation count, audit counters, run ID, and duration.
- Any remaining P2 risks.
