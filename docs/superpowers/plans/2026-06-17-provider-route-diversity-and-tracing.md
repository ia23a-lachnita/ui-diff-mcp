# Provider Route Diversity And Runtime Trace Plan

> **For agentic workers:** This is a corrective implementation plan for the next Calorix live gate after the provider-fallback work at `bc6bf10`. Keep changes task-sized, update `docs/implementation-status.md` with each implementation commit, and do not mark a task complete until its verification command has passed or the exact failure is recorded.

**Goal:** Keep default `free` mode NVIDIA-first, but make the fallback chain diverse enough to survive Calorix-scale free-tier instability and make every probe, provider call, route-health decision, and fallback transition visible in a scrubbed `provider-trace.json` artifact.

**Triggering evidence:** The fresh June 17 all-gates run used projection correctly, and the new fallback plumbing fired. The gates still failed because the auditor route chain was effectively:

1. native NVIDIA `qwen/qwen3.5-397b-a17b`
2. native NVIDIA `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`
3. OpenRouter `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`

That last hop changed provider but not model family. OpenRouter activity also showed many same-model rows because each gate probes fresh, the same model can be probed for multiple roles, and late Calorix audit calls all used the single OpenRouter Nemotron fallback. Native NVIDIA calls do not appear in OpenRouter's activity export, so local artifacts need a first-class provider-call ledger.

**Non-goals:**

- Do not make OpenRouter preferred over passing strong NVIDIA routes in default `free` mode.
- Do not silently use paid routes.
- Do not fall back from explicit `free_nvidia` mode to OpenRouter.
- Do not remove projection mode or weaken the guarded dual-locator behavior.
- Do not commit provider prompts, image payloads, API keys, raw response bodies, or local run artifacts.
- Do not require provider dashboards for release triage; provider dashboards may be useful, but `report.json` and run artifacts must be sufficient.

## Required Semantics

| Area | Required behavior |
| --- | --- |
| Default `free` route order | Native NVIDIA routes remain first when their role probes pass. OpenRouter `:free` routes are availability fallbacks, not quality-preferred primaries. |
| Route diversity | Fallback selection should prefer a different model family over the same family through a second provider when a different passing family exists. |
| OpenRouter fallback count | `free` mode must be able to append multiple passing OpenRouter `:free` fallbacks for auditor/reviewer, not stop after the first one. |
| Same-family fallback | Allowed only when it is the only passing fallback. It must be visible in route metadata or warnings so reviewers know provider changed but model family did not. |
| Route health | Health is role/run scoped by default. Mark a route unhealthy for retryable failures, keep it sticky-skipped for the rest of that role/run, and emit a provider-trace event. |
| Provider trace | Every probe and runtime VLM call is recorded as metadata-only events in `provider-trace.json`; no prompts, image data, keys, raw responses, or local artifact payloads. |
| OpenRouter CSV correlation | The local trace must explain why OpenRouter may show repeated same-model rows and why failed HTTP attempts may be absent from provider exports. |
| Recovery | Recovery remains independently selected. If no `target_recovery` route passes probes, skip recovery with explicit warning and trace events. |

## Task 1: Add Route Family Identity And Diversity Rules

**Files likely touched:**

- `src/models/model-registry.ts`
- `tests/unit/model-registry.test.ts`
- `docs/superpowers/plans/2026-06-14-free-first-ui-diff-hardening.md` if the route policy table needs clarification

- [x] Add a `modelFamilyKey` helper for route comparison. It should normalize provider suffixes and known router aliases, including:
  - OpenRouter `:free` suffixes,
  - dated OpenRouter permaslug suffixes when present in trace/report metadata,
  - native-vs-router copies of the same family such as Nemotron 3 Nano Omni.
- [x] Extend `selectFallbackModelsForMode` or replace it with a route-list selector that can append more than one OpenRouter fallback in `free` mode.
- [x] Preserve NVIDIA-first ordering for default `free` mode.
- [x] When appending OpenRouter fallbacks, prefer passing routes whose `modelFamilyKey` is not already present in the selected NVIDIA routes.
- [x] Allow a same-family OpenRouter route only after all different-family passing OpenRouter routes have been considered, or when it is the only passing OpenRouter route.
- [x] Keep `free_nvidia`, `free_openrouter`, and `paid` mode boundaries exact.
- [x] Add tests proving:
  - NVIDIA primaries stay first in `free`,
  - multiple passing OpenRouter auditor routes can be returned,
  - same-family OpenRouter Nemotron is not the only OpenRouter hop when Nex/Gemma/Qwen-style alternatives pass,
  - `free_nvidia` contains no OpenRouter route,
  - `free_openrouter` contains no NVIDIA route.

