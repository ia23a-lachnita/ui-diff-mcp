# Locator Resolution And Readable Overlays Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the under-evidenced `LOCATEANYTHING_MAX_DIMENSION=600` release workaround with measured locator-resolution evidence, self-explanatory locator sizing metadata, and readable full-screen/zoom diff overlays.

**Architecture:** Keep the current single-pass projection pipeline by default, but make locator input sizing observable and benchmarkable before changing locator strategy. Improve human-facing artifacts by drawing grouped, low-alpha outlines and dynamic zoom panels around actual finding clusters instead of flooding the whole screen with filled green boxes.

**Tech Stack:** TypeScript ESM, Sharp SVG compositing, existing LocateAnything sidecar client, existing report/run artifact schemas, Vitest.

## Global Constraints

- Do not introduce user-authored ROI maps, target maps, ignore masks, anchor dumps, or manual locator configs.
- Do not silently bless `600` as production-quality locator resolution; every report must state the locator input size used.
- Run locator benchmark trials sequentially so timing is not distorted by local sidecar CPU/GPU contention.
- Preserve existing artifact roles/filenames for compatibility, but render them with readable low-alpha styling.
- Use Antigravity MCP review before implementation and after implementation.
- Commit and push after each meaningful stage.

---

## Current Evidence

- Latest strict Calorix run: `run-1783084174682-0600d2`.
- It passed with `LOCATEANYTHING_MAX_DIMENSION=600`, after default `1200` exceeded the 10-minute locator budget on this machine.
- `600` means the sidecar sees a longest side of 600px:
  - expected mockup `1206x2622` -> about `276x600`
  - actual screenshot `1080x2400` -> about `270x600`
- The same run used single-pass projection: `target-map-actual.json` has `elementsSource: "projected"`. Therefore `600` affected expected target discovery most strongly; actual target discovery was not independently proven at `600`.
- Current `final-diff-regions-overlay.png` is not human-readable because filled green rectangles cover most of the tall screen and labels are fixed at `10px`.

## External Review

Antigravity MCP conversation: `ui-diff-locator-resolution-readable-overlays-2026-07-03`

Round 1:

- `AGREEMENT_STATUS: agree`
- MUST_FIX incorporated:
  - Dynamic overlay font/stroke scaling instead of hardcoded `10px` text and `3px` strokes.
  - Dynamic findings-based zoom panels, not only static header/content/nav crops.
  - Sequential locator benchmark trials.
- SHOULD_FIX incorporated:
  - Defer adaptive high-res locator implementation until benchmark evidence shows whether `900` is insufficient.
  - If adaptive locating is later needed, cap regional crop count and prioritize high-res regional coordinates during NMS.

## File Structure

- Modify `scripts/benchmark-locator-lanes.ts`: accept resolution list, run sequential trials, write Markdown and JSON evidence.
- Modify `src/locator/locateanything-client.ts`: expose sent image sizing metadata from `maxDimension` resizing.
- Modify `src/pipeline/run-ui-diff.ts`: record locator sizing/mode metadata in reports and target-map artifacts.
- Modify `src/schemas/core.ts`: add locator sizing metadata schema.
- Modify `src/report/context-overlays.ts`: grouped readable overlays, dynamic font/stroke scaling, zoom panel generation, legend JSON.
- Modify `tests/unit/locateanything-client.test.ts`: assert locator sent-size metadata.
- Modify `tests/unit/schemas.test.ts`: assert locator metadata schema accepts report-shaped values.
- Modify `tests/unit/context-overlays.test.ts`: assert grouped overlays/zoom panels/legend exist and use readable constraints.
- Modify `README.md`: clarify `600` as local timeout workaround, not quality default.
- Modify `docs/research/locator-lane-benchmark.md`: explain new benchmark output shape.
- Modify `docs/implementation-status.md`: track task state and verification.

---

## Task 1: Locator Resolution Benchmark

**Files:**
- Modify: `scripts/benchmark-locator-lanes.ts`
- Modify: `docs/research/locator-lane-benchmark.md`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Consumes: `locateUiElements({ maxDimension })`, `buildElementMap()`, `computeImageLocatorCoverage()`.
- Produces: `docs/research/locator-lane-benchmark.md` and `docs/research/locator-lane-benchmark.json` with per-dimension timing and quality evidence.

- [x] **Step 1: Add dimension parsing testable helper**

Add a helper in `scripts/benchmark-locator-lanes.ts`:

```ts
export function parseBenchmarkDimensions(value: string | undefined): number[] {
  const raw = value?.trim() ? value : "600,900,1200";
  const dims = raw.split(",")
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(dim => Number.isFinite(dim) && dim >= 200 && dim <= 2400);
  return [...new Set(dims)].sort((a, b) => a - b);
}
```

- [x] **Step 2: Run trials sequentially**

Replace the single `Promise.all` benchmark call with a `for...of` loop over parsed dimensions. For each dimension, run expected then actual sequentially, record:

