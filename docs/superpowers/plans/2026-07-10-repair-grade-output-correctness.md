# Repair-Grade Output Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce UI-diff report artifacts that are canonical-coordinate, crop-valid, repair-local, hierarchy-inspectable, and truthful about runtime model use without imposing a zero-diff release condition.

**Architecture:** Establish one comparison-space geometry boundary used before all report-facing locations and image extraction. Build containment from selected nearest parents, then derive a visible container-and-leaf hierarchy. Group only validated local findings, persist explicit rejection/suppression diagnostics, and derive report attribution from provider trace events rather than route selection. Validate the canonical Calorix expected asset independently from fresh actual auto-capture.

**Tech Stack:** TypeScript ESM, Zod v4, Sharp, Vitest, Python LocateAnything sidecar parser, existing `ImagePairTransform`, `ProviderTraceWriter`, Calorix live-gate helpers.

## Global Constraints

- Final report locations and run-level artifact annotations use only `comparison_expected_normalized` coordinates.
- Clip only intersecting boxes; reject non-finite, non-positive, disjoint, and smaller-than-`2x2` artifact crops. Never write a 1x1 placeholder.
- No manual ROI maps, ignore masks, target maps, anchor dumps, or silent suppression.
- Keep selected model routes separate from actual provider trace success aggregates.
- Sanitize only known `<ref>`, `<box>`, and numeric coordinate grounding-token families; preserve ordinary text such as `x < y`.
- Do not globally loosen containment. Only recognized compact component roles/types may use the adaptive geometric-containment rule; ordinary nodes retain the conservative area-and-center guard.
- `UI_DIFF_LIVE_ACTUAL_IMAGE` remains a historical override; fresh Calorix release evidence defaults to auto-capture.
- Complete the canonical Calorix reference restoration/manifest task before any Calorix live visual gate; it is not a prerequisite for deterministic geometry/parser tasks.
- Do not require zero final diffs for MCP production readiness. Release readiness is report completeness/integrity evidence.
- The main-agent Antigravity MCP follow-up review in conversation `risk-first-remediation-plans-2026-07-11` used `gemini-3.1-pro-preview` and returned `AGREEMENT_STATUS: agree`, `MUST_FIX: none`, `SHOULD_FIX: none`, with no MCP response noise. The review gate is green; this does not claim implementation.
- Update `docs/implementation-status.md`, commit, and push after every completed implementation task; this planning-only change intentionally remains uncommitted by user direction.

---

## File Structure

- Create `src/images/comparison-geometry.ts`: canonical coordinate conversion, intersection, validation, crop eligibility, and rejection reasons.
- Modify `src/images/artifacts.ts`, `src/images/crop.ts`, `src/audit/audit-target.ts`, `src/recovery/target-recovery.ts`, `src/report/context-overlays.ts`: consume shared geometry; prevent invalid/1px artifacts.
- Modify `src/schemas/core.ts`, `src/debug/run-debug.ts`, `src/pipeline/run-ui-diff.ts`, `src/report/report-parts.ts`: persist coordinate/rejection/suppression/runtime attribution contracts.
- Modify `src/locator/element-map.ts`, `sidecars/locateanything/parser.py`, and hierarchy/overlay tests: deterministic parentage and full markup sanitation.
- Modify `src/report/finding-consolidation.ts` and `src/report/context-overlays.ts`: local grouping, parent-child suppression, legends, and local zooms.
- Modify `tests/helpers/calorix-device.ts`, Calorix live tests, and release documentation: early canonical expected-reference restoration/manifest, validation, and exhaustive artifact evidence.

## Task 1: Pre-Implementation Evidence And Review Gate

**Files:**
- Modify `docs/implementation-status.md`
- Modify `docs/superpowers/plans/2026-07-10-repair-grade-output-correctness.md`

**Interfaces:**
- Produces the authoritative review conversation ID and a documented canonical-reference decision before code changes.

- [ ] **Step 1: Verify current evidence without changing code**

Run:

