# Model Diagnostics, Recovery Routing, And Projection Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Calorix-scale UI diff runs explain provider/model failures precisely, use strong audited VLM routes for target recovery, avoid whole-screen source-image stretching, and report projected-crop mismatches as honest evidence rather than over-interpreted UI findings.

**Architecture:** Keep the existing TypeScript pipeline and MCP tool surface. Add structured provider diagnostics at the model adapter boundary, expand route selection through the existing probe system, replace `fit: "fill"` source-image normalization with explicit coordinate transforms, and tighten final diff records so deterministic projection failures are labeled as projection evidence unless a model/recovery stage classifies them further.

**Tech Stack:** TypeScript ESM, Zod v4, Sharp, pixelmatch, Vitest, MCP TypeScript SDK, existing NVIDIA/OpenRouter provider adapters, existing LocateAnything/screen-parser locator lanes.

## Global Constraints

- The MCP reports visible UI differences only; no root-cause explanations, no app-code/config recommendations, and no MCP-edit recommendations.
- Default mode remains free-first: native NVIDIA free routes first, OpenRouter `:free` routes only when probed and selected by mode, paid routes only when mode is `paid` and `UI_DIFF_ENABLE_PAID_MODE=1`.
- No user-authored target maps, ROI maps, ignore masks, anchor dumps, or manual configs.
- Every repository change must update `docs/implementation-status.md`, commit, and push to `origin`.
- Report artifacts must not contain API keys, raw prompts with secrets, or full raw provider bodies. Diagnostics may contain scrubbed/truncated response snippets only.
- Production sign-off still requires `verify:calorix-release-live`: `visualClassificationStatus === "complete"`, `auditLimited === false`, and projection/viewport handling must not silently distort source pixels.

## Current Evidence Driving This Plan

- Latest inspected Calorix full run: `run-1781791535977-e68b2d`.
- That run audited `79 / 79` target pairs but ended `visualClassificationStatus: "incomplete"`, `viewportCompatibilityStatus: "mismatch"`, `627` final diffs, `617` unclassified diffs, and only `2` non-deterministic reviewed accepted diffs.
- Auditor route chain in that run was `nvidia/qwen/qwen3.5-397b-a17b` -> `nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` -> `openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`.
- Invalid JSON evidence was truncated to provider-trace snippets. The full raw body was intentionally not persisted, so exact failure forensics are currently impossible.
- Target recovery had no caller because all configured recovery probes failed: `nvidia/cosmos3-nano-reasoner` returned `404`, `openrouter/google/gemma-4-31b-it:free` returned `429`, and `openrouter/nex-agi/nex-n2-pro:free` timed out.
- Current image normalization uses Sharp `fit: "fill"` to resize actual to expected dimensions. Sharp documents `fill` as fitting the exact target dimensions; this can squeeze/stretch when aspect ratios differ. Current Calorix expected/actual dimensions differ enough to create non-uniform scaling.

## Research Notes

- OpenRouter structured output uses `response_format` with `type: "json_schema"` and local validation is still required: https://openrouter.ai/docs/guides/features/structured-outputs
- NVIDIA NIM/VLM APIs expose OpenAI-compatible streaming endpoints; structured generation support and model behavior are model-specific, so role probes remain mandatory: https://docs.nvidia.com/nim/vision-language-models/latest/api-reference.html and https://docs.nvidia.com/nim/vision-language-models/1.2.0/structured-generation.html
- Sharp resize `fit` choices include `fill`, `contain`, `cover`, `inside`, and `outside`; `fill` reaches the requested width/height and can distort aspect ratio: https://sharp.pixelplumbing.com/api-resize/

## File Structure

