# Viewport Projection Capture Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop silent viewport distortion and low-signal projected audits, make screenshot/crop provenance explicit, and split diagnostic live gates from production sign-off gates.

**Architecture:** Keep expected-first projection as the default product path, but make the projection transform measurable and visible in every report. Treat viewport/device mismatch as a first-class run condition, validate screenshots before they enter the pipeline, and add deterministic projected-region mismatch detection before spending VLM calls. Diagnostic gates may accept incomplete-with-trace; production gates must require full classification.

**Tech Stack:** Node.js 22+, TypeScript ESM, Sharp, PNGJS/pixelmatch, Zod, Vitest, MCP TypeScript SDK, ADB screenshot capture, existing NVIDIA/OpenRouter model adapters.

## Global Constraints

- Do not introduce user-authored target maps, ROI maps, ignore masks, anchor dumps, causality explanations, app-edit recommendations, or MCP-edit recommendations.
- Default product mode remains expected-first projection: compare actual against mockup coordinates because actual should become expected.
- Do not silently use paid routes. Paid mode remains explicit and guarded by `UI_DIFF_ENABLE_PAID_MODE=1`.
- Every report must name exact provider/model/route for model-produced diffs.
- Production sign-off is blocked whenever `visualClassificationStatus !== "complete"`.
- After repository changes, commit and push to `origin`.
- Calorix seeded actual screenshot currently available at `C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-17-adb-seeded-2.png`.

---

## Triggering Evidence

- The expected mockup is `1206x2622`; the Android ADB screenshot is `1080x2400`.
- `loadNormalizedImage(..., targetSize)` currently uses Sharp `fit: "fill"`, stretching actual X by `1.1167` and Y by `1.0925` to match the mockup. That does not crop, but it does distort and hides the fact that the source viewport differs.
- Projection currently copies expected boxes directly to normalized actual coordinates. This is correct for "actual should become expected," but device/status/nav mismatch makes some projected crops land on unrelated content.
- Latest inspected full Calorix run `run-1781700452017-60ff0a` audited all 79 pairs but ended `visualClassificationStatus: "incomplete"` with 706 diffs, 11 model-reviewed diffs, 695 unclassified changes, 62 audit errors, and recovery deadline exhaustion.
- Some projected target crops are obvious structural misses: expected target content is absent or at the wrong screen coordinate. These should become deterministic presence/geometry diffs instead of expensive criterion audits.
- The first post-reseed ADB capture returned an all-black screenshot even though dimensions were valid. Capture validation must reject this before it becomes a diff input.

## File Structure

- Modify `src/images/normalize.ts`: return normalization/source-size metadata and stop hiding resize distortion.
- Create `src/images/viewport.ts`: compute aspect/dimension compatibility and normalization transform diagnostics.
- Modify `src/schemas/core.ts`: add `imageNormalization`, `viewportCompatibilityStatus`, and projected-crop diagnostics to the report schema.
- Modify `src/pipeline/run-ui-diff.ts`: attach normalization metadata, warnings, viewport status, and projection metadata to reports/checkpoints.
- Modify `src/locator/element-map.ts`: return projected elements with explicit projection metadata.
- Create `src/audit/projected-mismatch.ts`: deterministic pre-audit check for projected crops whose actual region does not contain the expected target.
- Modify `src/audit/audit-target.ts`: run projected mismatch before VLM audit and trace skipped model calls.
- Modify `src/report/coverage.ts`: treat deterministic projected-mismatch diffs as covering their local pixel components.
- Modify `src/capture/mobile-capture.ts`: write ADB `exec-out screencap -p` directly, validate the image is nonblank, and return capture metadata.
- Modify `src/schemas/tool-schemas.ts` and `src/server.ts`: expose capture validation output in structured MCP responses.
- Modify `tests/unit/images.test.ts`, `tests/unit/element-map.test.ts`, `tests/unit/audit.test.ts`, `tests/unit/mobile-capture.test.ts`, `tests/e2e/compare-ui-images.test.ts`, and `tests/live/calorix-smoke.live.test.ts`.
- Modify `docs/release/production-readiness-checklist.md`, `README.md`, and `docs/implementation-status.md`.

---

## Task 1: Image Normalization Metadata And Viewport Compatibility

**Files:**
- Modify: `src/images/normalize.ts`
- Create: `src/images/viewport.ts`
- Modify: `src/schemas/core.ts`
- Test: `tests/unit/images.test.ts`
- Test: `tests/unit/schemas.test.ts`