```powershell
git status --short
git log -1 --oneline
npm run verify
Get-ChildItem C:\Users\xursc\projects\calorix\docs\design-handoff\placeholder-app -Recurse -File
Get-Content C:\Users\xursc\projects\calorix\ui-diff.config.json
```

Expected: current unit/e2e/parser/build/integration verification is recorded; the configured `reference-images/today--dark.png` absence is confirmed or a restored authoritative asset is identified.

- [x] **Step 2: Record the required read-only Antigravity design review**

Use `mcp__antigravity_mcp__ask_ai` with:

```text
model: gemini-3.1-pro-preview
approvalMode: yolo
conversationId: ui-diff-repair-grade-output-design-2026-07-10
```

Prompt requirements: explicitly prohibit edits/writes/mutation; provide the spec, this plan, audit, coordinate/crop source files, hierarchy files, provider trace schema, and Calorix helper. Require `AGREEMENT_STATUS`, `MUST_FIX`, `SHOULD_FIX`, and task ordering.

- [x] **Step 3: Incorporate concrete blockers before implementation**

For each `MUST_FIX`, revise the spec/plan or record why it is already addressed. The reviewer returned:

```text
AGREEMENT_STATUS: agree
MUST_FIX: none
SHOULD_FIX: none
```

The follow-up is recorded in the spec's External Review Record and had no MCP response noise. Task 2 is the next staged execution task; no implementation is claimed by this review update.

- [ ] **Step 4: Record the reference decision**

Document the resolved canonical Calorix path, source repository commit/hash, image SHA-256, responsible Calorix owner confirmation, and whether the active path was restored or deliberately migrated. Do not choose `reference-images-buggy` merely because it exists.

- [ ] **Step 5: Commit and push the reviewed plan state**

```powershell
git add docs/implementation-status.md docs/superpowers/specs/2026-07-10-repair-grade-output-correctness.md docs/superpowers/plans/2026-07-10-repair-grade-output-correctness.md
git commit -m "docs: approve repair-grade output plan"
git push origin HEAD
```

## Task 2: Canonical Calorix Expected Reference Restoration And Manifest

**Files:**
- Modify `tests/helpers/calorix-device.ts`
- Modify `tests/unit/calorix-device.test.ts`
- Modify `tests/live/calorix-smoke.live.test.ts`
- Modify `README.md`
- Modify `docs/release/production-readiness-checklist.md`
- Modify `docs/implementation-status.md`

**Interfaces:**

```ts
export async function getValidatedCalorixExpectedImagePath(projectRoot?: string): Promise<string>;
// Throws a path-specific error when the default/override is missing or unreadable.
```

**Ordering:** This is an early cross-repository prerequisite for every Calorix live visual gate, including `verify:calorix-live`, `verify:calorix-full-live`, and `verify:calorix-release-live`. It does not block deterministic Tasks 3-8: geometry, crop, parser, hierarchy, grouping, and attribution work proceed independently after the Task 1 review gate is green.

- [ ] **Step 1: Resolve and restore the authoritative Calorix reference with its owner**

Inspect the Calorix handoff, `ui-diff.config.json`, file map, and source-control history with the Calorix owner. Restore the active `reference-images/today--dark.png` asset or deliberately migrate the canonical reference and its manifest/config together. Record the Calorix source commit, selected path, SHA-256, and owner confirmation. Do not use `reference-images-buggy` as a fallback or a current live screenshot as expected evidence.

- [ ] **Step 2: Write failing helper/live-contract tests**

Assert: canonical default exists and resolves; a missing default throws an error that includes the attempted absolute path and remediation; `UI_DIFF_LIVE_EXPECTED_IMAGE` override still wins but is validated; no `UI_DIFF_LIVE_ACTUAL_IMAGE` uses auto-capture; an explicit actual override returns `source:"env_override"` and a freshness warning.

- [ ] **Step 3: Run red tests**

```powershell
npx vitest run tests/unit/calorix-device.test.ts
```

Expected: FAIL because expected-image resolution currently returns a dangling path without validation.

- [ ] **Step 4: Implement validated expected resolution and manifest documentation**

