# Semantic hierarchy repair-grade fix

Date: 2026-07-08
Status: plan for review, then execution
Task (from `docs/implementation-status.md`): clean raw model text out of semantic hierarchy node labels and fix the hierarchy collapsing to Screen → one full-screen node.

## Evidence (run-1783357783765-ddee78)

- `semantic-hierarchy-legend.json` contains exactly two nodes: `Screen` and one full-screen `button` node labeled `tate</ref> buttons and tappable controls`.
- Report `locatorMetadata.expected.queryCounts`: `text_labels: 28, cv_components: 29, icons: 5` (+ merged lanes) — the buttons/cards/nav/list/image lanes contributed no usable expected elements; the single surviving semantic-typed element is a junk-labeled, near-full-screen box.

## Root causes

1. **Label leak** — `sidecars/locateanything/parser.py` `BOX_PATTERN` uses a lazy `<ref>(?P<label>.*?)</ref>\s*<box>` group. Lazy matching still expands **past an inner `</ref>`** when the first `</ref>` is not directly followed by `<box>` (malformed/nested model grounding), so labels can swallow raw `</ref>` fragments. The TS-side `normalizeElementLabel` only rewrites pure digits and `locate ` prefixes, so the junk survives into hierarchy nodes.
2. **Collapse** — `buildSemanticHierarchy` filters to `SEMANTIC_ELEMENT_TYPES` (card/chart/nav/list_item/button/image). On this screen those lanes are empty or degenerate, while real structure (29 `cv_components` containers + 28 texts + 5 icons with computed `parentId`/`childIds` containment) is discarded. A near-full-screen element also duplicates `Screen` and adds no structure.

## Changes

1. `sidecars/locateanything/parser.py`
   - Restrict the label group so it can never span ref tokens: `(?:<ref>(?P<label>(?:(?!</?ref>).)*?)</ref>)?`.
   - Post-sanitize labels: strip residual `<ref>`, `</ref>`, `<box>…</box>`, `<123>` coordinate tokens; collapse whitespace; empty result falls back to `query_id` (existing behavior).
2. `src/locator/element-map.ts` — harden `normalizeElementLabel` as the second net: strip the same model-token family; if the raw label contained ref/box tokens or is empty after cleaning, fall back to `${type}-${queryId}-${index}`.
3. `src/report/context-overlays.ts` — make `buildSemanticHierarchy` structure-aware:
   - Node set = semantic-typed elements **plus container elements of any type with ≥ 2 contained children** (per `buildElementMap` containment), so cv-component sections/cards form the skeleton.
   - Skip degenerate near-full-screen elements (≥ 85% of image area) as nodes — they duplicate `Screen`; their children re-parent upward.
   - Parent resolution walks the `parentId` chain to the nearest ancestor that is itself a hierarchy node (was: nearest semantic-typed ancestor), else `Screen`.
4. Tests (red → green):
   - `sidecars/locateanything/test_parser.py`: malformed multi-`</ref>` answer yields a token-free label; sanitizer cases.
   - `tests/unit/element-map.test.ts`: `normalizeElementLabel` strips tokens and falls back on junk.
   - `tests/unit/context-overlays.test.ts`: full-screen node skipped with children re-parented to screen; non-semantic container with ≥2 children becomes a node; nested parenting via mixed-type ancestors.

## Verification

- `npm run test:sidecar` (python parser suite) and `npm run verify` (unit/e2e + sidecar parser + build + integration).
- Live gates: `verify:calorix-release-live` is the true end-to-end proof but costs ~16 min + provider quota; run if quota/sidecar allow, else record the exact blocker and rely on the unit/e2e evidence plus a fixture-based hierarchy regeneration.
- Update `docs/implementation-status.md`, commit, push.

## Out of scope

- Prompt/model changes to make the buttons/cards lanes return richer grounding (provider-behavior tuning, tracked separately).
- The 2.16% viewport aspect mismatch and provider quota follow-ups (existing open blockers).
