# Repair-Grade UI Diff Output Correctness

Date: 2026-07-10  
Status: design approved by request; implementation not started  
Scope: repair output correctness and evidence usability after the 2026-07-10 post-session audit. This is not a Calorix parity-edit specification.

## Problem Statement

`run-1783489317778-792f0e` completed its accounting contract but did not produce repair-grade evidence. Six final VLM findings used the full comparison canvas, one deterministic location was in actual-image coordinates, and `final-diff-zoom-003.png` became a synthetic 1x1 crop. The hierarchy was flat because containment selected the first eligible parent and the report dropped ordinary text/icon leaves. Its narrative also overstated Gemini participation and inferred model sensitivity from runs with different captured actual images.

The repair makes each output artifact traceable to one valid coordinate system, preserves useful semantic structure, and distinguishes observed runtime facts from selected model routes. A complete release report may contain diffs. It must never require zero diffs to prove MCP production readiness.

## Goals

1. Make the expected normalized image the canonical comparison coordinate space for every final diff, coverage location, finding group, hierarchy node, overlay, legend record, zoom crop, and artifact annotation.
2. Reject invalid artifact crops with a recorded reason instead of manufacturing 1x1 PNGs or silently moving a disjoint box to an edge pixel.
3. Build stable, inspectable semantic trees with nearest/smallest containing parents, adaptive compact-component parenting, structural containers, and ordinary text/icon leaves.
4. Remove only known locator grounding markup without discarding meaningful human labels or ordinary comparison/math prose.
5. Emit repair-local groups only when their members support one local explanation; expose broad/unlocalizable findings honestly instead of presenting them as local repair instructions.
6. Make report/status prose agree with persisted provider trace events, selected routes, image identity, and inspected artifact evidence.
7. Restore and validate the Calorix expected-reference configuration while retaining fresh ADB auto-capture as the default actual-image path.
8. Add focused regression tests, live gates, and exhaustive final-artifact inspection for the validation release run.

## Non-Goals

- Do not edit Calorix UI/parity code or require Calorix to reach zero visual diffs.
- Do not add manual target maps, ROIs, ignore masks, anchor dumps, or user-authored exclusions.
- Do not reclassify a broad finding as noise merely to make the report look local.
- Do not infer model quality or sensitivity across runs unless expected and actual image identities, routes, and decision cohorts are explicitly comparable.
- Do not change provider routing policy except where output attribution requires recording the route actually used.

## Canonical Comparison Geometry

### Coordinate contract

The expected normalized image is `comparison_expected_normalized`. It has the expected image dimensions and is the only coordinate space allowed in final report locations and run-level output artifacts.

| Input | Source space | Required conversion before final use |
| --- | --- | --- |
| Expected locator element/deterministic component | expected normalized | Validate against the comparison canvas. |
| Actual locator element from dual location | actual normalized/source | Project with `ImagePairTransform` to expected normalized, then validate. |
| Projected expected element | expected normalized | Validate against the comparison canvas. |
| VLM/recovery finding derived from a pixel component | comparison canvas | Validate against the comparison canvas. |
| Pair-local actual crop | actual image | May remain source-sized for provider input, but its report-facing location and all run-level annotations use the paired canonical box. |

`actual-comparison.png` must be dimensionally equal to the expected normalized image. Its pixels are transformed/resized actual evidence displayed on the expected canvas; it does not make actual-source coordinates valid by itself.

### Shared validation policy

Create one comparison-geometry module owned by `src/images/` that accepts a box, its declared input space, `ImagePairTransform`, and comparison canvas dimensions. It returns either:

```ts
type ValidComparisonBox = {
  status: "valid";
  box: Box;
  clipped: boolean;
  sourceSpace: "expected_normalized" | "actual_normalized" | "comparison_expected_normalized";
};

type RejectedComparisonBox = {
  status: "rejected";
  reason: "non_finite" | "non_positive" | "disjoint" | "below_minimum_artifact_size";
  sourceSpace: string;
};
```

The validator first projects actual input into comparison space, rejects non-finite coordinates and non-positive dimensions, intersects with the canvas, and accepts a clipped intersection only when it is at least `2x2` pixels. A box entirely outside the canvas, or an intersection smaller than `2x2`, is rejected. It never expands a box to a minimum dimension and never converts a rejected crop into an edge-pixel artifact.

The same policy is used for final diff locations, group boxes, overlay annotations, crop extraction, zoom panels, local recovery evidence, and every `Sharp.extract()` call. Pair-local provider crops must report rejection to their audit/recovery trace and skip provider input that would be malformed; run-level output must retain the corresponding unresolved/escalated state when evidence cannot be produced.

### Observable rejection

Persist per-run geometry diagnostics with counts by reason and artifact producer, plus per-diff/region diagnostic references where applicable. A rejected final location cannot appear in `diffs`, finding-group legends, or successful artifact arrays. It must either be repaired through canonical projection, remain an unresolved/escalated region with the rejection reason, or cause a run failure when it invalidates a required invariant.