Validate the path/readability and manifest identity before invoking a live pipeline. Keep `resolveCalorixActualImage()` behavior unchanged apart from asserting the report records `auto_capture` versus `env_override`. Update all live command examples to use the canonical expected reference and explicitly unset `UI_DIFF_LIVE_ACTUAL_IMAGE` for release evidence.

- [ ] **Step 5: Run green tests and commit**

```powershell
npx vitest run tests/unit/calorix-device.test.ts
git add tests/helpers/calorix-device.ts tests/unit/calorix-device.test.ts tests/live/calorix-smoke.live.test.ts README.md docs/release/production-readiness-checklist.md docs/implementation-status.md
git commit -m "fix: validate Calorix reference image"
git push origin HEAD
```

## Task 3: Canonical Comparison Geometry Contract

**Files:**
- Create `src/images/comparison-geometry.ts`
- Modify `src/schemas/core.ts`
- Create `tests/unit/comparison-geometry.test.ts`
- Modify `tests/unit/schemas.test.ts`
- Modify `docs/implementation-status.md`

**Interfaces:**

```ts
export const ComparisonCoordinateSpaceSchema = z.literal("comparison_expected_normalized");
export type ComparisonBoxResolution =
  | { status: "valid"; box: Box; clipped: boolean; coordinateSpace: "comparison_expected_normalized" }
  | { status: "rejected"; reason: "non_finite" | "non_positive" | "disjoint" | "below_minimum_artifact_size" };

export function resolveComparisonBox(input: {
  box: Box;
  sourceSpace: "expected_normalized" | "actual_normalized" | "comparison_expected_normalized";
  canvas: { width: number; height: number };
  transform?: ImagePairTransform;
  minimumSize?: { width: number; height: number };
}): ComparisonBoxResolution;
```

- [ ] **Step 1: Write failing geometry tests**

Cover exact expected-space pass-through, actual-to-expected projection, partially intersecting clipping, and these rejections:

```ts
expect(resolveComparisonBox({ box: { x: -10, y: 20, width: 8, height: 8 }, ...input })).toMatchObject({ status: "rejected", reason: "disjoint" });
expect(resolveComparisonBox({ box: { x: 401, y: 873, width: 1, height: 1 }, ...input })).toMatchObject({ status: "rejected", reason: "below_minimum_artifact_size" });
expect(resolveComparisonBox({ box: { x: Number.NaN, y: 0, width: 20, height: 20 }, ...input })).toMatchObject({ status: "rejected", reason: "non_finite" });
expect(resolveComparisonBox({ box: { x: 398, y: 870, width: 10, height: 10 }, ...input })).toMatchObject({ status: "valid", box: { x: 398, y: 870, width: 4, height: 4 }, clipped: true });
```

- [ ] **Step 2: Run the red test**

```powershell
npx vitest run tests/unit/comparison-geometry.test.ts tests/unit/schemas.test.ts
```

Expected: FAIL because the shared resolver and schema fields do not exist.

- [ ] **Step 3: Implement the resolver and diagnostic schemas**

Add the resolver with a `2x2` default minimum for artifacts. Add report-safe geometry diagnostic schemas: per-producer counts keyed by rejection reason, artifact/zoom rejection metadata, and `coordinateSpace` fields for report-facing legend records. Keep `BoxSchema` reusable; do not weaken its existing consumers.

- [ ] **Step 4: Run green tests**

