# OpenCode Provider And Report Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenCode Zen MiMo V2.5 Free as the preferred default free visual provider, reduce redundant provider probes, index the comparison-space image, and make stage outcomes semantically truthful.

**Architecture:** A direct OpenAI-compatible OpenCode adapter implements the existing `VisionJsonCaller` contract. The registry and probe dispatcher become provider-aware for `opencode`, default free selection orders OpenCode before NVIDIA and OpenRouter, and the report separates stage execution lifecycle from semantic outcome.

**Tech Stack:** TypeScript 5.9, Node.js 22 fetch, Zod 4, Vitest 4, OpenCode Zen OpenAI-compatible API, Sharp.

## Global Constraints

- No user-authored target maps, ROI maps, ignore masks, anchor dumps, or manual criterion configuration.
- No causality explanations, app-edit recommendations, or MCP-edit recommendations in findings.
- Default `free` mode must never call paid routes.
- `opencode/deepseek-v4-flash-free` is not eligible for image-grounded roles because current OpenCode metadata marks it text-only.
- Every production-code behavior change follows red-green-refactor TDD.
- Every completed task updates `docs/implementation-status.md`, commits, and pushes to `origin`.
- Never commit API keys, generated run artifacts, build output, or dependency folders.

## File Map

- Create `src/models/opencode-client.ts`: direct OpenCode Zen `VisionJsonCaller` adapter.
- Create `src/models/provider-config.ts`: one typed provider configuration object and environment resolver.
- Modify `src/models/vision-json.ts`: shared provider ID and reusable structured retry boundary.
- Modify `src/models/model-registry.ts`: OpenCode route, provider mode, and fallback ordering.
- Modify `src/models/probes.ts`: OpenCode dispatch and unique-route/max-image probe reuse.
- Modify `src/pipeline/run-ui-diff.ts`: env wiring, caller creation, exact stage outcomes, comparison artifact registration.
- Modify `src/schemas/core.ts`: provider-safe parse errors, new artifact role, and stage outcome schema.
- Modify `src/report/report-writer.ts` only if index behavior requires explicit role handling after the run artifact is registered.
- Create `tests/unit/opencode-client.test.ts`: adapter request/response/error tests.
- Modify `tests/unit/model-registry.test.ts`, `tests/unit/probes.test.ts`, `tests/unit/schemas.test.ts`, and `tests/e2e/compare-ui-images.test.ts`.
- Create `tests/live/opencode-live.test.ts`: real free-route image/schema gate.
- Modify `tests/live/calorix-smoke.live.test.ts`: strict stage-outcome and exact-provider assertions.
- Modify `package.json`, `.env.example`, `README.md`, release checklist/status docs.

---

### Task 1: Provider Types And OpenCode Route Policy

**Files:**
- Modify: `src/models/vision-json.ts`
- Modify: `src/models/model-registry.ts`
- Test: `tests/unit/vision-json.test.ts`
- Test: `tests/unit/model-registry.test.ts`

**Interfaces:**
- Produces: `VisionProvider = "openrouter" | "nvidia" | "opencode"`.
- Produces: `VisionMode` including `free_opencode`.
- Produces: `VisionProviderConfig` with all three provider credentials/base URLs.
- Produces: canonical `opencode/mimo-v2.5-free` route for auditor, reviewer, and recovery.

- [x] **Step 1: Write failing provider/type and selection tests**

Add tests proving:

```ts
expect(resolveMode("free_opencode")).toBe("free_opencode");
expect(selectModelForMode("auditor", "free", probes, {})).toMatchObject({
  provider: "opencode",
  model: "mimo-v2.5-free",
  costClass: "free"
});
expect(selectFallbackModelsForMode("auditor", "free_opencode", probes, 3, {}))
  .toSatisfy(routes => routes.every(route => route.provider === "opencode"));
expect(CANONICAL_MODEL_RANKING.flatMap(entry => entry.eligibleFreeProviderRoutes))
  .not.toContainEqual({ provider: "opencode", model: "deepseek-v4-flash-free" });
```

- [x] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/vision-json.test.ts tests/unit/model-registry.test.ts`

Expected: failures for unknown `opencode` provider/mode and missing MiMo route.

- [x] **Step 3: Implement the shared provider types and configuration**

Create `src/models/provider-config.ts` with:

```ts
export interface VisionProviderConfig {
  openRouterApiKey: string;
  nvidiaApiKey: string;
  nvidiaBaseUrl: string;
  openCodeApiKey: string;
  openCodeBaseUrl: string;
}