```ts
{
  maxDimension,
  expected: {
    elapsedMs,
    imageWidth,
    imageHeight,
    usefulElementCount,
    queryCoverageRatio,
    queryCounts,
    laneMetadata,
    elements: [{ id, label, type, queryId, box }]
  },
  actual: {
    elapsedMs,
    imageWidth,
    imageHeight,
    usefulElementCount,
    queryCoverageRatio,
    queryCounts,
    laneMetadata,
    elements: [{ id, label, type, queryId, box }]
  }
}
```

- [x] **Step 3: Add stability comparison**

Use the largest completed dimension as reference. For each smaller dimension, compare element labels/types/query IDs against the reference and write counts:

```ts
{
  comparedTo: 1200,
  expectedMissingLabels: string[],
  actualMissingLabels: string[],
  expectedExtraLabels: string[],
  actualExtraLabels: string[]
}
```

- [x] **Step 4: Write Markdown plus JSON**

Write `docs/research/locator-lane-benchmark.json` with the full structured result. Write `docs/research/locator-lane-benchmark.md` with:

- command/env used,
- sequential-trial warning,
- per-dimension elapsed times,
- expected/actual useful counts,
- query coverage,
- stability summary,
- explicit conclusion field left as `needs_live_data` until the benchmark is run.

- [x] **Step 5: Verify and commit**

Run:

```powershell
npx tsc -p tsconfig.json --noEmit
```

Commit:

```powershell
git add scripts/benchmark-locator-lanes.ts docs/research/locator-lane-benchmark.md docs/implementation-status.md
git commit -m "chore: benchmark locator resolutions"
git push
```

## Task 2: Locator Sizing Metadata In Reports

**Files:**
- Modify: `src/schemas/core.ts`
- Modify: `src/locator/locateanything-client.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `tests/unit/locateanything-client.test.ts`
- Modify: `tests/unit/schemas.test.ts`
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Produces: `UiDiffReport.locatorInputSizing` and `target-map-*.json.locatorInputSizing`.

- [x] **Step 1: Add schema**

Add:

```ts
export const LocatorImageSizingSchema = z.object({
  imageRole: z.enum(["expected", "actual"]),
  maxDimension: z.number().int().positive(),
  originalWidth: z.number().int().positive(),
  originalHeight: z.number().int().positive(),
  sentWidth: z.number().int().positive(),
  sentHeight: z.number().int().positive(),
  scale: z.number().positive(),
  resized: z.boolean()
});