```powershell
npx vitest run tests/unit/comparison-geometry.test.ts tests/unit/schemas.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit and push**

```powershell
git add src/images/comparison-geometry.ts src/schemas/core.ts tests/unit/comparison-geometry.test.ts tests/unit/schemas.test.ts docs/implementation-status.md
git commit -m "feat: validate comparison-space boxes"
git push origin HEAD
```

## Task 4: Eliminate Invalid Crop And Zoom Artifacts

**Files:**
- Modify `src/images/artifacts.ts`
- Modify `src/images/crop.ts`
- Modify `src/audit/audit-target.ts`
- Modify `src/recovery/target-recovery.ts`
- Modify `src/report/context-overlays.ts`
- Modify `tests/unit/context-overlays.test.ts`
- Create `tests/unit/crop-validation.test.ts`
- Modify `docs/implementation-status.md`

**Interfaces:**

```ts
export async function writeComparisonCrop(input: {
  imagePath: string;
  comparisonBox: Box;
  outPath: string;
  canvas: { width: number; height: number };
}): Promise<CropResult | { status: "rejected"; reason: ComparisonBoxRejectionReason }>;
```

- [ ] **Step 1: Write failing crop tests**

Assert a `1x1` requested edge crop returns `status:"rejected"`, writes no file, and is counted as `below_minimum_artifact_size`. Assert a clipped `4x4` crop writes exactly 4x4. Assert a disjoint group causes `zoomStatus:"rejected"` in `final-diff-groups-legend.json` and no `final-diff-zoom-*.png`.

- [ ] **Step 2: Run the red tests**

```powershell
npx vitest run tests/unit/crop-validation.test.ts tests/unit/context-overlays.test.ts
```

Expected: FAIL because crop writers still synthesize `1x1` raw images or use independent clamping.

- [ ] **Step 3: Route every extraction through shared validation**

Replace local `Math.max(1, ...)`, `Uint8Array(4)`, and independent overlay/zoom clamp paths with the comparison resolver. `audit-target` must skip malformed provider evidence and emit a trace rejection. `target-recovery` must retain/reason about the unresolved component instead of passing a 1x1 crop to a model. `writeZoomPanel` returns a structured result and the legend records `zoomStatus`, reason, and canonical coordinate space.

- [ ] **Step 4: Run green tests and focused e2e regression**

```powershell
npx vitest run tests/unit/crop-validation.test.ts tests/unit/context-overlays.test.ts tests/unit/audit.test.ts tests/unit/target-recovery.test.ts
npx vitest run tests/e2e/compare-ui-images.test.ts
```

Expected: PASS; no test fixture writes a synthetic 1x1 crop.

- [ ] **Step 5: Commit and push**

```powershell
git add src/images/artifacts.ts src/images/crop.ts src/audit/audit-target.ts src/recovery/target-recovery.ts src/report/context-overlays.ts tests/unit/crop-validation.test.ts tests/unit/context-overlays.test.ts tests/unit/audit.test.ts tests/unit/target-recovery.test.ts tests/e2e/compare-ui-images.test.ts docs/implementation-status.md
git commit -m "fix: reject invalid diff artifacts"
git push origin HEAD
```

## Task 5: Deterministic Hierarchy And Full Locator Markup Cleanup

**Files:**
- Modify `sidecars/locateanything/parser.py`
- Modify `sidecars/locateanything/test_parser.py`
- Modify `src/locator/element-map.ts`
- Modify `tests/unit/element-map.test.ts`
- Modify `docs/implementation-status.md`

**Interfaces:**

```ts
export function selectNearestContainingParents(elements: UiElement[]): UiElement[];
// Each child has at most one parent; parent childIds are reconstructed from selected parentId values.
```

- [ ] **Step 1: Write failing parser and hierarchy-parent tests**

Add red Python parser cases that remove only paired/unmatched `<ref>` and `<box>` tokens plus numeric coordinate grounding tags, while preserving `x < y` and unknown angle-bracket prose. Add matching red TypeScript label-normalization cases before stable ID creation. Add TypeScript parent-selection cases where the same nested boxes arrive in three permutations and always produce `child.parentId === inner.id`, `inner.parentId === outer.id`, and stable child lists. Cover an equal-area ID tie, a tight recognized chip containing text, a tight recognized icon button containing an icon, and overlapping sibling boxes that must not become parent/child.

- [ ] **Step 2: Run red tests**

```powershell
python -m unittest sidecars.locateanything.test_parser
npx vitest run tests/unit/element-map.test.ts
```

Expected: FAIL because first-match iteration controls parent selection, sanitizer matching is broader than known grounding tokens or leaves unmatched tokens, and compact components are not handled without globally weakening containment.

- [ ] **Step 3: Implement full sanitizer and selected-parent construction**

Make Python parsing/sanitization remove only known grounding tokens and coordinate-tag grammar while retaining normal prose, including `x < y`; apply the identical intent in TypeScript before stable ID creation. After NMS, build candidate parent lists. Ordinary candidates require the conservative center-containing, >=1.5-area, strictly-larger rule. A candidate with a recognized compact component role/type may use the adaptive rule only when it geometrically contains the child within documented rounding tolerance and is strictly larger; overlap is insufficient, labels never determine compactness, and unrecognized nodes never use this exception. Sort eligible candidates by area then ID, set one `parentId`, and reconstruct `childIds` from that relation. Reject or ignore invalid geometry candidates through the shared resolver policy where image dimensions are available.

- [ ] **Step 4: Run green tests**

```powershell
python -m unittest sidecars.locateanything.test_parser
npx vitest run tests/unit/element-map.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit and push**

