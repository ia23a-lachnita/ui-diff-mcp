# Plan: Single-Pass Element Location (Expected-Only with Actual Projection)

**Date:** 2026-06-16  
**Status:** Approved — Gemini 3.1 Pro Preview reviewed; AGREEMENT_STATUS: agree, MUST_FIX: None  
**Author:** Claude Sonnet 4.6  
**Scope:** `src/locator/`, `src/pipeline/run-ui-diff.ts`, `src/pairing/`, `src/schemas/core.ts`, tests

---

## Problem

`run-ui-diff.ts` calls `locateUiElements()` **twice** — once for the expected image (lines 232–243)
and once for the actual image (lines 244–254). Each call:

- Does a health-check HTTP round-trip to the sidecar
- Encodes the full image as base64 and sends it over HTTP
- Runs 8 category queries through the cv_components + OCR (+ optional VLM) pipeline
- Scores and NMS-deduplicates the resulting boxes

This doubles sidecar time, doubles HTTP calls, and introduces pairing ambiguity: the two
independent locator runs can return different element counts, shifted boxes, or type
mismatches, all of which the scored `pairElements()` O(n·m) matcher must resolve —
imperfectly.

**Observed output confirms this is unnecessary.** The expected-image locator already reliably
identifies all the elements worth auditing. The auditor VLM handles noise (status bar,
mockup frame borders) and recovery handles uncovered pixel-diff regions.

---

## Proposed Approach

Locate elements **only on the expected image**. For the actual image, derive a set of
"projected" elements by copying the expected element boxes verbatim.

At audit time, `auditElementPair` already crops **both** images at the element boxes — so
sending it `expBox` and `actBox = expBox` is correct: the expected crop shows what was
expected, the actual crop shows what is at that same location now. If the element moved in
the actual, the actual crop will show whatever occupies the expected location, which is
meaningful visual evidence of absence or replacement. Recovery handles the moved element's
new location via pixel-diff components.

### What this changes

| Aspect | Before | After (default) |
|---|---|---|
| Locator calls per run | 2 (expected + actual) | 1 (expected only) |
| Pairing algorithm | Scored O(n·m) matching | 1:1 deterministic (projected) |
| Actual element source | `"locator"` | `"projected"` |
| Coverage computed for | expected + actual | expected only |
| Dual-location available | always | opt-in via `UI_DIFF_DUAL_LOCATOR=1` |
| Recovery | unchanged | unchanged |

### What this does NOT change

- The auditor VLM still compares expected vs actual crops at the same coordinates
- Recovery still finds uncovered pixel-diff components
- Deterministic diffs still run from pairing results
- All artifact paths, report schema structure, and MCP tool signatures are stable

---

## Tasks

### Task 1 — Core schema: add `"projected"` source type

**File:** `src/schemas/core.ts`

The `UiElement` schema has a `source` discriminant. Add `"projected"` as a valid value so
projected actual elements are correctly typed and serializable.

```
source: z.enum(["locator", "deterministic", "projected"])
```

No other schema fields change.

**Verification:** `npm run build` clean.

---

### Task 2 — `element-map.ts`: add `projectElementsToActual()`

**File:** `src/locator/element-map.ts`

Add a pure function that takes `expectedElements: UiElement[]` and `actualImageSize:
{ width: number; height: number }` and returns a parallel `UiElement[]` where:

- `box` is identical to the expected element's box (clamped to actualImageSize bounds)
- `normalizedBox` is recomputed from box / actualImageSize (expected and actual may be
  normalised to the same size after `loadNormalizedImage`, but the clamp guards the rare
  mismatched-dimension edge case)
- `source` is `"projected"`
- `id` is derived from the expected element's id with a `"proj-"` prefix so it is stable
  and unique without being a collision with any real element id
- All other fields (`label`, `type`, `queryId`, `text`, `confidence`, `childIds`) are
  copied from the expected element unchanged — they describe what the element is expected
  to be, which is the correct label for the audit prompt

```ts
export function projectElementsToActual(
  expectedElements: UiElement[],
  actualImageSize: { width: number; height: number }
): UiElement[]
```

Edge case: if a box from expected falls partially outside actual image bounds (e.g. actual
is slightly smaller), clamp `box.width` and `box.height` to `actualImageSize` and
recompute `normalizedBox`. Do not drop the element — a clamped crop still gives the VLM
evidence.

**Verification:** unit test (Task 7).

---

### Task 3 — `run-ui-diff.ts`: make single-pass the default

**File:** `src/pipeline/run-ui-diff.ts`

Read a new env var `UI_DIFF_DUAL_LOCATOR` (default unset / off).

**Single-pass path (default):**

```
const expResp = await locateUiElements({ ..., imagePath: normalizedExpPath, ... });
expectedElements.push(...buildElementMap(expResp.elements, ...));
const projectedActual = projectElementsToActual(expectedElements, {
  width: actualImg.width, height: actualImg.height
});
actualElements.push(...projectedActual);
```