## Semantic Hierarchy And Locator Labels

### Parent selection

After duplicate suppression, evaluate all valid strict containers for each element. Ordinary nodes retain the conservative guard: a candidate parent contains the child's center, is at least 1.5 times the child area, and has strictly greater area. For a candidate with a recognized compact interactive role/type (for example, a chip or icon button), use an adaptive compact-component rule only when the candidate geometrically contains the child box within the documented rounding tolerance and has strictly greater area; this permits tight padding without globally relaxing ordinary containment. Never infer compactness from label text or apply the compact rule to unrecognized nodes.

Choose the eligible candidate with the smallest area; break exact-area ties by stable element ID. Derive `parentId` from that selection, then derive every `childIds` list from selected `parentId` values. Do not assign relationships during pairwise iteration. Overlap alone, including overlapping siblings, is not containment under either rule.

This makes hierarchy independent of locator order. Invalid or near-full-screen duplicate elements can be suppressed from the visible hierarchy, but their valid descendants must walk upward to the nearest visible ancestor or `Screen` rather than being discarded.

### Visible nodes and leaves

The tree has three visible roles: `screen`, `container`, and `leaf`.

- Containers are semantic container types and non-semantic elements with two or more selected children.
- Ordinary `text` and `icon` elements are leaves when they have a valid canonical box and a meaningful normalized label. They remain visible beneath their nearest visible container, even when their type is not a container.
- Other valid non-container elements remain leaves where they carry meaningful locator evidence; only duplicate, invalid, or full-screen-duplicate nodes are suppressed.

The hierarchy legend records `nodeRole`, canonical `box`, `parentNodeId`, `childNodeIds`, `elementId`, and `coordinateSpace`. Context overlays use the same visible node set for annotations, so the JSON and image cannot disagree about what is inspectable.

### Label normalization

Both boundaries sanitize only the known grounding-token family: paired or unmatched `<ref>`, `</ref>`, `<box>`, `</box>`, and coordinate grounding tags that match the documented numeric coordinate grammar, such as `<123>` or `<12,34,56,78>`. The Python sidecar sanitizer runs immediately after parsing; the TypeScript element-map sanitizer is the mandatory second net. It removes matching tokens, not arbitrary angle-bracket text or arbitrary text enclosed by them.

Sanitization removes those tokens and normalizes whitespace. It preserves ordinary prose, including comparison/math labels such as `x < y`; an unknown angle-bracket sequence must remain unchanged. If the resulting label is empty, numeric-only, a prompt echo, or still token-contaminated, use the stable `${type}-${queryId}-${index}` fallback. Preserve the raw sidecar response only in existing non-report debugging channels, never as a hierarchy label.

## Repair-Grade Finding Groups And Artifacts

### Group eligibility

Build groups only from valid canonical final locations. A group is repair-local only when its members have bounded scale, local overlap/proximity, and either a shared selected container or a coherent same-direction geometry explanation. Its union box must pass the shared validation policy and must not cover a screen-sized area merely because a parent explanation was included.

Parent/screen-sized records may provide context but cannot absorb localized children into one repair group. Duplicate parent/child explanations are suppressed only when the child evidence remains reachable from the retained group/legend. Every suppression is recorded with a reason (`duplicate_child_of_group`, `screen_sized_context_only`, or `nonlocal_parent_explanation`) and references to the retained evidence.

If a broad record cannot be decomposed into valid local evidence, keep it as `unresolved` or `needs_escalation` with `repairLocality:"broad"`; do not render it as a normal numbered repair group or manufacture a local zoom.

### Overlay and zoom contract

`final-diff-regions-overlay`, `final-diff-groups-overlay`, the group legend, hierarchy overlay, semantic legend, unresolved overlay, context overlay, and every `final-diff-zoom-*` artifact draw only canonical comparison-space boxes on the expected-size comparison canvas. The legend explicitly declares `coordinateSpace:"comparison_expected_normalized"` and includes each group member's final diff IDs.

A zoom is written only after validating the group box and padded crop. Its local annotation is the validated group box translated by the validated crop origin and clipped to crop dimensions. On rejection, no PNG is written and the legend records `zoomStatus:"rejected"` plus the geometry reason. There is no 1x1 placeholder path.

## Truthful Model Attribution And Status Narrative

`modelSelection` remains a configuration/route-selection record. Add a separate report-facing runtime aggregate derived only from `provider-trace.json`: `phase`, `provider`, `model`, `callStartCount`, `callSuccessCount`, `callErrorCount`, `fallbackCount`, and token totals when available. Diff/recovery records retain the concrete auditor/reviewer model returned by successful calls; a missing/failed call cannot receive a model attribution.

Report summaries and status docs must:

- name selected routes separately from runtime successes;
- state phase-specific successful call counts before asserting which route performed work;
- identify the expected and actual image paths/hashes for any cross-run comparison;
- state that no model-sensitivity conclusion is available when cohorts are not comparable;
- use immutable commit hashes or `uncommitted` labels, never `this commit` in completed historical entries.

The audited run is described as accounting-complete but not repair-localized. Its runtime evidence is Gemini 3.5 Flash auditor 3/reviewer 0, Mistral 14B auditor 32/reviewer 31, and Mistral 8B auditor 179/reviewer 179. It must not be described as Gemini-completed or as evidence of `139 -> 9` reviewer sensitivity.

## Calorix Reference And Auto-Capture

The current `DEFAULT_CALORIX_EXPECTED_IMAGE` points at the former `reference-images` directory, which no longer exists after the Calorix rename to `reference-images-buggy`. Before changing the default, the implementation owner must inspect the Calorix handoff, `ui-diff.config.json`, file map, and current source-control history with the Calorix owner to select the authoritative Today dark reference. The outcome is either:

1. restore/reintroduce the documented active `reference-images/today--dark.png` asset and retain the documented path; or
2. intentionally promote a new canonical current reference, update the Calorix config and ui-diff-mcp default together, and record its path and content hash.

No silent fallback to `reference-images-buggy`, a live screenshot, or a removed mockup mirror is permitted. `getCalorixExpectedImagePath()` validates existence/readability and gives a precise configuration error before a live run. `UI_DIFF_LIVE_EXPECTED_IMAGE` remains an explicit override. `UI_DIFF_LIVE_ACTUAL_IMAGE` remains historical-override-only; when unset, the gates must continue to ADB auto-capture a fresh actual screenshot.

## Verification And Release Evidence

Unit and e2e coverage must exercise actual-to-comparison projection, edge clipping, disjoint/non-finite/non-positive/reduced-to-1px rejection, no-written-artifact behavior, deterministic hierarchy selection despite input reordering, tight chip and icon-button parenting, overlapping sibling non-parentage, text/icon leaves, known paired/unmatched grounding tokens, preserved `x < y` comparison prose, local-group suppression, runtime aggregate truth, and missing/default Calorix reference behavior.

The release validation run must use fresh auto-capture with `UI_DIFF_LIVE_ACTUAL_IMAGE` unset. Inspect every final-diff artifact listed in its report: every zoom, all group/region/context/hierarchy overlays and legends, plus the report/provider trace. Record run ID, actual/expected paths and hashes, final counts by source/status, rejected-artifact diagnostics, `auditLimited`, `visualClassificationStatus`, selected routes, runtime call-success aggregates, fallback/error summary, and whether inspection was exhaustive. A report can pass production readiness with nonzero final diffs when completeness/integrity conditions hold; visual parity is assessed separately.

## Acceptance Criteria

- No final report location or run-level artifact uses actual-source coordinates on the comparison canvas.
- Invalid or below-minimum crop requests produce a recorded rejection and no 1x1 artifact.
- Hierarchy parent selection is stable under element-order permutation, handles recognized tight compact components through geometric containment, does not parent overlapping siblings, and exposes meaningful text/icon leaves.
- No visible locator label contains paired or unmatched known grounding markup; ordinary comparison/math prose remains intact.
- Numbered repair groups are local and evidence-preserving; broad unresolved evidence is explicit.
- Runtime success data, report fields, and status narrative agree; unsupported sensitivity claims are absent.
- The Calorix default expected source is present, canonical, and validated without weakening auto-capture defaults.
- `npm run verify` passes, relevant live gates are recorded, and the release run's final artifacts are exhaustively inspected.

## External Review Record

Pre-plan Antigravity MCP review was requested on 2026-07-10 with `model:"gemini-3.1-pro-preview"`, `approvalMode:"yolo"`, and conversation `ui-diff-repair-grade-output-design-2026-07-10`. The first request returned `timed out awaiting tools/call after 300s`. The subsequently returned review findings are not green: `MUST_FIX` requires a sanitizer limited to known `<ref>`, `<box>`, and coordinate grounding token families while preserving `x < y` prose, with red Python parser and TypeScript tests; `SHOULD_FIX` requires adaptive compact-component parenting based on recognized role/type plus geometric containment, while ordinary nodes retain the conservative guard, with tight chip/icon-button, overlapping-sibling, and input-order-determinism coverage. These findings are incorporated in this revision. Retry in the same conversation before implementation and retain the conversation ID. A post-implementation review in that conversation is also required; green requires `AGREEMENT_STATUS: agree` and `MUST_FIX: none`.

Main-agent follow-up review was recorded on 2026-07-11 in conversation `risk-first-remediation-plans-2026-07-11` with `model:"gemini-3.1-pro-preview"`. Verdict: `AGREEMENT_STATUS: agree`, `MUST_FIX: none`, `SHOULD_FIX: none`; no MCP response noise. This marks the plan review green and authorizes staged execution beginning with canonical Calorix reference evidence and deterministic ui-diff work; it does not claim implementation.