```powershell
git add sidecars/locateanything/parser.py sidecars/locateanything/test_parser.py src/locator/element-map.ts tests/unit/element-map.test.ts docs/implementation-status.md
git commit -m "fix: stabilize locator hierarchy parents"
git push origin HEAD
```

## Task 6: Visible Containers And Ordinary Leaves

**Files:**
- Modify `src/report/context-overlays.ts`
- Modify `tests/unit/context-overlays.test.ts`
- Modify `src/schemas/core.ts`
- Modify `tests/unit/schemas.test.ts`
- Modify `docs/implementation-status.md`

**Interfaces:**

```ts
interface SemanticHierarchyNode {
  nodeRole: "screen" | "container" | "leaf";
  coordinateSpace: "comparison_expected_normalized";
  elementId?: string;
  parentNodeId?: string;
  childNodeIds: string[];
}
```

- [ ] **Step 1: Write failing hierarchy visibility tests**

Construct a card containing ordinary `text` title/value leaves and an `icon` leaf through an intermediate `cv_component`; assert all leaves appear under the card in the legend and hierarchy overlay annotations. Assert near-full-screen parent nodes are hidden but their children are reparented to the nearest visible ancestor/screen. Assert invalid/disjoint nodes are absent with rejection diagnostics.

- [ ] **Step 2: Run red tests**

```powershell
npx vitest run tests/unit/context-overlays.test.ts tests/unit/schemas.test.ts
```

Expected: FAIL because text/icon filtering and untyped hierarchy metadata remain.

- [ ] **Step 3: Implement node-role hierarchy and aligned annotations**

Use selected containment from Task 5. Make semantic types and multi-child elements containers; emit meaningful non-container elements as leaves. Walk suppressed ancestor chains before choosing the visible parent. Build hierarchy annotations from exactly these nodes. Store canonical boxes and coordinate-space metadata in the hierarchy legend.

- [ ] **Step 4: Run green tests**

```powershell
npx vitest run tests/unit/context-overlays.test.ts tests/unit/schemas.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit and push**

```powershell
git add src/report/context-overlays.ts src/schemas/core.ts tests/unit/context-overlays.test.ts tests/unit/schemas.test.ts docs/implementation-status.md
git commit -m "feat: preserve hierarchy leaves"
git push origin HEAD
```

## Task 7: Repair-Local Grouping, Suppression, And Canonical Overlays

**Files:**
- Modify `src/report/finding-consolidation.ts`
- Modify `src/report/context-overlays.ts`
- Modify `src/schemas/core.ts`
- Modify `tests/unit/finding-consolidation.test.ts`
- Modify `tests/unit/context-overlays.test.ts`
- Modify `tests/e2e/compare-ui-images.test.ts`
- Modify `docs/implementation-status.md`

**Interfaces:**

```ts
type RepairLocality = "local" | "broad";
type FindingSuppressionReason =
  | "duplicate_child_of_group"
  | "screen_sized_context_only"
  | "nonlocal_parent_explanation";
