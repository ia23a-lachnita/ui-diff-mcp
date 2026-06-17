# Provider Fallback And Projection Gate Hardening Plan

> **For agentic workers:** This is a corrective implementation plan for the next Calorix live gate. Keep changes task-sized, update `docs/implementation-status.md` with each implementation commit, and run the verification commands named below before marking any task complete.

**Goal:** Make default live runs use the intended projection locator path and survive normal free-tier NVIDIA instability by falling back within `free` mode, without hiding provider changes or weakening explicit NVIDIA-only mode.

**Triggering evidence:** The June 17 Calorix full run completed locator coverage with `locatorActualMode: "independent"` even though projection is the intended default. It then produced widespread visual-classification gaps because high-volume NVIDIA free audit calls returned malformed/truncated JSON and later HTTP 429s, including recovery calls. The debug traces correctly exposed the issue; the next fix belongs in model routing, runtime fallback, recovery selection, and live-gate defaults.

**Non-goals:**

- Do not delete the dual-locator implementation.
- Do not silently use paid providers.
- Do not silently fall back from explicit `free_nvidia` mode to OpenRouter.
- Do not weaken debug traces, crop artifacts, or coverage checks.
- Do not treat OpenRouter free models as equally strong as NVIDIA free models; they are fallback routes for availability, not preferred quality routes.

## Required Semantics

| Area | Required behavior |
| --- | --- |
| Default locator mode | Projection. Locate expected elements once, project to actual, and record `locatorActualMode: "projected"`. |
| Dual locator | Diagnostic-only legacy path. It must require an explicit guard in addition to the old flag, so an agent cannot casually enable it. |
| `free` model mode | NVIDIA free routes first. If a selected runtime route becomes unhealthy during the run, fall back to passing OpenRouter `:free` routes and record the switch. |
| `free_nvidia` model mode | NVIDIA-only. Retry/rotate only among eligible NVIDIA free routes. If exhausted, return incomplete/model-unavailable with traces. |
| `free_openrouter` model mode | OpenRouter `:free` only. No NVIDIA route use. |
| `paid` model mode | Paid route use still requires `UI_DIFF_ENABLE_PAID_MODE=1`. |
| Mixed roles | Allowed in `free` mode for now. The report must make role/provider/model usage explicit so users can see when auditor, reviewer, and recovery used different routes. |
| Recovery | Select `target_recovery` independently from `auditor`; do not reuse the audit caller by default. |

## Task 1: Lock Calorix Gates To Projection

**Files likely touched:**

- `tests/live/calorix-smoke.live.test.ts`
- `docs/release/production-readiness-checklist.md`
- `README.md` if locator env documentation needs clarification

- [ ] Remove `UI_DIFF_DUAL_LOCATOR=1` from bounded and full Calorix live tests.
- [ ] Update assertions/comments so the Calorix release gate expects `locatorActualMode === "projected"`.
- [ ] Keep actual coverage assertions meaningful for projection mode: projected actual elements should still produce deterministic 1:1 pairs and complete locator coverage unless there is a real projection failure.
- [ ] Add or adjust a targeted non-live test that proves the old dual path still works when explicitly guarded.

**Verification:**

```powershell
npm run typecheck
npx vitest run tests/live/calorix-smoke.live.test.ts --run
```

The live test requires the normal live environment variables from `AGENTS.md`.

## Task 2: Make Dual Locator Harder To Use

**Files likely touched:**

- `src/pipeline/run-ui-diff.ts`
- `src/schemas/core.ts` if warnings/metadata need a schema addition
- `tests/unit` or `tests/e2e` pipeline tests
- `docs/superpowers/plans/2026-06-16-single-pass-locator.md`
- `README.md`

- [ ] Replace the current one-flag behavior with a guarded opt-in:
  - `UI_DIFF_DUAL_LOCATOR=1` alone must not enable dual mode.
  - Require `UI_DIFF_ALLOW_DUAL_LOCATOR=1` plus `UI_DIFF_DUAL_LOCATOR_REASON`.
  - If `UI_DIFF_DUAL_LOCATOR=1` is set without the guard, fail fast or force projection with a prominent warning. Prefer fail-fast in tests and CLI/live gates so accidental agent usage is visible.
- [ ] Record `locatorActualMode`, `dualLocatorRequested`, and the reason/guard outcome in report metadata or warnings.
- [ ] Document that dual locator is only for diagnostics, not the default or release gate path.
- [ ] Add a unit/e2e test covering all three cases:
  - no env vars -> projected,
  - old flag only -> rejected or warning plus projected,
  - old flag plus guard plus reason -> independent.

**Verification:**

```powershell
npx vitest run tests/unit tests/e2e
npm run typecheck
```

## Task 3: Add Ordered Runtime Fallback For Free Routes

**Files likely touched:**

- `src/models/model-registry.ts`
- `src/models/vision-json.ts`
- `src/models/openrouter-client.ts`
- `src/models/nvidia-client.ts`
- `src/models/probes.ts`
- `src/pipeline/run-ui-diff.ts`
- model-routing tests

- [ ] Add a route-selection API that returns an ordered list of eligible, probe-passing routes for each role instead of only one selected model.
- [ ] Keep the existing quality preference: in `free`, native NVIDIA routes are ordered before OpenRouter `:free` routes.
- [ ] Add a `FallbackVisionJsonCaller` or equivalent wrapper that attempts the current route and can advance to the next eligible route when the current route hits a route-health failure.
- [ ] Route-health failures must include at least:
  - HTTP 429 or quota exhaustion,
  - provider timeout,
  - transport failure,
  - malformed/truncated JSON,
  - strict schema parse failure caused by invalid provider output.