- Modify `src/models/vision-json.ts`: throw typed parse errors with scrubbed response diagnostics for OpenRouter and NVIDIA calls.
- Modify `src/models/fallback-caller.ts`: copy provider diagnostics into `provider-trace.json` events without full raw bodies.
- Modify `src/debug/provider-trace.ts`: extend trace schema and writer for provider failure diagnostics.
- Modify `src/schemas/core.ts`: add provider diagnostic schema, projection transform schema, and deterministic classification source fields.
- Modify `src/models/model-registry.ts`: allow strong auditor/reviewer routes to be eligible for target recovery when `maxImages >= 4` and role probe passes.
- Modify `src/models/probes.ts`: keep recovery probes at 4 images but probe all recovery-eligible candidates, not just dedicated weak recovery entries.
- Modify `src/images/normalize.ts`: stop resizing source images for normal pipeline use; return original normalized PNG and metadata.
- Create `src/images/coordinates.ts`: source-to-source coordinate transform helpers.
- Modify `src/pipeline/run-ui-diff.ts`: keep original expected/actual normalized images, create separate comparison-space buffers/artifacts only for pixel diff/overlay, and pass transformed actual source crops to audit/recovery.
- Modify `src/locator/element-map.ts`: store projection metadata with explicit `expectedSourceBox`, `actualSourceBox`, scale factors, and transform confidence.
- Modify `src/audit/projected-mismatch.ts`: rename output semantics from generic color diff to projected target absence/mismatch.
- Modify `src/audit/audit-target.ts`: emit deterministic projected-crop mismatch records with explicit classification source and honest criterion/title.
- Modify `src/audit/prompts.ts`: constrain auditor/reviewer wording to visible crop evidence and forbid unsupported crop-boundary wording.
- Modify `src/recovery/target-recovery.ts`: consume original-space crops and report recovery route/model diagnostics per component.
- Modify `tests/unit/model-clients.test.ts`, `tests/unit/fallback-caller.test.ts`, `tests/unit/model-registry.test.ts`, `tests/unit/model-probes.test.ts`, `tests/unit/images.test.ts`, `tests/unit/element-map.test.ts`, `tests/unit/projected-mismatch.test.ts`, `tests/unit/audit.test.ts`, and `tests/e2e/compare-ui-images.test.ts`.
- Modify `tests/live/calorix-smoke.live.test.ts`: assert new diagnostic and projection contracts.
- Modify `docs/release/production-readiness-checklist.md`, `.env.example`, and `docs/implementation-status.md`.

---

## Task 1: Provider Failure Diagnostics

**Files:**
- Modify: `src/models/vision-json.ts`
- Modify: `src/models/fallback-caller.ts`
- Modify: `src/debug/provider-trace.ts`
- Modify: `src/schemas/core.ts`
- Test: `tests/unit/model-clients.test.ts`
- Test: `tests/unit/fallback-caller.test.ts`

**Interfaces:**
- Produces: `ProviderFailureDiagnostic` with fields:
  ```ts
  {
    kind: "invalid_json" | "http_error" | "timeout" | "stream_error";
    rawContentLength?: number;
    firstChars?: string;
    lastChars?: string;
    startsWithJson?: boolean;
    endsWithJson?: boolean;
    streamCompleted?: boolean;
    httpStatus?: number;
  }
  ```
- Produces: `ProviderJsonParseError extends Error` with `diagnostic: ProviderFailureDiagnostic`.
- Consumes: existing `ProviderTraceWriter.emit(...)` in fallback caller and probes.

- [x] **Step 1: Add provider diagnostic schema**

Add to `src/schemas/core.ts`:

```ts
export const ProviderFailureDiagnosticSchema = z.object({
  kind: z.enum(["invalid_json", "http_error", "timeout", "stream_error"]),
  rawContentLength: z.number().int().min(0).optional(),
  firstChars: z.string().max(500).optional(),
  lastChars: z.string().max(500).optional(),
  startsWithJson: z.boolean().optional(),
  endsWithJson: z.boolean().optional(),
  streamCompleted: z.boolean().optional(),
  httpStatus: z.number().int().min(100).max(599).optional()
});
export type ProviderFailureDiagnostic = z.infer<typeof ProviderFailureDiagnosticSchema>;
```

Expected test command after implementation: `npx vitest run tests/unit/model-clients.test.ts tests/unit/fallback-caller.test.ts`

- [x] **Step 2: Add typed parse errors**

In `src/models/vision-json.ts`, define:

```ts
export class ProviderJsonParseError extends Error {
  readonly diagnostic: ProviderFailureDiagnostic;

  constructor(provider: "openrouter" | "nvidia", diagnostic: ProviderFailureDiagnostic) {
    super(`${provider} response content is not valid JSON`);
    this.name = "ProviderJsonParseError";
    this.diagnostic = diagnostic;
  }
}
```

Add helper:

```ts
function buildInvalidJsonDiagnostic(rawContent: string, streamCompleted: boolean): ProviderFailureDiagnostic {
  const trimmed = rawContent.trim();
  return {
    kind: "invalid_json",
    rawContentLength: rawContent.length,
    firstChars: trimmed.slice(0, 300),
    lastChars: trimmed.slice(Math.max(0, trimmed.length - 300)),
    startsWithJson: trimmed.startsWith("{") || trimmed.startsWith("["),
    endsWithJson: trimmed.endsWith("}") || trimmed.endsWith("]"),
    streamCompleted
  };
}
```