export const LocatorInputSizingSchema = z.object({
  mode: z.enum(["single_pass_projected_actual", "dual_locator"]),
  expected: LocatorImageSizingSchema.optional(),
  actual: LocatorImageSizingSchema.optional(),
  warning: z.string().optional()
});
```

Wire `locatorInputSizing: LocatorInputSizingSchema.optional()` into `UiDiffReportSchema`.

- [x] **Step 2: Return sizing from locator client**

Extend `LocateAnythingResponse` with optional local-only `requestSizing`:

```ts
requestSizing?: {
  maxDimension: number;
  originalWidth: number;
  originalHeight: number;
  sentWidth: number;
  sentHeight: number;
  scale: number;
  resized: boolean;
}
```

Compute it in `withImagePayload()` when `imagePath` is used. Tests must assert a `400x800` image with `maxDimension=200` sends `100x200`, scale `0.25`, and still rescales boxes back to original coordinates.

- [x] **Step 3: Write report metadata**

In `run-ui-diff.ts`, capture expected and actual request sizing and write:

```ts
locatorInputSizing: {
  mode: dualLocatorEnabled ? "dual_locator" : "single_pass_projected_actual",
  expected: expResp.requestSizing ? { imageRole: "expected", ...expResp.requestSizing } : undefined,
  actual: dualLocatorEnabled && actResp.requestSizing ? { imageRole: "actual", ...actResp.requestSizing } : undefined,
  warning: locatorMaxDimension < 900
    ? "Low locator max dimension can hide small UI targets; use benchmark evidence before production sign-off."
    : undefined
}
```

- [x] **Step 4: Verify and commit**

Run:

```powershell
npx vitest run tests/unit/locateanything-client.test.ts tests/unit/schemas.test.ts
```

Commit:

```powershell
git add src/schemas/core.ts src/locator/locateanything-client.ts src/pipeline/run-ui-diff.ts tests/unit/locateanything-client.test.ts tests/unit/schemas.test.ts docs/implementation-status.md
git commit -m "feat: record locator input sizing"
git push
```

## Task 3: Readable Grouped Context Overlays

**Files:**
- Modify: `src/report/context-overlays.ts`
- Modify: `tests/unit/context-overlays.test.ts`
- Modify: `src/schemas/core.ts` if new artifact roles are needed.
- Modify: `docs/implementation-status.md`

**Interfaces:**
- Produces existing artifacts:
  - `final-diff-regions-overlay.png`
  - `unresolved-regions-overlay.png`
  - `region-context-overlay.png`
- Produces new artifacts:
  - `final-diff-groups-overlay.png`
  - `final-diff-groups-legend.json`
  - `final-diff-zoom-001.png`, etc.

- [ ] **Step 1: Add grouping helper**

Group diffs by overlapping locations and nearby parent-scale boxes:

```ts
interface FindingGroup {
  id: string;
  box: Box;
  diffIds: string[];
  criteria: string[];
  severity: "low" | "medium" | "high";
  label: string;
}
```

Use IoU/containment/nearby-center rules already available in `src/signals/geometry.ts`; do not create one group per criterion when the boxes substantially overlap.

- [ ] **Step 2: Dynamic overlay styling**

Replace fixed `font-size="10"` and `stroke-width="3"` with image-relative values:

```ts
const minSide = Math.min(width, height);
const fontSize = Math.max(18, Math.round(minSide * 0.018));
const strokeWidth = Math.max(3, Math.round(minSide * 0.004));
const labelHeight = Math.round(fontSize * 1.45);
```

Use transparent fills no stronger than `0.06` for diff groups and avoid full-screen green flooding.

- [ ] **Step 3: Draw grouped overview**

`final-diff-regions-overlay.png` remains compatible but must draw grouped low-alpha outlines instead of all individual filled diff rectangles. Add `final-diff-groups-overlay.png` with the same grouped rendering and a visible numbered legend marker.

- [ ] **Step 4: Dynamic zoom panels**

Generate up to `UI_DIFF_MAX_CONTEXT_ZOOMS` zoom panels, default `8`, centered around largest/highest-severity finding groups. Each crop must add padding around the group and draw readable labels inside the crop coordinate space.

- [ ] **Step 5: Legend JSON**

Write `final-diff-groups-legend.json`:

```json
{
  "groups": [
    {
      "id": "group-001",
      "label": "G1",
      "box": { "x": 0, "y": 0, "width": 100, "height": 100 },
      "diffIds": ["diff-1"],
      "criteria": ["geometry", "color_appearance"],
      "severity": "medium",
      "zoomArtifact": "C:/.../final-diff-zoom-001.png"
    }
  ]
}
```

- [ ] **Step 6: Tests**

Add tests that:

- two overlapping diffs produce one group,
- a tall `1206x2622` image uses font size at least `18`,
- overlays are written,
- zoom panels are written for finding groups,
- legend JSON maps group IDs to diff IDs.

- [ ] **Step 7: Verify and commit**

Run:

```powershell
npx vitest run tests/unit/context-overlays.test.ts
```

Commit:

```powershell
git add src/report/context-overlays.ts src/schemas/core.ts tests/unit/context-overlays.test.ts docs/implementation-status.md
git commit -m "feat: make diff context overlays readable"
git push
```

## Task 4: Documentation And Live Evidence

**Files:**
- Modify: `README.md`
- Modify: `docs/research/locator-lane-benchmark.md`
- Modify: `docs/implementation-status.md`
- Optional live-generated, committed docs only: `docs/release/2026-07-03-locator-resolution-overlay-results.md`

- [ ] **Step 1: Correct README wording**

Replace “use `600` for strict local release gates” with:

```md
`600` is a local timeout workaround, not a quality default. It shrinks a
1206x2622 Calorix mockup to roughly 276x600 for the locator, which can hide
small icons, thin borders, and text. Prefer the highest dimension that fits the
sidecar budget, and run `npm run benchmark:locator` to compare 600/900/1200 on
the current machine before production sign-off.
```

- [ ] **Step 2: Run deterministic verification**

Run:

```powershell
npm run verify
```

- [ ] **Step 3: Run locator benchmark if sidecar is available**

Run:

```powershell
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-07-02-static-scan-fab.png"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
$env:UI_DIFF_LOCATOR_BENCHMARK_DIMENSIONS="600,900,1200"
npm run benchmark:locator
```

If `1200` times out, the benchmark must still write partial results and mark that dimension as `timeout`.

- [ ] **Step 4: Run relevant live gate if provider quota permits**

Run at least:

```powershell
$env:RUN_UI_DIFF_LIVE="1"
npm run verify:mcp-live
```

Run Calorix release only if sidecar/provider quota makes it practical:

```powershell
$env:RUN_CALORIX_RELEASE_LIVE="1"
npm run verify:calorix-release-live
```

- [ ] **Step 5: Post-implementation Antigravity review**

Ask Antigravity MCP to review code, tests, benchmark evidence, overlay readability, and docs. Green requires `AGREEMENT_STATUS: agree` and `MUST_FIX: none`.

- [ ] **Step 6: Commit and push**

Commit:

```powershell
git add README.md docs/research/locator-lane-benchmark.md docs/implementation-status.md docs/release/2026-07-03-locator-resolution-overlay-results.md
git commit -m "docs: record locator resolution overlay validation"
git push
```

## Acceptance Checks

- `npm run verify` passes.
- Reports include locator sizing metadata.
- `npm run benchmark:locator` can compare multiple dimensions sequentially and survives partial timeout.
- `final-diff-regions-overlay.png` no longer floods the screen with opaque green.
- New grouped overlay, legend, and zoom panels make the major findings readable.
- Documentation states that `600` is a timeout workaround and must not be treated as a production-quality default without benchmark evidence.