**Verification:**

```powershell
npx vitest run tests/unit/model-registry.test.ts
npm run typecheck
```

## Task 2: Add `provider-trace.json` Schema And Writer

**Files likely touched:**

- `src/schemas/core.ts`
- `src/debug/provider-trace.ts` or `src/debug/run-debug.ts`
- `src/report/report-writer.ts`
- `tests/unit/run-debug.test.ts`
- `tests/unit/schemas.test.ts`

- [x] Define a metadata-only provider trace event schema with fields similar to:
  - `eventId`
  - `phase`: `probe | audit | reviewer | recovery | quota_preflight`
  - `event`: `call_start | call_success | call_error | route_unhealthy | fallback | route_exhausted | probe_result | quota_result`
  - `role`: `auditor | reviewer | target_recovery | locator | quota`
  - `provider`
  - `model`
  - `modelFamilyKey`
  - `routeIndex`
  - `attempt`
  - `startedAt`, `completedAt`, `durationMs`
  - `status`
  - `errorKind`, `httpStatus`, `retryable`, `reason`
  - optional safe usage metadata such as token counts, time to first token, and finish reason when available.
- [x] Explicitly exclude prompt text, image data URLs/base64, raw provider response bodies, API keys, and local crop payloads from the schema.
- [x] Write `artifacts/provider-trace.json` alongside `audit-trace.json`, `coverage-trace.json`, and `recovery-trace.json`.
- [x] Add `provider_trace` to `runArtifacts` roles.
- [x] Keep `report.json` compact: include only the artifact pointer and high-level warnings, not the whole provider trace inline.
- [x] Add tests proving the writer emits valid JSON and rejects/omits unsafe fields.

**Verification:**

```powershell
npx vitest run tests/unit/run-debug.test.ts tests/unit/schemas.test.ts
npm run typecheck
```

## Task 3: Instrument Probes, Quota Preflight, And Runtime Callers

**Files likely touched:**

- `src/models/probes.ts`
- `src/models/fallback-caller.ts`
- `src/models/vision-json.ts`
- `src/models/openrouter-client.ts`
- `src/models/nvidia-client.ts`
- `src/models/free-quota.ts`
- `src/pipeline/run-ui-diff.ts`
- model-client and fallback-caller tests

- [x] Add an optional trace sink or callback that model probes can call for each provider/model/role probe result.
- [x] Record why repeated same-model probe calls occurred by including role and phase. Example: the same model family can be probed once as auditor and once as reviewer.
- [x] Record quota preflight results without storing API key data.
- [x] Add trace hooks to the OpenRouter and NVIDIA vision callers for `call_start`, `call_success`, and `call_error`.
- [x] Make fallback-caller emit `route_unhealthy`, `fallback`, and `route_exhausted` events with the reason used to advance the sticky route index.
- [x] Preserve current user-facing warnings for NVIDIA to OpenRouter fallback, but use provider trace as the detailed source of truth.
- [x] Make sure exceptions thrown before a provider generation is created still produce local trace events, because provider dashboards may omit those failed attempts.

**Verification:**

```powershell
npx vitest run tests/unit/fallback-caller.test.ts tests/unit/model-clients.test.ts tests/unit/model-probes.test.ts
npm run typecheck
```

## Task 4: Tighten Route-Health Semantics

**Files likely touched:**

- `src/models/fallback-caller.ts`
- `src/models/vision-json.ts`
- `src/audit/audit-target.ts`
- `src/recovery/target-recovery.ts`
- fallback and audit/recovery tests

- [x] Keep retryable provider failures sticky-skipped for the rest of the role/run.
- [x] Treat these as route-health failures:
  - HTTP 429 or provider quota exhaustion,
  - provider timeout,
  - transport/network failure,
  - malformed/truncated provider JSON,
  - strict schema parse failure caused by invalid provider output.
- [x] Do not mark a route unhealthy for valid negative decisions:
  - auditor `hasDiff: false`,
  - recovery `classified: false`,
  - reviewer rejection with a valid schema.
- [x] Distinguish provider failure from model judgment in trace fields and debug summaries.
- [x] Keep `free_nvidia` exhaustion explicit: no OpenRouter fallback, status incomplete/model-unavailable as appropriate, and provider trace shows route exhaustion.

**Verification:**

```powershell
npx vitest run tests/unit/fallback-caller.test.ts tests/unit/audit.test.ts tests/unit/target-recovery.test.ts
npm run typecheck
```