**Interfaces:**
- Produces `ImageNormalizationMetadata`:
  ```ts
  export interface ImageNormalizationMetadata {
    source: { width: number; height: number; aspectRatio: number };
    normalized: { width: number; height: number; aspectRatio: number };
    resizeMode: "none" | "fill";
    scaleX: number;
    scaleY: number;
    aspectRatioDeltaPercent: number;
    anisotropicScaleDeltaPercent: number;
  }
  ```
- Produces `computeViewportCompatibility(expected, actual): { status, reasons }`.

- [ ] **Step 1: Add failing tests for non-square resize distortion**

Add tests that normalize a `1080x2400` fixture to `1206x2622` and assert:

```ts
expect(result.metadata.resizeMode).toBe("fill");
expect(result.metadata.scaleX).toBeCloseTo(1206 / 1080, 4);
expect(result.metadata.scaleY).toBeCloseTo(2622 / 2400, 4);
expect(result.metadata.anisotropicScaleDeltaPercent).toBeGreaterThan(2);
```

Run:

```powershell
npx vitest run tests/unit/images.test.ts
```

Expected: fail because `metadata` does not exist.

- [ ] **Step 2: Implement metadata in `loadNormalizedImage`**

Change `NormalizedImage` to include `metadata: ImageNormalizationMetadata`. Read source metadata before resize, calculate source/normalized aspect ratios, `scaleX`, `scaleY`, `aspectRatioDeltaPercent`, and `anisotropicScaleDeltaPercent`.

- [ ] **Step 3: Add viewport helper**

Create `src/images/viewport.ts`:

```ts
export type ViewportCompatibilityStatus = "compatible" | "mismatch";

export function computeViewportCompatibility(
  expected: ImageNormalizationMetadata,
  actual: ImageNormalizationMetadata
): { status: ViewportCompatibilityStatus; reasons: string[] } {
  const reasons: string[] = [];
  if (actual.resizeMode === "fill" && actual.anisotropicScaleDeltaPercent > 1.5) {
    reasons.push(`actual image was anisotropically scaled by ${actual.anisotropicScaleDeltaPercent.toFixed(2)}%`);
  }
  if (actual.aspectRatioDeltaPercent > 1.5) {
    reasons.push(`actual source aspect ratio differs from expected by ${actual.aspectRatioDeltaPercent.toFixed(2)}%`);
  }
  return { status: reasons.length > 0 ? "mismatch" : "compatible", reasons };
}
```

- [ ] **Step 4: Extend schemas**

Add `ImageNormalizationMetadataSchema` and `ViewportCompatibilityStatusSchema` to `src/schemas/core.ts`. Add optional report fields:

```ts
imageNormalization: z.object({
  expected: ImageNormalizationMetadataSchema,
  actual: ImageNormalizationMetadataSchema
}).optional(),
viewportCompatibilityStatus: z.enum(["compatible", "mismatch"]).optional(),
viewportCompatibilityReasons: z.array(z.string()).default([])
```

- [ ] **Step 5: Verify**

Run:

```powershell
npx vitest run tests/unit/images.test.ts tests/unit/schemas.test.ts
npm run typecheck
```

Expected: tests and typecheck pass.

## Task 2: Report Viewport Mismatch And Normalize Projection Warnings