Replace invalid JSON throws with `ProviderJsonParseError`. Do not include full raw content in the error message.

- [x] **Step 3: Track stream completion**

In both OpenRouter and NVIDIA streaming readers, set `let streamCompleted = false;` before the loop and set it to `true` only after the stream loop exits without throwing. Pass it into `buildInvalidJsonDiagnostic(...)`.

- [x] **Step 4: Add diagnostics to trace events**

In `src/debug/provider-trace.ts`, extend `ProviderTraceEventSchema` with:

```ts
diagnostic: ProviderFailureDiagnosticSchema.optional()
```

In `src/models/fallback-caller.ts`, when catching an error, if `err instanceof ProviderJsonParseError`, include `diagnostic: err.diagnostic` on `call_error` and `route_unhealthy` trace events. For HTTP status errors, keep current `httpStatus` but also include:

```ts
diagnostic: { kind: "http_error", httpStatus: Number(httpStatus) }
```

For abort/timeout errors, include:

```ts
diagnostic: { kind: "timeout" }
```

- [x] **Step 5: Add unit tests**

Add tests that:

- mock NVIDIA stream chunks that form truncated JSON and assert `ProviderJsonParseError.diagnostic.endsWithJson === false`;
- assert provider trace stores `diagnostic.kind === "invalid_json"` and does not store the full raw body;
- assert HTTP 429 trace includes `diagnostic.kind === "http_error"` and `httpStatus === 429`.

Run:

```powershell
npx vitest run tests/unit/model-clients.test.ts tests/unit/fallback-caller.test.ts
```

Expected: all selected tests pass.

- [x] **Step 6: Verify and commit**

Run:

```powershell
npm run verify
```

Expected: typecheck, 367+ unit/e2e tests, sidecar parser tests, build, and integration tests pass.

Commit and push:

```powershell
git add src/models/vision-json.ts src/models/fallback-caller.ts src/debug/provider-trace.ts src/schemas/core.ts tests/unit/model-clients.test.ts tests/unit/fallback-caller.test.ts docs/implementation-status.md
git commit -m "feat(trace): add scrubbed provider failure diagnostics"
git push
```

## Task 2: Strong Recovery Route Eligibility

**Files:**
- Modify: `src/models/model-registry.ts`
- Modify: `src/models/probes.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Test: `tests/unit/model-registry.test.ts`
- Test: `tests/unit/model-probes.test.ts`

**Interfaces:**
- Produces: `candidateSupportsLogicalRole(candidate, logicalRole)` in `model-registry.ts`.
- Produces: target recovery candidates selected from any route whose `capabilities.maxImages >= 4` and whose `allowedRoles` contains `"target_recovery"`.
- Consumes: existing `probeRecoveryCapability(entry, ...)` with 4 images.

- [x] **Step 1: Make strong VLM candidates recovery-eligible**

For every auditor/reviewer candidate that can accept at least 4 images and is not single-image-only, add `"target_recovery"` to `capabilities.allowedRoles`. This includes:

- `moonshotai/kimi-k2.6`
- `minimaxai/minimax-m3`
- `mistralai/mistral-large-3-675b-instruct-2512`
- `qwen/qwen3.5-397b-a17b`
- `qwen/qwen3.6-35b-a3b`
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`
- `nex-agi/nex-n2-pro:free`
- `google/gemma-4-31b-it:free`
- `google/gemma-4-26b-a4b-it:free`
- `nvidia/nemotron-nano-12b-v2-vl`
- `nvidia/nemotron-nano-12b-v2-vl:free`

Do not add target recovery eligibility to models with `maxImages: 1`.

- [x] **Step 2: Select by capability, not only entry role**

Change `selectModelForMode` and `selectFallbackModelsForMode` candidate filtering from `candidate.role !== logicalRole` to:

```ts
candidateSupportsLogicalRole(candidate, logicalRole)
```

Implementation:

```ts
export function candidateSupportsLogicalRole(
  candidate: Pick<ModelEntry, "role" | "capabilities">,
  logicalRole: "auditor" | "reviewer" | "escalation" | "target_recovery"
): boolean {
  if (candidate.role === logicalRole) return true;
  if (!candidate.capabilities) return false;
  if (logicalRole === "target_recovery") {
    return candidate.capabilities.maxImages >= 4 && candidate.capabilities.allowedRoles.includes("target_recovery");
  }
  return candidate.capabilities.allowedRoles.includes(logicalRole);
}
```