```

- [ ] **Step 1: Write failing local-group tests**

Create: (a) three nearby same-direction leaf diffs that form one local group; (b) a full-screen parent plus two separated leaf diffs that must remain two groups with the parent context-only; (c) a full-screen-only VLM finding that becomes broad unresolved/escalated and yields no normal zoom; (d) an actual-source location that is projected before group/overlay construction.

- [ ] **Step 2: Run red tests**

```powershell
npx vitest run tests/unit/finding-consolidation.test.ts tests/unit/context-overlays.test.ts tests/e2e/compare-ui-images.test.ts
```

Expected: FAIL because grouping accepts broad unions and legend/overlay boxes lack a single explicit canonical contract.

- [ ] **Step 3: Implement validated grouping and explicit suppression**

Canonicalize/validate every final location before grouping. Require bounded scale plus local relation/shared container/coherent displacement. Preserve suppressed child references in group legend data. Mark non-decomposable broad evidence with `repairLocality:"broad"`, keep it unresolved/escalated, and exclude it from normal numbered repair groups and zoom artifacts. Write all overlays only from accepted canonical boxes.

- [ ] **Step 4: Run green tests**

```powershell
npx vitest run tests/unit/finding-consolidation.test.ts tests/unit/context-overlays.test.ts tests/e2e/compare-ui-images.test.ts
```

Expected: PASS; all legend boxes declare `comparison_expected_normalized`.

- [ ] **Step 5: Commit and push**

```powershell
git add src/report/finding-consolidation.ts src/report/context-overlays.ts src/schemas/core.ts tests/unit/finding-consolidation.test.ts tests/unit/context-overlays.test.ts tests/e2e/compare-ui-images.test.ts docs/implementation-status.md
git commit -m "fix: localize repair diff groups"
git push origin HEAD
```

## Task 8: Runtime Model Attribution And Status Truth

**Files:**
- Modify `src/schemas/core.ts`
- Modify `src/debug/provider-trace.ts`
- Modify `src/pipeline/run-ui-diff.ts`
- Modify `src/report/report-parts.ts`
- Modify `tests/unit/provider-trace.test.ts`
- Modify `tests/unit/report.test.ts`
- Modify `tests/e2e/compare-ui-images.test.ts`
- Modify `docs/implementation-status.md`

**Interfaces:**

```ts
interface RuntimeModelUsage {
  phase: "audit" | "reviewer" | "recovery" | "probe" | "quota_preflight";
  provider: string;
  model: string;
  callStartCount: number;
  callSuccessCount: number;
  callErrorCount: number;
  fallbackCount: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}
```

- [ ] **Step 1: Write failing attribution tests**

Use a trace with Gemini audit successes only, Mistral reviewer successes, and a selected-but-never-successful recovery route. Assert runtime aggregates are phase/model specific, the selected route remains separate, and report text never says the unused route completed work. Add a cross-run helper test that returns `not_comparable` for distinct actual-image hashes.

- [ ] **Step 2: Run red tests**

```powershell
npx vitest run tests/unit/provider-trace.test.ts tests/unit/report.test.ts tests/e2e/compare-ui-images.test.ts
```

Expected: FAIL because report-facing aggregates and comparability status do not exist.

- [ ] **Step 3: Implement trace-derived aggregates and bounded narrative**

Aggregate immutable provider trace events after pipeline completion; attach the result to the report alongside `modelSelection`. Populate per-diff/recovery model fields only from successful caller responses. Make report parts/status helpers say `not comparable` without matching expected/actual content hashes and declared cohorts. Replace stale status prose with the audited run's verified 3/0, 32/31, and 179/179 counts.

- [ ] **Step 4: Run green tests**

```powershell
npx vitest run tests/unit/provider-trace.test.ts tests/unit/report.test.ts tests/e2e/compare-ui-images.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit and push**

```powershell
git add src/schemas/core.ts src/debug/provider-trace.ts src/pipeline/run-ui-diff.ts src/report/report-parts.ts tests/unit/provider-trace.test.ts tests/unit/report.test.ts tests/e2e/compare-ui-images.test.ts docs/implementation-status.md
git commit -m "fix: report runtime model attribution"
git push origin HEAD
```