**Files:**
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/report/report-writer.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`
- Test: `tests/unit/report.test.ts`

**Interfaces:**
- Consumes `computeViewportCompatibility`.
- Produces report fields from Task 1.
- Adds warning string prefix `[viewport-mismatch]`.

- [ ] **Step 1: Write failing e2e assertion**

Update e2e fixture to use mismatched source dimensions. Assert:

```ts
expect(report.viewportCompatibilityStatus).toBe("mismatch");
expect(report.viewportCompatibilityReasons.length).toBeGreaterThan(0);
expect(report.warnings.some(w => w.startsWith("[viewport-mismatch]"))).toBe(true);
```

Run:

```powershell
npx vitest run tests/e2e/compare-ui-images.test.ts
```

Expected: fail because report fields are absent.

- [ ] **Step 2: Wire metadata into pipeline**

After expected/actual normalization, compute viewport compatibility. Append a warning:

```ts
warnings.push(`[viewport-mismatch] ${viewport.reasons.join("; ")}`);
```

Only append when `status === "mismatch"`.

- [ ] **Step 3: Include fields in checkpoints and final report**

Every `writeReportCheckpoint` and final `UiDiffReport` must include:

```ts
imageNormalization: { expected: expectedImg.metadata, actual: actualImg.metadata },
viewportCompatibilityStatus: viewport.status,
viewportCompatibilityReasons: viewport.reasons
```

- [ ] **Step 4: Verify**

Run:

```powershell
npx vitest run tests/e2e/compare-ui-images.test.ts tests/unit/report.test.ts
npm run typecheck
```

Expected: pass.

## Task 3: Explicit Projection Metadata

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/locator/element-map.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Test: `tests/unit/element-map.test.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`

**Interfaces:**
- Add `ProjectionMetadataSchema`:
  ```ts
  {
    mode: "expected_coordinate_projection",
    coordinateSpace: "normalized_expected_image",
    sourceElementId: string,
    normalizedActualScaleX: number,
    normalizedActualScaleY: number
  }
  ```
- Add optional `projectionMetadata` to projected `UiElement`.

- [ ] **Step 1: Write failing projection metadata test**

Assert `projectElementsToActual([expected], imageSize, transform)` returns an actual element with:

```ts
expect(projected.source).toBe("projected");
expect(projected.projectionMetadata?.sourceElementId).toBe(expected.id);
expect(projected.projectionMetadata?.coordinateSpace).toBe("normalized_expected_image");
```

- [ ] **Step 2: Extend schemas and implementation**

Update `UiElementSchema` with optional `projectionMetadata`. Change `projectElementsToActual` signature:

```ts
projectElementsToActual(
  expectedElements: UiElement[],
  actualImageSize: { width: number; height: number },
  projection: { normalizedActualScaleX: number; normalizedActualScaleY: number }
): UiElement[]
```

- [ ] **Step 3: Pass transform from pipeline**

Call with:

```ts
projectElementsToActual(expectedElements, { width: actualImg.width, height: actualImg.height }, {
  normalizedActualScaleX: actualImg.metadata.scaleX,
  normalizedActualScaleY: actualImg.metadata.scaleY
})
```

- [ ] **Step 4: Verify**

Run:

```powershell
npx vitest run tests/unit/element-map.test.ts tests/e2e/compare-ui-images.test.ts
npm run typecheck
```

Expected: pass.

## Task 4: Deterministic Projected Crop Mismatch Short-Circuit

**Files:**
- Create: `src/audit/projected-mismatch.ts`
- Modify: `src/audit/audit-target.ts`
- Modify: `src/audit/criteria.ts`
- Modify: `src/schemas/core.ts`
- Test: `tests/unit/audit.test.ts`
- Test: `tests/unit/projected-mismatch.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProjectedMismatchResult {
    mismatched: boolean;
    reason: "low_visual_overlap" | "high_diff_mass" | "text_absent";
    changedPercent: number;
    expectedDominant: string;
    actualDominant: string;
  }
  ```
- Emits a `presence` or `geometry` `DiffRecord` with `model: "deterministic"` and `reviewerStatus: "accepted"`.

- [ ] **Step 1: Add tests for obvious mismatch**

Create a fixture where expected crop is a blue icon/text region and actual crop is a flat black/nav region. Assert:

```ts
expect(result.mismatched).toBe(true);
expect(result.reason).toBe("low_visual_overlap");
```

- [ ] **Step 2: Add tests for normal color-only difference**

Create a fixture where expected and actual have same shape but different fill. Assert `mismatched === false` so normal color audit still runs.

- [ ] **Step 3: Implement `detectProjectedCropMismatch`**

Use existing crop pixel diff plus simple features:
- changedPercent over 70,
- edge overlap below 15,
- dominant-palette intersection below 10,
- optional OCR/text label absence when `expectedEl.text` is set.

Return mismatch only when at least two signals agree, so ordinary color tweaks are not mislabeled as missing.

- [ ] **Step 4: Wire into `auditElementPair` before VLM calls**

If `actualEl.source === "projected"` and mismatch is true:
- write the same expected/actual/local overlay/mask artifacts,
- create deterministic diff:
  - `criterion: "presence"` when text/visual target is absent,
  - `criterion: "geometry"` when target appears structurally shifted outside the projected crop,
- push audit trace status `deterministic_projected_mismatch`,
- skip auditor/reviewer model calls for that criterion.

- [ ] **Step 5: Extend trace schema**

Add `deterministic_projected_mismatch` to `AuditCriterionTraceSchema.status`.

- [ ] **Step 6: Verify**

Run:

```powershell
npx vitest run tests/unit/projected-mismatch.test.ts tests/unit/audit.test.ts
npm run typecheck
```

Expected: pass.

## Task 5: Capture Validation And Nonblank ADB Screenshot Path

**Files:**
- Modify: `src/capture/mobile-capture.ts`
- Modify: `src/schemas/tool-schemas.ts`
- Modify: `src/server.ts`
- Test: `tests/unit/mobile-capture.test.ts`
- Test: `tests/unit/tools.test.ts`

**Interfaces:**
- Replace string-only capture result internally with:
  ```ts
  export interface CaptureResult {
    path: string;
    width: number;
    height: number;
    blankPixelRatio: number;
    validationStatus: "pass" | "failed";
    warnings: string[];
  }
  ```

- [ ] **Step 1: Add failing test for all-black screenshot**

Mock a valid `1080x2400` black PNG. Assert `captureMobileScreen("adb")` rejects with:

```text
captured screenshot failed validation: blankPixelRatio
```

- [ ] **Step 2: Write ADB exec-out buffer directly**

Use:

```ts
const { stdout } = await execFileAsync("adb", ["exec-out", "screencap", "-p"], {
  encoding: "buffer",
  timeout: 30000,
  maxBuffer: 20 * 1024 * 1024
});
await fs.writeFile(outPath, stdout as Buffer);
```

Remove the redundant `adb shell screencap` + `adb pull` path unless direct exec-out fails.

- [ ] **Step 3: Validate captured image**

Use Sharp to read raw pixels. Reject when:
- width or height is zero,
- more than 98% of pixels are near black (`r < 4 && g < 4 && b < 4`),
- PNG parse fails.

- [ ] **Step 4: Preserve MCP output compatibility**

Keep existing tool response path field, but add structured capture metadata:

```ts
capture: {
  width,
  height,
  blankPixelRatio,
  validationStatus,
  warnings
}
```

- [ ] **Step 5: Verify**

Run:

```powershell
npx vitest run tests/unit/mobile-capture.test.ts tests/unit/tools.test.ts
npm run typecheck
```

Expected: pass.

## Task 6: Calorix Live Gate Uses Seeded Screenshot And Separates Diagnostic From Release

**Files:**
- Modify: `tests/live/calorix-smoke.live.test.ts`
- Modify: `package.json`
- Modify: `docs/release/production-readiness-checklist.md`
- Modify: `README.md`

**Interfaces:**
- Existing `verify:calorix-live` remains diagnostic and may pass degraded.
- New `verify:calorix-release-live` requires:
  - seeded actual screenshot path exists,
  - `viewportCompatibilityStatus === "compatible"` or release gate explicitly fails with `viewport_mismatch`,
  - `visualClassificationStatus === "complete"`,
  - `auditLimited === false`.

- [ ] **Step 1: Add package script**

Add:

```json
"verify:calorix-release-live": "node scripts/require-live-env.js RUN_CALORIX_RELEASE_LIVE && npm run build && vitest run tests/live/calorix-smoke.live.test.ts --testTimeout 2400000"
```

- [ ] **Step 2: Split live test blocks**

Add a third `describe.skipIf(process.env["RUN_CALORIX_RELEASE_LIVE"] !== "1")` block. It should use the same project paths but assert production sign-off semantics.

- [ ] **Step 3: Add seeded screenshot default note**

Docs must name the current seeded screenshot path:

```text
C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-17-adb-seeded-2.png
```

Do not hardcode it in the MCP runtime; only tests/docs use it as this machine's known release input.

- [ ] **Step 4: Verify live-test shape without running models**

Run:

```powershell
npm run typecheck
npx vitest run tests/unit/tools.test.ts
```

Expected: pass.

## Task 7: Reduce Unclassified Recovery Load Before Model Calls

**Files:**
- Modify: `src/report/coverage.ts`
- Create: `src/report/component-clustering.ts`
- Modify: `src/recovery/target-recovery.ts`
- Test: `tests/unit/coverage.test.ts`
- Test: `tests/unit/target-recovery.test.ts`

**Interfaces:**
- Produces `clusterUncoveredComponents(components, options)`:
  ```ts
  export function clusterUncoveredComponents(
    components: PixelComponent[],
    options: { maxGapPx: number; maxClusterAreaRatio: number }
  ): PixelComponent[]
  ```

- [ ] **Step 1: Add failing clustering test**

Given 30 tiny adjacent components inside the bottom nav area, assert clustering returns fewer than 5 components while preserving total pixel count.

- [ ] **Step 2: Implement spatial clustering**

Merge components when expanded boxes intersect with `maxGapPx = 8` and resulting cluster area is less than `maxClusterAreaRatio = 0.35` of the screen. Do not merge across large screen-spanning regions.

- [ ] **Step 3: Apply before target recovery**

In `run-ui-diff.ts`, run clustering after `uncoveredComponents` and before `runTargetRecovery`. Record both counts in `recoverySummary`:

```ts
preClusterUncoveredComponents
postClusterUncoveredComponents
```

- [ ] **Step 4: Verify**

Run:

```powershell
npx vitest run tests/unit/coverage.test.ts tests/unit/target-recovery.test.ts
npm run typecheck
```

Expected: pass.

## Task 8: Final Verification And Documentation

**Files:**
- Modify: `docs/implementation-status.md`
- Optionally create: `docs/release/2026-06-17-viewport-projection-readiness.md`

- [ ] **Step 1: Run deterministic verification**

Run:

```powershell
npm run verify
npm run test:coverage
```

Expected: both pass; coverage remains above configured thresholds.

- [ ] **Step 2: Run diagnostic live gate**

Run with seeded Calorix actual screenshot:

```powershell
$env:RUN_CALORIX_FULL_LIVE="1"
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-17-adb-seeded-2.png"
npm run verify:calorix-full-live
```

Expected: diagnostic gate records viewport status, normalization metadata, projection metadata, provider trace, and debug traces.

- [ ] **Step 3: Run release live gate**

Run:

```powershell
$env:RUN_CALORIX_RELEASE_LIVE="1"
npm run verify:calorix-release-live
```

Expected today: fail if viewport mismatch or incomplete classification remains. That failure is acceptable and must be recorded as the production blocker.

- [ ] **Step 4: Update status and commit**

Update `docs/implementation-status.md` with:
- deterministic verification result,
- diagnostic Calorix result,
- release Calorix result,
- next blocker if release still fails.

Commit and push:

```powershell
git add .
git commit -m "feat: harden viewport projection and capture diagnostics"
git push
```

---

## Acceptance Criteria

- Reports expose source and normalized dimensions, resize mode, scale factors, aspect delta, and viewport compatibility.
- `fit: "fill"` distortion is never silent; mismatched viewport runs contain a report warning and structured metadata.
- Projected actual elements record their coordinate-space and source element relationship.
- Obvious projected crop misses become deterministic `presence` or `geometry` diffs and skip VLM calls.
- ADB capture rejects all-black screenshots before producing a usable capture path.
- Diagnostic Calorix gates and production-release Calorix gates are separate.
- Production release remains blocked unless `visualClassificationStatus === "complete"`.
- Recovery receives clustered uncovered components instead of hundreds of tiny duplicate regions.
- No user-authored target maps, ROI maps, ignore masks, or anchor dumps are introduced.

## Self-Review

- Spec coverage: The plan addresses the current blockers we observed: silent image stretch, viewport mismatch, projected crop false audits, invalid black captures, ambiguous diagnostic pass semantics, and recovery overload.
- Placeholder scan: No forbidden placeholder language remains.
- Type consistency: New interfaces are named once and reused by later tasks. `ImageNormalizationMetadata`, `ProjectionMetadata`, `CaptureResult`, and `clusterUncoveredComponents` are the cross-task contracts.

## Gemini Review

Gemini 3 Pro Preview review on 2026-06-17:

- Command: `gemini -m gemini-3-pro-preview --approval-mode plan --skip-trust --output-format text -p "..."`
- `AGREEMENT_STATUS: agree`
- `MUST_FIX: none`
- `SHOULD_FIX: none`
- `RATIONALE: The plan rigorously adheres to all global constraints, including maintaining expected-first projection, blocking production release on incomplete classification, and avoiding manual masks or maps. The additions of deterministic crop mismatch and unclassified region clustering effectively reduce reliance on VLM calls, fulfilling the free-first model policy.`