- [x] **Step 3: Preserve role-specific probes**

When selecting a route for `logicalRole === "target_recovery"`, require a passing `ProbeResult` whose `role === "target_recovery"`, even if the candidate entry originally has `role: "auditor"` or `role: "reviewer"`.

Keep `requiredImagesForRole("target_recovery") === 4`.

- [x] **Step 4: Record expanded recovery routes**

Ensure `report.modelSelection.targetRecoveryRoutes` is populated with the selected recovery candidate list when any recovery candidate passes. The report must distinguish:

- `auditorRoutes`
- `reviewerRoutes`
- `targetRecoveryRoutes`

No target recovery route may be inferred by reading `auditorRoutes`.

- [x] **Step 5: Add route selection tests**

Add tests:

- Kimi/Qwen-style auditor candidate with a passing target-recovery probe is returned for `selectFallbackModelsForMode("target_recovery", "free", ...)`.
- A single-image Llama reviewer candidate is not returned for target recovery.
- A candidate with auditor probe pass but target-recovery probe fail is not returned for target recovery.
- OpenRouter free recovery candidates are included after NVIDIA free candidates in `mode: "free"`.

Run:

```powershell
npx vitest run tests/unit/model-registry.test.ts tests/unit/model-probes.test.ts
```

Expected: all selected tests pass.

- [x] **Step 6: Verify and commit**

Run:

```powershell
npm run verify
```

Commit and push:

```powershell
git add src/models/model-registry.ts src/models/probes.ts src/pipeline/run-ui-diff.ts tests/unit/model-registry.test.ts tests/unit/model-probes.test.ts docs/implementation-status.md
git commit -m "feat(models): use strong visual routes for target recovery"
git push
```

## Task 3: Non-Stretch Coordinate Projection

**Files:**
- Modify: `src/images/normalize.ts`
- Create: `src/images/coordinates.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/locator/element-map.ts`
- Modify: `src/audit/audit-target.ts`
- Modify: `src/recovery/target-recovery.ts`
- Test: `tests/unit/images.test.ts`
- Test: `tests/unit/element-map.test.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ImagePairTransform {
    expectedSize: { width: number; height: number };
    actualSize: { width: number; height: number };
    scaleExpectedToActualX: number;
    scaleExpectedToActualY: number;
    scaleActualToExpectedX: number;
    scaleActualToExpectedY: number;
  }
  ```
- Produces:
  ```ts
  export function projectExpectedBoxToActualSource(box: Box, transform: ImagePairTransform): Box
  export function projectActualBoxToExpectedSource(box: Box, transform: ImagePairTransform): Box
  export function resizeCropForComparison(cropPath, targetSize): Promise<...>
  ```
- Consumes: original normalized expected and actual images, not stretched source images.

- [x] **Step 1: Stop normalizing actual with `fit: "fill"` for source images**

In `run-ui-diff.ts`, change:

```ts
const expectedImg = await loadNormalizedImage(expectedAbs, normalizedExpPath);
const actualImg = await loadNormalizedImage(actualAbs, normalizedActPath, {
  width: expectedImg.width,
  height: expectedImg.height
});
```

to:

```ts
const expectedImg = await loadNormalizedImage(expectedAbs, normalizedExpPath);
const actualImg = await loadNormalizedImage(actualAbs, normalizedActPath);
```

Keep any comparison-sized image strictly as a separate artifact named `actual-comparison-space.png`, not as the source image used for crops.

- [x] **Step 2: Add coordinate transform helpers**

Create `src/images/coordinates.ts`:

```ts
import type { Box } from "../schemas/core.js";

export interface ImagePairTransform {
  expectedSize: { width: number; height: number };
  actualSize: { width: number; height: number };
  scaleExpectedToActualX: number;
  scaleExpectedToActualY: number;
  scaleActualToExpectedX: number;
  scaleActualToExpectedY: number;
}

export function createImagePairTransform(
  expectedSize: { width: number; height: number },
  actualSize: { width: number; height: number }
): ImagePairTransform {
  return {
    expectedSize,
    actualSize,
    scaleExpectedToActualX: actualSize.width / expectedSize.width,
    scaleExpectedToActualY: actualSize.height / expectedSize.height,
    scaleActualToExpectedX: expectedSize.width / actualSize.width,
    scaleActualToExpectedY: expectedSize.height / actualSize.height
  };
}

export function projectExpectedBoxToActualSource(box: Box, transform: ImagePairTransform): Box {
  return {
    x: box.x * transform.scaleExpectedToActualX,
    y: box.y * transform.scaleExpectedToActualY,
    width: box.width * transform.scaleExpectedToActualX,
    height: box.height * transform.scaleExpectedToActualY
  };
}

export function projectActualBoxToExpectedSource(box: Box, transform: ImagePairTransform): Box {
  return {
    x: box.x * transform.scaleActualToExpectedX,
    y: box.y * transform.scaleActualToExpectedY,
    width: box.width * transform.scaleActualToExpectedX,
    height: box.height * transform.scaleActualToExpectedY
  };
}
```