- Only one coverage object is computed: `expectedCoverage` for expected elements.
- `actualCoverage` is set to a placeholder `ImageLocatorCoverage` with
  `status: "projected"` (new enum value, see Task 5) rather than `undefined`. This keeps
  the data structure consistent for report consumers that expect a coverage object for both
  images.
- `locatorCoverageStatus` is derived solely from `expectedCoverage.status`.
- An informational warning is always pushed on the single-pass path:
  `"Single-pass locator active (projection mode). Set UI_DIFF_DUAL_LOCATOR=1 for legacy dual-pass mode."`
  This gives clear, consistent run-mode visibility without conditional logic.

**Dual-pass opt-in (`UI_DIFF_DUAL_LOCATOR=1`):**

Restore the current two-call path exactly as-is. No behavioural changes to the dual path.
Add a comment noting this is the legacy / research mode.

**Verification:** `npm run verify` all tests pass.

---

### Task 4 — `pair-elements.ts`: fast-path for projected pairs

**File:** `src/pairing/pair-elements.ts`

When every element in `actualElements` has `source === "projected"`, the O(n·m) scoring
loop is unnecessary — the projected elements are already 1:1 with expected by construction.
Add a fast-path at the top of `pairElements()`:

```ts
const allProjected = actualElements.length > 0 &&
  actualElements.every(a => a.source === "projected");

if (allProjected) {
  return buildProjectedPairs(expectedElements, actualElements);
}
// ... existing scored path
```

`buildProjectedPairs` zips the two arrays by index (they are produced in identical order
by `projectElementsToActual`), creates `status: "matched"` pairs with `score: 1.0` and
`reasons: ["projected"]` for each, and emits no `"missing"` or `"extra"` pairs (because
projection covers 100% of expected elements).

**Why no missing/extra:** the entire point of projection is that we do not claim to detect
added/removed elements through the locator — only through the auditor VLM (which will see
an empty or different crop) and recovery (which catches uncovered pixel-diff mass).

**Verification:** unit test (Task 7).

---

### Task 5 — Coverage and report: record locator mode

**File:** `src/locator/coverage.ts`, `src/schemas/core.ts`, `src/pipeline/run-ui-diff.ts`

Add `"projected"` to the `ImageLocatorCoverage` status enum so the placeholder coverage
object (Task 3) is schema-valid. Add an optional `locatorActualMode` field to
`LocatorMetadata` (or as a top-level run report field) with values
`"independent" | "projected"`. When the single-pass path runs, set
`locatorActualMode: "projected"`. When dual runs, set `"independent"`.

In `run-ui-diff.ts`, pass this through into the report. The diagnostics JSON for
`target-map-actual.json` should note `"elementsSource": "projected"` so artifact consumers
know the actual elements are synthetic.

No schema version bump needed — both fields are additive and optional.

**Verification:** `npm run build` clean; check report artifact in a smoke run.

---

### Task 6 — Update tests

**File:** `tests/` (unit + integration)

- Any existing test that mocks or asserts two `locateUiElements` calls must be updated to
  expect one.
- Any test that constructs `actualElements` from a locator response must alternatively
  accept projected elements.
- Add unit tests:
  - `projectElementsToActual()` — correct ids, source, box clamping on smaller actual
  - `projectElementsToActual([])` — empty input returns empty array without error
  - `buildProjectedPairs()` — 1:1 zip, score=1.0, no missing/extra
  - `buildProjectedPairs([], [])` — empty input returns empty array without error
  - `pairElements()` fast-path trigger condition

**Verification:** `npm run verify` — all tests pass; `npm run test:coverage` — thresholds met.

---

### Task 7 — Gemini 3.1 Pro Preview review

Run `gemini -m gemini-2.5-pro-preview-06-05` with the standard review template:

```
Review docs/superpowers/plans/2026-06-16-single-pass-locator.md as a senior
engineer for correctness, edge cases, and implementation risks. Focus on:
1. Whether projecting expected boxes onto actual is architecturally sound given
   the pipeline's recovery mechanism.
2. Whether the pairing fast-path correctly handles all pair statuses.
3. Whether the opt-in dual-locator path needs additional guardrails.
Report AGREEMENT_STATUS, MUST_FIX, SHOULD_FIX. If MUST_FIX is none, say so explicitly.
```

Incorporate any MUST_FIX findings before starting implementation.

---

## Risk Register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Actual image is slightly different size after normalization | Low | Task 2 clamps boxes to actual bounds |
| Recovery misses elements that moved significantly | Medium | Recovery is unaffected; pixel-diff covers moved elements |
| Dual-locator tests still assert two calls | Medium | Task 6 explicitly audits all call-count assertions |
| `UI_DIFF_DUAL_LOCATOR=1` regression | Low | Dual path is preserved verbatim; existing integration test can set env var to exercise it |

---

## Out of Scope

- Removing the sidecar entirely (it remains as the locator backend)
- Changing the audit prompts or VLM calls
- Modifying recovery logic
- Any change to MCP tool signatures or report schema version