export function resolveVisionProviderConfig(
  env: Record<string, string | undefined> = process.env
): VisionProviderConfig {
  return {
    openRouterApiKey: env["OPENROUTER_API_KEY"] ?? "",
    nvidiaApiKey: env["NVIDIA_API_KEY"] ?? "",
    nvidiaBaseUrl: env["NVIDIA_VLM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1",
    openCodeApiKey: env["OPENCODE_API_KEY"]?.trim() || "public",
    openCodeBaseUrl: env["OPENCODE_ZEN_BASE_URL"] ?? "https://opencode.ai/zen/v1"
  };
}
```

Use `VisionProvider` in every currently closed provider type, including:

- `ProviderJsonParseError` constructor;
- `parseVisionJsonContent` provider argument;
- `SelectedVisionModel.provider`;
- `ModelEntry.provider`;
- `eligibleFreeProviderRoutes` and `paidRoutes`;
- `findValidProbe`;
- selected/excluded route parameters.

- [x] **Step 4: Implement minimal route selection**

Add a shared provider type, extend parse diagnostics to it, add `free_opencode`, and place MiMo at the top of the canonical free ranking with:

```ts
capabilities: {
  maxImages: 5,
  supportsJsonSchema: true,
  supportsJsonObject: true,
  supportsStreaming: true,
  allowedRoles: ["auditor", "reviewer", "target_recovery"]
}
```

Add explicit `selectModelForMode` branches for `opencode` in both `free` and `free_opencode`. Refactor fallback collection into three phases in the exact provider order `opencode`, `nvidia`, `openrouter`, then apply family diversity within later providers. Explicit provider modes must contain only their named provider. NVIDIA key availability continues to gate NVIDIA; OpenCode is eligible with the resolved `public` credential.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `npx vitest run tests/unit/vision-json.test.ts tests/unit/model-registry.test.ts`

Expected: PASS.

- [x] **Step 6: Update tracking, commit, and push**

Commit: `feat(models): define opencode free route policy`

### Task 2: Direct OpenCode Zen Vision Caller

**Files:**
- Create: `src/models/opencode-client.ts`
- Modify: `src/models/vision-json.ts`
- Test: `tests/unit/opencode-client.test.ts`

**Interfaces:**
- Produces: `makeOpenCodeVisionCaller(apiKey?: string, model?: string, baseUrl?: string): VisionJsonCaller`.
- Default model: `mimo-v2.5-free`.
- Default base URL: `https://opencode.ai/zen/v1`.
- Default free credential value: `public`.

- [ ] **Step 1: Write failing adapter tests**

Tests must exercise real request construction through a stubbed `fetch` and assert:

```ts
expect(url).toBe("https://opencode.ai/zen/v1/chat/completions");
expect(headers.Authorization).toBe("Bearer public");
expect(body.model).toBe("mimo-v2.5-free");
expect(body.messages[0].content.map((part: { type: string }) => part.type))
  .toEqual(["text", "image_url", "image_url"]);
expect(body.response_format.type).toBe("json_schema");
```

Also cover custom key/base URL, parser-only mode, provider-returned concrete model/usage, non-2xx response, empty content, schema-invalid content, and one compact structured retry.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/opencode-client.test.ts`

Expected: module-not-found or missing export failure.

- [ ] **Step 3: Implement the caller**

Resolve credentials inside the adapter with `apiKey?.trim() || process.env["OPENCODE_API_KEY"]?.trim() || "public"`, so direct adapter callers and pipeline callers behave identically. Use one non-streaming OpenAI-compatible request. Parse `choices[0].message.content` through `parseVisionJsonContent("opencode", ...)`. Never store prompt text, image data, auth headers, or raw provider response bodies in traces.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/unit/opencode-client.test.ts tests/unit/vision-json.test.ts`

Expected: PASS.

- [ ] **Step 5: Update tracking, commit, and push**

Commit: `feat(models): add opencode zen vision caller`

### Task 3: Probe Deduplication And OpenCode Dispatch

**Files:**
- Modify: `src/models/probes.ts`
- Test: `tests/unit/probes.test.ts`
- Test: `tests/integration/probes.integration.test.ts`

**Interfaces:**
- Replace positional provider parameters with `probeRequiredModels(entries, config: VisionProviderConfig, traceSink?)`.
- Update `probeAuditCapability`, `probeReviewerCapability`, `probeRecoveryCapability`, the pipeline `ProbeOverride`, benchmark scripts, and all unit/integration/live call sites to use the same `VisionProviderConfig` object.
- One provider/model route is called once per run at the maximum requested image count; results are projected to every requested role.

- [ ] **Step 1: Write failing probe tests**

Create auditor, reviewer, and target-recovery entries for the same OpenCode MiMo route. Stub `fetch` once and assert:

```ts
expect(fetch).toHaveBeenCalledTimes(1);
expect(results.map(result => result.role).sort())
  .toEqual(["auditor", "reviewer", "target_recovery"]);
expect(results.every(result => result.status === "pass")).toBe(true);
expect(results.every(result => result.maxImagesSupported === 5)).toBe(true);
```

Also prove that an absent `OPENCODE_API_KEY` still probes with `public`, while OpenRouter/NVIDIA retain their credential requirements.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/probes.test.ts tests/integration/probes.integration.test.ts`

Expected: OpenCode dispatch missing and duplicate call count greater than one.

- [ ] **Step 3: Implement explicit provider dispatch and grouped max-image probing**

Replace every binary `provider === "nvidia" ? nvidia : openrouter` expression with an exhaustive provider switch:

```ts
switch (entry.provider) {
  case "opencode":
    return makeOpenCodeVisionCaller(config.openCodeApiKey, entry.model, config.openCodeBaseUrl);
  case "nvidia":
    return makeNvidiaVisionCaller(config.nvidiaApiKey, entry.model, config.nvidiaBaseUrl);
  case "openrouter":
    return makeOpenRouterVisionCaller(config.openRouterApiKey, entry.model);
}
```

OpenCode must never inherit an OpenRouter key, endpoint, or missing-key message. Remove the unrecognized-role fallback that maps every non-NVIDIA route to `probeOpenRouterModel`; dispatch by provider there as well.

Group entries by `${provider}:${model}`. Probe the maximum `requiredImagesForRole` value once, then clone the validated result with each original role. Emit role-specific `probe_result` metadata without duplicating provider calls.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npx vitest run tests/unit/probes.test.ts tests/integration/probes.integration.test.ts`

Expected: PASS.

- [ ] **Step 5: Update tracking, commit, and push**

Commit: `feat(models): probe opencode routes once per run`

### Task 4: Pipeline Provider Wiring And Exact Reporting

**Files:**
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `tests/e2e/compare-ui-images.test.ts`
- Modify: `tests/fixtures/mock-models.ts`

**Interfaces:**
- Consumes: `makeOpenCodeVisionCaller` and OpenCode model entries.
- Produces: exact `modelSelection` and provider trace entries for runtime OpenCode calls.

- [ ] **Step 1: Write a failing pipeline e2e test**

Run the full fixture pipeline in `free_opencode` with a passing OpenCode probe override and fetch fixture. Assert:

```ts
expect(report.modelSelection?.auditor).toMatchObject({ provider: "opencode", model: "mimo-v2.5-free" });
expect(report.modelSelection?.reviewer).toMatchObject({ provider: "opencode", model: "mimo-v2.5-free" });
expect(report.modelSelection?.targetRecovery).toMatchObject({ provider: "opencode", model: "mimo-v2.5-free" });
expect(providerTrace.some(event => event.provider === "opencode" && event.event === "call_success")).toBe(true);
```

- [ ] **Step 2: Run the e2e test and verify RED**

Run: `npx vitest run tests/e2e/compare-ui-images.test.ts`

Expected: missing mode/caller routing failure.

- [ ] **Step 3: Wire shared provider configuration and exhaustive caller creation**

Resolve once:

```ts
const providerConfig = resolveVisionProviderConfig(process.env);
```

Change `makeVisionCaller(entry, providerConfig)` to an exhaustive provider switch and call `makeOpenCodeVisionCaller` for `opencode`. Pass the same object to `probeRequiredModels` and the pipeline `ProbeOverride`. Update no-model warnings to name all configured free providers without implying an OpenRouter/NVIDIA key is mandatory for OpenCode.

- [ ] **Step 4: Run e2e and focused model tests**

Run: `npx vitest run tests/e2e/compare-ui-images.test.ts tests/unit/model-registry.test.ts tests/unit/probes.test.ts`

Expected: PASS.

- [ ] **Step 5: Update tracking, commit, and push**

Commit: `feat(pipeline): route free vision through opencode`

### Task 5: Index The Comparison-Space Artifact

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Test: `tests/unit/schemas.test.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`

**Interfaces:**
- Produces artifact role `actual_comparison_space`.

- [ ] **Step 1: Write failing schema and e2e assertions**

Assert the final report has exactly one `actual_comparison_space` artifact and that `artifacts/index.json` contains the same canonical path.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/unit/schemas.test.ts tests/e2e/compare-ui-images.test.ts`

Expected: role rejected or missing from `runArtifacts`/index.

- [ ] **Step 3: Register the artifact**

Add the role to `UiArtifactSchema` and add:

```ts
{ role: "actual_comparison_space", path: actualComparisonPath }
```

to the initial run artifact list.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `npx vitest run tests/unit/schemas.test.ts tests/e2e/compare-ui-images.test.ts`

Expected: PASS.

- [ ] **Step 5: Update tracking, commit, and push**

Commit: `fix(report): index actual comparison image`

### Task 6: Truthful Stage Outcomes

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `tests/unit/schemas.test.ts`
- Modify: `tests/e2e/compare-ui-images.test.ts`
- Modify: `tests/live/calorix-smoke.live.test.ts`

**Interfaces:**
- Produces: `StageOutcome = "success" | "incomplete" | "unavailable" | "not_applicable"`.
- Every final report contains `model_probe`, `audit`, and `target_recovery` stage records.

- [ ] **Step 1: Write failing final-report tests**

Cover four cases:

```ts
expect(stage("audit")).toMatchObject({ status: "complete", outcome: "incomplete", detail: "route_exhausted" });
expect(stage("target_recovery")).toMatchObject({ status: "complete", outcome: "incomplete", detail: "deadline_exceeded" });
expect(stage("model_probe")).toMatchObject({ status: "complete", outcome: "unavailable" });
expect(deterministicStage("audit")).toMatchObject({ status: "skipped", outcome: "not_applicable" });
```

Also assert a fully successful semantic fixture reports `success` for all performed provider stages.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/unit/schemas.test.ts tests/e2e/compare-ui-images.test.ts`

Expected: missing stage outcome and sparse stage records.

- [ ] **Step 3: Implement lifecycle/outcome separation**

Extend `StageStatusSchema` with `outcome`. For legacy reports that omit it, preprocess `status: skipped` to `not_applicable` and every other missing outcome to `incomplete`; this fail-closed compatibility rule prevents an old `complete` lifecycle value from becoming semantic success. Change `checkpoint(stageName, stageStatus, outcome, detail, ...)` and update every call site in `run-ui-diff.ts` in the same task, so no newly written checkpoint can omit outcome. Update all typed stage fixtures to carry explicit outcomes.

Rules:

- `model_probe`: `success` only when required role callers are selectable; otherwise `unavailable`.
- `audit`: `success` only when `failedPairs === 0`, `remainingPairs === 0`, and `stoppedReason === none`; route exhaustion is `incomplete`.
- `target_recovery`: no components is `skipped/not_applicable`; missing caller is `complete/unavailable`; non-none stop reason or unclassified regions is `complete/incomplete`; otherwise `complete/success`.
- `deterministic_only`: all three provider stages are `skipped/not_applicable`.

- [ ] **Step 4: Harden the strict live gate**

Require provider stage outcome truth:

```ts
expect(stage("model_probe").outcome).toBe("success");
expect(stage("audit").outcome).toBe("success");
expect(["success", "not_applicable"]).toContain(stage("target_recovery").outcome);
```

Diagnostic gates may accept `incomplete` only while printing a degraded-pass warning.

- [ ] **Step 5: Run focused and e2e tests**

Run: `npx vitest run tests/unit/schemas.test.ts tests/e2e/compare-ui-images.test.ts tests/unit/report-writer.test.ts`

Expected: PASS.

- [ ] **Step 6: Update tracking, commit, and push**

Commit: `fix(report): distinguish stage completion from outcome`

### Task 7: Live Gates And Operator Documentation

**Files:**
- Create: `tests/live/opencode-live.test.ts`
- Modify: `package.json`
- Modify: `scripts/require-live-env.js`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/release/production-readiness-checklist.md`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Produces: `npm run verify:opencode-live` guarded by `RUN_OPENCODE_LIVE=1`.

- [ ] **Step 1: Write the live gate**

The real gate must:

- fetch the current OpenCode model catalog and require `mimo-v2.5-free`;
- verify the selected model is image-capable through a real one-image structured request;
- run the five-image role probe and require correct image count/schema;
- run auditor, reviewer, and target-recovery probes through `probeRequiredModels`;
- print provider-returned model, duration, finish reason, and token usage without printing prompts, image data, or credentials.

- [ ] **Step 2: Add scripts and docs**

Add:

```json
"verify:opencode-live": "node scripts/require-live-env.js RUN_OPENCODE_LIVE && npm run build && vitest run tests/live/opencode-live.test.ts --testTimeout 300000"
```

Document `OPENCODE_API_KEY` as optional for the current public free route, `OPENCODE_ZEN_BASE_URL`, the temporary nature of free models, MiMo's visual eligibility, and DeepSeek V4 Flash's current text-only exclusion.

- [ ] **Step 3: Run deterministic verification**

Run:

```powershell
npm run verify
npm run test:coverage
npm audit --audit-level=critical
git diff --check
```

Expected: all commands PASS and coverage thresholds remain satisfied.

- [ ] **Step 4: Run the OpenCode live gate**

Run:

```powershell
$env:RUN_OPENCODE_LIVE="1"
npm run verify:opencode-live
```

Expected: catalog, one-image JSON, five-image JSON, and all three role probes PASS with `provider: opencode` and route `mimo-v2.5-free`.

- [ ] **Step 5: Run current-head pipeline gates**

Run in order:

```powershell
$env:RUN_UI_DIFF_LIVE="1"
npm run verify:mcp-live

$env:RUN_CALORIX_UI_DIFF_LIVE="1"
npm run verify:calorix-live

$env:RUN_CALORIX_FULL_LIVE="1"
npm run verify:calorix-full-live

$env:RUN_CALORIX_RELEASE_LIVE="1"
npm run verify:calorix-release-live
```

Use the seeded Calorix actual screenshot recorded in `docs/implementation-status.md`. Do not set `UI_DIFF_MAX_AUDIT_PAIRS` for full/release gates.

Expected strict result: visual classification complete, no audit failures/remaining pairs, no unresolved regions, OpenCode recorded exactly when selected, indexed comparison-space artifact present, and semantic stage outcomes green.

- [ ] **Step 6: Record exact evidence**

Record run IDs, provider routes, route transitions, final diff/unresolved counts, audit/recovery accounting, stage outcomes, durations, and gate results. A failed strict gate remains a release blocker and must be written as such.

- [ ] **Step 7: Update tracking, commit, and push**

Commit: `test(live): gate opencode semantic pipeline`

### Task 8: External Implementation Review

**Files:**
- Modify only files required by valid review findings.
- Modify: `docs/implementation-status.md`
- Modify: this plan's checkboxes/review appendix.

- [ ] **Step 1: Request Gemini 3.1 Pro Preview review through Antigravity MCP**

Use the same conversation as the plan review. Supply the approved plan, base/head SHAs, changed files, verification output, and live evidence. Require:

```text
AGREEMENT_STATUS: agree|disagree
MUST_FIX: none|...
SHOULD_FIX: none|...
QUESTIONS: none|...
```

- [ ] **Step 2: Address every valid MUST_FIX with TDD**

Continue the same Antigravity conversation until it reports `AGREEMENT_STATUS: agree` and `MUST_FIX: none`.

- [ ] **Step 3: Run final verification**

Run `npm run verify`, focused changed tests, `npm run test:coverage`, `npm audit --audit-level=critical`, and `git diff --check`.

- [ ] **Step 4: Final tracking commit and push**

Record the external review result, any unusual Antigravity MCP output, final HEAD, verification counts, live run IDs, and production decision.

## Acceptance Criteria

- Default `free` mode selects `opencode/mimo-v2.5-free` when its real role probe passes.
- `free_opencode` never selects NVIDIA, OpenRouter, or paid routes.
- DeepSeek V4 Flash is not presented as a visual model.
- Equivalent auditor/reviewer/recovery capability probes make one provider call per route at the maximum required image count.
- Every report records exact selected provider/model routes and provider trace events.
- `actual-comparison-space.png` is present in `runArtifacts` and `artifacts/index.json`.
- Every final report contains truthful provider-stage outcomes; route/deadline exhaustion cannot appear as semantic success.
- Deterministic, unit/e2e, integration, coverage, security audit, OpenCode live, MCP live, and Calorix gates are recorded from current HEAD.
- The project is called production-ready only if the strict Calorix release gate passes without incomplete classification or unresolved regions.

## External Review

Gemini 3.1 Pro Preview review through Antigravity MCP conversation `ui-diff-opencode-provider-truth-20260623`:

- Pass 1: `AGREEMENT_STATUS: disagree`. Seven must-fix findings identified closed two-provider type/signature branches and missing checkpoint outcomes; two should-fix findings required explicit three-provider ordering and credential precedence.
- Revisions: added one shared provider/config contract, exhaustive dispatch requirements, exact probe/pipeline signatures, three-phase selection, and fail-closed legacy stage semantics.
- Pass 2: `AGREEMENT_STATUS: agree`, `MUST_FIX: none`, `SHOULD_FIX: none`, `QUESTIONS: none`.
- Tool note: the first response contained minor line-wrap/heading concatenation artifacts but no unrelated or injected content. The second response was clean.