- [x] **Step 3: Move global pixel diff to comparison space**

For global pixel diff and coverage, create comparison-space copies:

- `expected-comparison-space.png`: same pixels as expected normalized image.
- `actual-comparison-space.png`: actual normalized image resized to expected dimensions.

Only these comparison-space artifacts may use `fit: "fill"`. The report must record:

```json
{
  "comparisonSpace": {
    "width": 1206,
    "height": 2622,
    "actualResizeMode": "fill",
    "sourceCropsPreserveOriginalPixels": true
  }
}
```

- [x] **Step 4: Audit crops use source-space boxes**

When the actual element is projected, set `actualEl.box` to `projectExpectedBoxToActualSource(expectedEl.box, transform)` in actual source coordinates. The expected crop remains expected source coordinates. Local overlay/mask crops may be created by projecting masks between spaces, but model input expected/actual crops must come from source images.

- [x] **Step 5: Recovery crops use source-space boxes**

Recovery components originate from comparison-space pixel diff. Before cropping source images:

- expected recovery crop: use comparison component box directly in expected source space;
- actual recovery crop: project the component box to actual source space with `projectExpectedBoxToActualSource(...)`;
- overlay/mask crop: use comparison-space component box.

Record `coordinateFrame: "comparison_expected_space"` on recovery trace entries.

- [x] **Step 6: Add tests**

Add tests with expected `1200x2400` and actual `600x1200`:

- projected actual box doubles/halves correctly in source space;
- actual source crop dimensions are not stretched to expected source dimensions;
- comparison-space actual artifact exists only for pixel diff/overlay;
- report image normalization metadata says `sourceCropsPreserveOriginalPixels === true`.

Run:

```powershell
npx vitest run tests/unit/images.test.ts tests/unit/element-map.test.ts tests/e2e/compare-ui-images.test.ts
```

Expected: selected tests pass.

- [x] **Step 7: Verify and commit**

Run:

```powershell
npm run verify
```

Commit and push:

```powershell
git add src/images/normalize.ts src/images/coordinates.ts src/pipeline/run-ui-diff.ts src/locator/element-map.ts src/audit/audit-target.ts src/recovery/target-recovery.ts tests/unit/images.test.ts tests/unit/element-map.test.ts tests/e2e/compare-ui-images.test.ts docs/implementation-status.md
git commit -m "feat(projection): preserve source pixels with coordinate transforms"
git push
```