- [ ] Do not treat a valid "no diff" or `classified: false` answer as unhealthy.
- [ ] Set conservative thresholds:
  - HTTP 429: mark the route unhealthy immediately for that role/run.
  - malformed/truncated JSON: mark unhealthy after a small repeated-failure threshold or high failure ratio, so one bad response does not throw away a strong route too early.
  - timeout/transport: one retry within budget, then mark unhealthy for that role/run.
- [ ] Preserve explicit modes:
  - `free_nvidia`: route list contains only NVIDIA routes; exhaustion returns incomplete/model-unavailable.
  - `free_openrouter`: route list contains only OpenRouter free routes.
  - `paid`: route list contains only paid-eligible routes and only when enabled.

**Verification:**

```powershell
npx vitest run tests/unit/model-registry.test.ts tests/unit/model-clients.test.ts tests/unit/model-probes.test.ts
npm run typecheck
```

## Task 4: Select Recovery Independently

**Files likely touched:**

- `src/pipeline/run-ui-diff.ts`
- `src/recovery/target-recovery.ts`
- `src/models/model-registry.ts`
- `tests/unit/target-recovery.test.ts`
- `tests/e2e`

- [ ] Build a separate ordered route list for `target_recovery`.
- [ ] Pass a recovery-specific fallback caller into target recovery instead of `recoveryCaller: auditorCaller`.
- [ ] Record `modelSelection.targetRecovery` or a newer route-usage object in the report.
- [ ] Make recovery fallback events visible in recovery trace/debug summary.
- [ ] Ensure audit cannot consume the only recorded recovery route state. Runtime health should be role/run scoped, not a single global boolean that blocks unrelated roles unless the provider-wide failure is truly global.

**Verification:**

```powershell
npx vitest run tests/unit/target-recovery.test.ts tests/e2e
npm run typecheck
```

## Task 5: Report Provider Route Usage And Health

**Files likely touched:**

- `src/schemas/core.ts`
- `src/report/report-writer.ts`
- `src/traces` or existing debug trace modules
- `tests/unit/schemas.test.ts`
- `tests/unit/report*.test.ts`

- [ ] Extend report/debug metadata to record:
  - selected primary route per role,
  - every attempted route per role,
  - fallback events with reason, provider, model, call count, and timestamp,
  - final route used for accepted audit/reviewer/recovery records.
- [ ] Keep existing `modelSelection` backward-compatible if practical, but add a richer `modelRouteUsage`/`providerRuntime` field if the old shape is too small.
- [ ] Put provider/model on diff records when a VLM accepted or reviewed a diff.
- [ ] Include warning text when a role falls back from NVIDIA to OpenRouter in `free` mode.

**Verification:**

```powershell
npx vitest run tests/unit/schemas.test.ts tests/unit/report*.test.ts
npm run typecheck
```

## Task 6: Update Live Gates And Release Checklist

**Files likely touched:**

- `package.json`
- `tests/live/*.live.test.ts`
- `docs/release/production-readiness-checklist.md`
- `docs/implementation-status.md`

- [ ] Ensure live gates cover:
  - NVIDIA free probes,
  - OpenRouter free probes,
  - default MCP `free` mode with allowed fallback,
  - OpenRouter-only `free_openrouter`,
  - Calorix bounded projection gate,
  - Calorix full projection gate.
- [ ] Add test assertions that:
  - default Calorix uses projection,
  - `free_nvidia` never reports OpenRouter fallback,
  - `free` reports fallback explicitly if it occurs,
  - visual classification is not marked complete when all eligible routes fail.
- [ ] Keep a separate diagnostic command for guarded dual locator if needed, outside the release gate.

**Verification:**

```powershell
npm run verify
npm run verify:nvidia-live
npm run verify:openrouter-free-live
npm run verify:mcp-live
npm run verify:calorix-live
npm run verify:calorix-full-live
git diff --check
```

## Acceptance Criteria

- Default Calorix bounded and full gates run with `locatorActualMode: "projected"`.
- `UI_DIFF_DUAL_LOCATOR=1` alone cannot switch a release gate into independent actual localization.
- In `free` mode, a NVIDIA 429 or repeated malformed JSON can fall back to OpenRouter `:free` during the same run.
- In `free_nvidia` mode, the same NVIDIA failure never falls back to OpenRouter.
- Target recovery uses a `target_recovery` route, not the auditor route by accident.
- Reports and debug traces make provider switches obvious.
- Full verification and both Calorix live gates pass before release sign-off.

## Gemini Review

Gemini 3.1 Pro Preview review attempt on 2026-06-17:

- Command: `gemini -m gemini-3.1-pro-preview --approval-mode plan --skip-trust --output-format text -p "..."`
- Result: blocked by provider capacity. The CLI retried and returned HTTP 429 / `MODEL_CAPACITY_EXHAUSTED` with message `No capacity available for model gemini-3.1-pro-preview on the server`.

Fallback review attempts on 2026-06-17, strongest-first:

- `gemini-3-pro-preview`: failed with `Invalid stream: The model returned an empty response or malformed tool call`.
- `gemini-2.5-pro`: failed with `Invalid stream: The model returned an empty response or malformed tool call`.
- `gemini-2.5-flash`: completed review.

Gemini 2.5 Flash review result:

- `AGREEMENT_STATUS: agree`
- `MUST_FIX: none`
- `SHOULD_FIX: none`
- `RATIONALE: The plan comprehensively addresses all specified requirements. It clearly outlines how projection will remain the default, how the dual locator will be restricted, the fallback logic for free mode (NVIDIA-first to OpenRouter), the strict NVIDIA-only behavior for free_nvidia, independent selection for target_recovery, and explicit reporting of mixed provider usage. The tasks are well-defined with clear verification steps.`