## Task 5: Report Route Diversity And Trace Coverage In Gates

**Files likely touched:**

- `tests/live/calorix-smoke.live.test.ts`
- `tests/live/mcp-full.live.test.ts`
- `tests/live/openrouter.live.test.ts`
- `docs/release/production-readiness-checklist.md`

- [x] Require `provider_trace` artifact presence in Calorix bounded and full gates.
- [x] Assert `provider-trace.json` has at least probe events and runtime events for the selected auditor/reviewer routes.
- [x] If a provider fallback warning appears, assert the trace contains a matching `fallback` event.
- [x] If at least two different-family OpenRouter auditor routes pass probes, assert the auditor fallback chain includes more than one OpenRouter family.
- [x] If the fallback chain contains same-family native+OpenRouter routes, log a clear diagnostic warning rather than treating it as a silent success.
- [x] Update production-readiness checklist so release sign-off requires provider trace alongside audit, coverage, and recovery traces.

**Verification:**

```powershell
npx vitest run tests/live/calorix-smoke.live.test.ts --run
npx vitest run tests/live/mcp-full.live.test.ts tests/live/openrouter.live.test.ts --run
npm run typecheck
```

Live tests require the environment variables documented in `AGENTS.md`.

## Task 6: Update Operator-Facing Diagnostics

**Files likely touched:**

- `README.md`
- `docs/release/production-readiness-checklist.md`
- `docs/implementation-status.md`

- [x] Document what `provider-trace.json` contains and what it deliberately omits.
- [x] Document that OpenRouter activity exports show OpenRouter-routed generations only; native NVIDIA API calls are not expected there.
- [x] Document that failed HTTP/probe attempts may be absent from provider dashboards but must appear in local provider trace.
- [x] Add a short triage recipe:
  - check `report.json` warnings,
  - open `provider-trace.json`,
  - group by `role/provider/modelFamilyKey/event`,
  - compare with `audit-trace.json` only after route health is understood.
- [x] Update `docs/implementation-status.md` with the active plan, intended verification, and latest known Calorix blocker.

**Verification:**

```powershell
git diff --check
```

## Task 7: Full Verification And Fresh Gate Sign-Off

**Files likely touched:**

- `docs/implementation-status.md`
- optionally `docs/release/*.md` if a fresh readiness report is written

- [x] Run deterministic verification:

```powershell
npm run verify
```

- [x] Run live gates in this order:

```powershell
npm run verify:nvidia-live
npm run verify:openrouter-free-live
npm run verify:mcp-live
npm run verify:calorix-live
npm run verify:calorix-full-live
```

- [x] For the fresh Calorix reports, record:
  - `locatorActualMode`,
  - `visualClassificationStatus`,
  - selected auditor/reviewer/recovery routes,
  - provider-trace artifact path,
  - fallback events by role,
  - route exhaustion reasons if the gate still fails.
- [x] Update plan checkboxes and implementation status before committing the sign-off or failure report.

**Verification:**

```powershell
git diff --check
git status --short
```

## Acceptance Criteria

- `free` mode remains NVIDIA-first when native NVIDIA routes pass role probes.
- `free` mode can include multiple OpenRouter `:free` fallback routes.
- Different-family OpenRouter fallbacks are preferred over a same-family provider switch when they pass probes.
- `free_nvidia` never uses OpenRouter.
- `free_openrouter` never uses NVIDIA.
- Every run writes `provider-trace.json` with scrubbed probe/call/fallback/route-health metadata.
- The provider trace explains fallback decisions even when provider dashboards omit failed attempts.
- Calorix bounded and full gates require `provider_trace` artifact presence.
- Release sign-off is blocked if `visualClassificationStatus` is incomplete without a provider trace explaining route exhaustion or skipped recovery.

## Gemini Review

Gemini 3 Pro Preview review on 2026-06-17:

- Command: `gemini -m gemini-3-pro-preview --approval-mode plan --skip-trust --output-format text -p "..."`
- `AGREEMENT_STATUS: agree`
- `MUST_FIX: none`
- `SHOULD_FIX: none`
- `RATIONALE: The plan directly and comprehensively addresses the observed failure by preserving the NVIDIA-first requirement in free mode while ensuring diverse OpenRouter fallbacks are queued. It clearly defines the scrubbed schema for provider-trace.json to prevent leaking sensitive data, explicitly maintains the strict boundaries for free_nvidia and free_openrouter, and incorporates the required Calorix gate diagnostic assertions. It strictly adheres to the non-goal of not falling back to paid providers by default.`