## Task 4: Honest Projected-Mismatch Diff Records

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/audit/projected-mismatch.ts`
- Modify: `src/audit/audit-target.ts`
- Modify: `src/debug/run-debug.ts`
- Test: `tests/unit/projected-mismatch.test.ts`
- Test: `tests/unit/audit.test.ts`

**Interfaces:**
- Produces `DiffRecord.classificationSource?: "vlm_reviewed" | "deterministic_projected_mismatch" | "target_recovery" | "unclassified" | "deterministic_geometry"`.
- Produces `projectionMismatchReason?: "expected_target_absent_at_projected_location" | "projected_crop_low_overlap" | "projected_crop_high_diff_mass" | "projection_dimension_mismatch"`.

- [x] **Step 1: Add classification source fields**

In `DiffRecordSchema`, add:

```ts
classificationSource: z.enum([
  "vlm_reviewed",
  "deterministic_projected_mismatch",
  "target_recovery",
  "unclassified",
  "deterministic_geometry"
]).optional(),
projectionMismatchReason: z.enum([
  "expected_target_absent_at_projected_location",
  "projected_crop_low_overlap",
  "projected_crop_high_diff_mass",
  "projection_dimension_mismatch"
]).optional()
```

Do not make these required for older reports.

- [x] **Step 2: Rename deterministic projected mismatch semantics**

In `detectProjectedCropMismatch`, map reasons:

- `low_visual_overlap` -> `projected_crop_low_overlap`
- `high_diff_mass` -> `projected_crop_high_diff_mass`
- `text_absent` -> `expected_target_absent_at_projected_location`
- `dimension_mismatch` -> `projection_dimension_mismatch`

- [x] **Step 3: Emit honest records**

In `auditElementPair`, deterministic projected mismatch records must use:

```ts
criterion: "presence",
title: `Expected target absent or mismatched at projected location: ${refEl.label}`,
classificationSource: "deterministic_projected_mismatch",
projectionMismatchReason: mappedReason,
model: "deterministic"
```

Evidence must include:

```text
Projected expected crop did not match the actual source crop at the transformed coordinate.
```

Do not claim exact semantic content such as “wrong icon” or “wrong text” unless VLM/recovery classified it.

- [x] **Step 4: Keep artifacts attached**

Each projected mismatch record must include at least:

- `expected_crop`
- `actual_crop`

If local overlay/mask exists for that pair, attach those as well. Tests must assert artifact roles, not only file paths.

- [x] **Step 5: Add tests**

Tests must assert:

- deterministic projected mismatch uses `criterion: "presence"`;
- `classificationSource === "deterministic_projected_mismatch"`;
- title contains `projected location`;
- evidence does not mention app code/config/root cause;
- debug summary still counts this as accepted deterministic evidence.

Run:

```powershell
npx vitest run tests/unit/projected-mismatch.test.ts tests/unit/audit.test.ts
```

- [x] **Step 6: Verify and commit**

Run:

```powershell
npm run verify
```

Commit and push:

```powershell
git add src/schemas/core.ts src/audit/projected-mismatch.ts src/audit/audit-target.ts src/debug/run-debug.ts tests/unit/projected-mismatch.test.ts tests/unit/audit.test.ts docs/implementation-status.md
git commit -m "feat(audit): label projected crop mismatches honestly"
git push
```

## Task 5: Crop-Grounded Auditor And Reviewer Text

**Files:**
- Modify: `src/audit/prompts.ts`
- Modify: `src/audit/audit-target.ts`
- Modify: `src/audit/review-findings.ts`
- Test: `tests/unit/audit.test.ts`

**Interfaces:**
- Produces prompt section `Evidence Discipline` in auditor and reviewer prompts.
- Produces reviewer rejection for evidence that describes a crop-boundary artifact as an element-level fact without qualification.

- [x] **Step 1: Tighten auditor prompt**

In `buildAuditorPrompt`, add this exact instruction block:

```text
Evidence discipline:
- Describe only visible differences supported by the supplied crops, overlay, mask, and measurements.
- If a crop appears clipped or only partially contains the expected target, say "crop/position mismatch" instead of claiming hidden content.
- Do not infer implementation cause, app code cause, or config cause.
- Do not recommend fixes.
- If the evidence is only a projected-location mismatch, classify it as presence/geometry only when visible evidence supports that label.
```

- [x] **Step 2: Tighten reviewer prompt**

In `buildReviewerPrompt`, add:

```text
Reject the diff if its title or evidence claims content that is not visible in the supplied images.
Accept crop-boundary evidence only when the record explicitly calls it a crop/position mismatch.
```

- [x] **Step 3: Add evidence validation before merge**

In `review-findings.ts`, add a deterministic guard:

```ts
export function hasUnsupportedCropBoundaryClaim(diff: DiffRecord): boolean
```

It returns `true` when evidence contains phrases like `left half`, `right half`, `cut`, or `cropped`, but title/evidence does not include `crop`, `position`, or `projected`.

When true, set `reviewerStatus: "rejected"` before final merge.

- [x] **Step 4: Add tests**

Add tests:

- prompt contains `Evidence discipline`;
- unsupported “left half of text is cut” record is rejected unless it says `crop/position mismatch`;
- accepted record still passes when evidence explicitly says `crop/position mismatch`.

Run:

```powershell
npx vitest run tests/unit/audit.test.ts
```

- [x] **Step 5: Verify and commit**

Run:

```powershell
npm run verify
```

Commit and push:

```powershell
git add src/audit/prompts.ts src/audit/audit-target.ts src/audit/review-findings.ts tests/unit/audit.test.ts docs/implementation-status.md
git commit -m "fix(audit): constrain diff evidence to visible crop facts"
git push
```

## Task 6: Report Contract And Live Gate Assertions

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/report/report-writer.ts`
- Modify: `tests/live/calorix-smoke.live.test.ts`
- Modify: `docs/release/production-readiness-checklist.md`
- Modify: `.env.example`