## Task 9: Pipeline Contract, Full Verification, And Exhaustive Live Artifact Inspection

**Files:**
- Modify `tests/e2e/compare-ui-images.test.ts`
- Modify `tests/live/calorix-smoke.live.test.ts`
- Modify `docs/release/2026-07-10-repair-grade-output-results.md`
- Modify `docs/implementation-status.md`

**Interfaces:**
- Produces a release evidence record containing run ID, image identities, run/model statistics, geometry diagnostics, final status/source counts, and per-artifact inspection table.

- [ ] **Step 1: Add e2e report invariants**

Assert all final diff locations and legend/hierarchy nodes carry canonical comparison-space metadata; every listed final zoom file has metadata dimensions at least `2x2`; rejected zooms have no file; broad records are unresolved/escalated, not numbered groups; `runtimeModelUsage` agrees with synthetic provider traces.

- [ ] **Step 2: Run full deterministic verification**

```powershell
npm run verify
```

Expected: PASS. Record exact test/build/integration counts.

- [ ] **Step 3: Run applicable live gates and record blockers**

Complete Task 2's restored/migrated canonical-reference manifest and focused green test before every Calorix live visual gate. Then run in this order when credentials/sidecar/quota permit:

```powershell
npm run verify:gemini-live
npm run verify:mistral-live
npm run verify:nvidia-live
npm run verify:openrouter-free-live
npm run verify:opencode-live
npm run verify:mcp-live
npm run verify:calorix-live
npm run verify:calorix-full-live
Remove-Item Env:UI_DIFF_LIVE_ACTUAL_IMAGE -ErrorAction SilentlyContinue
npm run verify:calorix-release-live
```

For each skipped/failed gate, write the exact missing variable, sidecar/credential/quota/network/timeout cause. Never replace a blocked gate with an unlabelled claim of success.

- [ ] **Step 4: Exhaustively inspect the final release run**

Open/read every final artifact referenced by `report.json`: expected/actual comparison images, every `final-diff-zoom-*`, all group/region/context/hierarchy overlays, both JSON legends, provider trace, and geometry diagnostics. Verify dimensions and coordinate-space fields programmatically, then visually inspect each image. Record a table with artifact path, dimensions, linked group/diff IDs, validation status, and inspection result. Report final counts by source and reviewer status, `auditLimited`, `visualClassificationStatus`, unresolved/escalated counts, selected routes, runtime aggregates, error/fallback summary, expected/actual hashes, and `exhaustive` inspection scope.

- [ ] **Step 5: Request post-implementation Antigravity review**

Use the same conversation ID and `gemini-3.1-pro-preview`/`approvalMode:"yolo"`. Explicitly prohibit edits/writes/mutation. Provide commit range, all verification results, run ID, report/trace/artifact paths, and the exhaustive inspection record. Continue the same conversation until it reports `AGREEMENT_STATUS: agree` and `MUST_FIX: none`.

- [ ] **Step 6: Commit and push final evidence**

```powershell
git add tests/e2e/compare-ui-images.test.ts tests/live/calorix-smoke.live.test.ts docs/release/2026-07-10-repair-grade-output-results.md docs/implementation-status.md
git commit -m "docs: record repair-grade output validation"
git push origin HEAD
```

## Acceptance Checks

- Every final artifact is anchored to `comparison_expected_normalized`; no actual-source rectangle reaches a report overlay unprojected.
- Invalid boxes are observable rejections and never written as 1x1 crops or zooms.
- Hierarchy is deterministic under input reordering, supports recognized tight chips/icon buttons through geometric containment, rejects overlapping siblings as parents, and includes ordinary text/icon leaves beneath visible containers.
- Locator labels contain no paired or unmatched known grounding tokens and preserve ordinary comparison/math prose.
- Repair groups are local, explicit about suppressions, and cannot disguise broad findings as a local repair.
- Selected routes, actual successful calls, report claims, and status prose agree.
- Calorix expected reference is canonical/present/validated; fresh actual auto-capture remains default.
- Production readiness remains a completeness/integrity judgment with explicit nonzero-diff allowance.
