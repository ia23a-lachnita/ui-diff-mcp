# Locator Resolution And Overlay Validation Results

Date: 2026-07-03

## Summary

`LOCATEANYTHING_MAX_DIMENSION=600` is not a quality default. The live benchmark showed that `900` located more useful expected-screen targets while still completing on this machine. The strict Calorix release gate now passes with `LOCATEANYTHING_MAX_DIMENSION=900`, and the final report records the locator input size in `locatorInputSizing`.

## Locator Benchmark

Command shape:

```powershell
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-07-02-static-scan-fab.png"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
$env:UI_DIFF_LOCATOR_BENCHMARK_DIMENSIONS="600,900,1200"
$env:LOCATEANYTHING_TIMEOUT_MS="600000"
npm run benchmark:locator
```

Results:

| Max dimension | Status | Expected useful | Actual useful | Expected time | Actual time |
| --- | --- | ---: | ---: | ---: | ---: |
| 600 | complete | 74 | 75 | 109.9s | 144.4s |
| 900 | complete | 91 | 80 | 254.4s | 254.3s |
| 1200 | error | - | - | - | - |

Conclusion: use the highest dimension that fits the current sidecar budget. On this machine, the current evidence favors `900` over `600`; `1200` did not complete in the recorded benchmark.

## Verification

Deterministic verification:

```powershell
npm run verify
```

Result: PASS. `561` unit/e2e tests, `16` Python sidecar parser tests, build, and `22` integration tests passed.

MCP live smoke:

```powershell
$env:RUN_UI_DIFF_LIVE="1"
$env:LOCATEANYTHING_MAX_DIMENSION="900"
npm run verify:mcp-live
```

Result: PASS. One live MCP test passed in 94.81s.

Strict Calorix release gate:

```powershell
$env:RUN_CALORIX_RELEASE_LIVE="1"
$env:LOCATEANYTHING_MAX_DIMENSION="900"
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-07-02-static-scan-fab.png"
npm run verify:calorix-release-live
```

Result: PASS. Latest strict run: `run-1783112225975-2d9dcf`.

## Latest Strict Run

- Run ID: `run-1783112225975-2d9dcf`
- Status: `complete`
- `visualClassificationStatus`: `complete`
- `locatorCoverageStatus`: `complete`
- `auditLimited`: `false`
- Final diffs: `46`
- Reviewer statuses: `44 accepted`, `2 not_reviewed`
- Classification sources: `44 vlm_reviewed`, `2 deterministic_projected_mismatch`
- Criteria: `14 geometry`, `14 spacing_alignment`, `10 color_appearance`, `3 chart_special_geometry`, `2 typography_content`, `1 presence`, `1 layering_clipping`, `1 icon_image`
- Duplicate final findings by release-gate rule: `0`
- Audit scope: `82` VLM-audited pairs, `7` deterministic pre-audit pairs, `0` failed pairs, `0` remaining pairs, stopped reason `none`
- Locator sizing: expected source `1206x2622`, sent to locator as `414x900`, scale `0.34324942791762014`, mode `single_pass_projected_actual`

Model routes:

- Auditor: `mistral/ministral-14b-2512`, free
- Reviewer: `mistral/ministral-14b-2512`, free
- Target recovery: `mistral/ministral-14b-2512`, free
- Fallback routes available: `mistral/ministral-8b-2512`, `opencode/mimo-v2.5-free`

Provider behavior:

- Provider calls: `512` success, `2` errors, `2` fallbacks, `0` route exhaustion
- Usage: `868817` input tokens, `54172` output tokens, `922989` total tokens
- Missing usage calls: `0`
- Total-only usage calls: `0`

## Artifact Validation

Inspected artifacts:

- `final-diff-groups-overlay.png`
- `final-diff-groups-legend.json`
- `final-diff-zoom-003.png`
- `final-diff-zoom-004.png`

The overlay now separates localized groups from screen-wide findings. The latest legend contains `8` groups. Localized groups are visible for the calorie ring, macro rows, meal card, and scan/nav area. This resolves the earlier failure mode where one full-screen green group swallowed nearly every finding and made the overlay unreadable.

Visual validation scope: sampled. The release gate verified structural invariants and duplicate-free final reports automatically; the listed overlay artifacts were manually inspected, but every crop/diff artifact was not exhaustively reviewed by a human.