**Interfaces:**
- Produces report fields:
  ```ts
  providerDiagnosticsPresent: boolean;
  comparisonSpace?: { width: number; height: number; actualResizeMode: "fill"; sourceCropsPreserveOriginalPixels: boolean; };
  ```

> **Implementation note:** `sourceCropsPreserveOriginalPixels` is placed inside `comparisonSpace` (not as a separate top-level boolean) so it is co-located with the space dimensions. Consumers must read `report.comparisonSpace?.sourceCropsPreserveOriginalPixels`.

- [x] **Step 1: Add report booleans**

Add optional report fields:

```ts
providerDiagnosticsPresent: z.boolean().optional(),
comparisonSpace: z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  actualResizeMode: z.literal("fill"),
  sourceCropsPreserveOriginalPixels: z.boolean()
}).optional()
```

- [x] **Step 2: Populate report booleans**

In `run-ui-diff.ts`, set:

```ts
providerDiagnosticsPresent = providerTrace.getEvents().some(e => e.diagnostic !== undefined)
comparisonSpace = { width: expectedImg.width, height: expectedImg.height, actualResizeMode: "fill", sourceCropsPreserveOriginalPixels: true }
```

- [x] **Step 3: Harden diagnostic Calorix gate**

In `verify:calorix-full-live`, assert:

- `report.sourceCropsPreserveOriginalPixels === true`
- `report.providerDiagnosticsPresent === true` when `visualClassificationStatus === "incomplete"`
- `report.recoverySummary` exists when `route_exhausted` for `target_recovery` is present
- every `deterministic_projected_mismatch` diff has `projectionMismatchReason`

- [x] **Step 4: Keep release gate strict**

`verify:calorix-release-live` must still require:

- `visualClassificationStatus === "complete"`
- `auditLimited === false`
- no `unclassified_visual_change` diffs above threshold unless reviewed/classified

If viewport compatibility remains `mismatch`, release may pass only when `sourceCropsPreserveOriginalPixels === true` and all final accepted diffs are either VLM-reviewed/recovered or explicitly projected-location evidence. Add an assertion with that exact predicate.

- [x] **Step 5: Document new environment flags**

Update `.env.example` and checklist with:

```text
UI_DIFF_PROVIDER_DIAGNOSTIC_SNIPPET_CHARS=300
UI_DIFF_MAX_RECOVERY_COMPONENTS=12
UI_DIFF_MAX_RECOVERY_MODEL_CALLS=24
UI_DIFF_RECOVERY_BUDGET_MS=120000
```

- [x] **Step 6: Verify and commit**

Run:

```powershell
npm run verify
```

Commit and push:

```powershell
git add src/schemas/core.ts src/report/report-writer.ts src/pipeline/run-ui-diff.ts tests/live/calorix-smoke.live.test.ts docs/release/production-readiness-checklist.md .env.example docs/implementation-status.md
git commit -m "feat(report): expose diagnostics and source-crop projection contract"
git push
```

## Task 7: Fresh Live Validation And Release Decision

**Files:**
- Modify: `docs/release/production-readiness-checklist.md`
- Modify: `docs/implementation-status.md`
- Create or Modify: `docs/release/2026-06-18-model-diagnostics-recovery-projection-report.md`

**Interfaces:**
- Produces a committed release-readiness report that records exact run IDs, exact selected model routes, target-recovery route outcomes, viewport/projection metadata, and final diff quality.

- [x] **Step 1: Run deterministic verification**

Run:

```powershell
npm run verify
npm run test:coverage
```

Expected: both pass or the report records the exact failure.

- [x] **Step 2: Run provider live probes**

Run:

```powershell
$env:RUN_NVIDIA_LIVE="1"
npm run verify:nvidia-live
$env:RUN_OPENROUTER_FREE_LIVE="1"
npm run verify:openrouter-free-live
```

Expected: results are recorded with pass/fail counts and model IDs.

- [x] **Step 3: Run Calorix diagnostic gates** *(bounded diagnostic ran on 2026-06-20 as `run-1781962032076-14decb`; result is not release evidence because `auditLimited:true`, `visualClassificationStatus:"incomplete"`, and projected dimension-only mismatch consumed all 3 VLM audit slots)*

Run with:

```powershell
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-17-adb-seeded-2.png"
$env:LOCATEANYTHING_EAGLE_EMBODIED_DIR="C:\Users\xursc\projects\Eagle\Embodied"
$env:RUN_CALORIX_UI_DIFF_LIVE="1"
npm run verify:calorix-live
$env:RUN_CALORIX_FULL_LIVE="1"
npm run verify:calorix-full-live
```

Record:

- run IDs
- `visualClassificationStatus`
- `viewportCompatibilityStatus`
- `sourceCropsPreserveOriginalPixels`
- selected auditor/reviewer/target-recovery routes
- count of provider diagnostic events by provider/model/kind
- final diff count by `classificationSource`
- count of unclassified diffs

- [ ] **Step 4: Run release gate** *(not yet run successfully after projection pre-audit hardening)*

Run:

```powershell
$env:RUN_CALORIX_RELEASE_LIVE="1"
npm run verify:calorix-release-live
```

Expected: either pass and mark release-ready, or fail and keep production blocked with exact failing predicate.

- [x] **Step 5: Write release-readiness report**

Create `docs/release/2026-06-18-model-diagnostics-recovery-projection-report.md` with:

```markdown
# Model Diagnostics, Recovery Routing, And Projection Hardening Report

## Verdict

- Production status: READY or BLOCKED
- Blocking predicate: exact predicate or "none"

## Runs

| Gate | Run ID | Result | Notes |
| --- | --- | --- | --- |

## Provider Diagnostics

| Phase | Provider | Model | Diagnostic kind | Count |
| --- | --- | --- | --- | --- |

## Final Diff Quality

| Classification source | Count |
| --- | --- |

## Remaining Work

- Only concrete blockers observed in the fresh run.
```

- [x] **Step 6: Commit and push**

Run:

```powershell
git diff --check
git status --short
```

Commit and push:

```powershell
git add docs/release/2026-06-18-model-diagnostics-recovery-projection-report.md docs/release/production-readiness-checklist.md docs/implementation-status.md
git commit -m "docs(release): record projection and recovery hardening validation"
git push
```

## Acceptance Checks

- Invalid JSON failures are diagnosable from structured provider-trace diagnostics without storing full raw provider bodies.
- Target recovery candidates include strong auditor/reviewer VLM routes that pass the 4-image recovery probe.
- Source expected/actual crop artifacts preserve original normalized pixels; only comparison-space artifacts may use resizing.
- Projected-crop mismatch records are labeled as projected-location evidence and do not overclaim semantic UI differences.
- Reviewer/auditor text is grounded in visible crops and rejects unsupported crop-boundary claims.
- A fresh Calorix full diagnostic run records `recoverySummary` whenever target recovery is skipped or exhausted.
- Production release remains blocked unless `verify:calorix-release-live` passes the strict release predicates.

## Self-Review

- Spec coverage: The plan covers provider failure diagnostics, target recovery routing, non-stretch projection, projected mismatch naming, model-reviewed diff quality, fresh recovery-summary validation, and production gate status.
- Placeholder scan: No unresolved implementation placeholders remain.
- Type consistency: `ProviderFailureDiagnostic`, `ImagePairTransform`, `classificationSource`, and `projectionMismatchReason` are named once and reused consistently.

## External Review

Legacy Gemini CLI review attempts:

- Tool status: deprecated for new reviews. Use `mcp__antigravity_mcp__ask_gemini` instead.

Gemini 3.1 Pro Preview review attempt through the legacy Gemini CLI:

- Result: blocked by local Gemini CLI authentication.
- Error class: `IneligibleTierError`.
- Reason text: `This client is no longer supported for Gemini Code Assist for individuals.`
- Review status: not completed.

Gemini 3 Pro Preview fallback attempt through the legacy Gemini CLI:

- Result: blocked by the same local Gemini CLI authentication error.
- Error class: `IneligibleTierError`.
- Review status: not completed.

Antigravity/`agy` replacement attempt:

- `agy` location: `C:\Users\xursc\AppData\Local\agy\bin\agy.exe`.
- `agy --help`: succeeded.
- `agy --print`: exited 0 but emitted empty stdout for both a plan-review prompt and a trivial `AGY_OK` prompt from the non-TTY Codex subprocess.
- Upstream issue: `https://github.com/google-antigravity/antigravity-cli/issues/76` documents the same non-TTY `--print` stdout loss.
- Review status: not completed. Empty stdout must be treated as a tooling failure, not as an approving review.

No external feedback was incorporated because no Gemini-family review completed. The plan was self-reviewed against the requested scope and is committed for human review with this blocker recorded explicitly. Any new review must use `mcp__antigravity_mcp__ask_gemini`; the obsolete CLI limitation does not apply to the MCP tool.
