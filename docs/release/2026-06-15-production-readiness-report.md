# Production Readiness Report — 2026-06-15

**Prepared by:** automated live-gate run  
**HEAD commit:** `7ab7733` — docs: record last run readiness review  
**Run date/time:** 2026-06-15T16:54Z  
**Purpose:** Fresh gate execution for formal release sign-off decision

---

## Summary

The hardened live gate suite (8 hardening tasks, all merged to master) passed all deterministic
and provider-facing gates. The Calorix end-to-end gate **failed** because the LocateAnything
sidecar returned `locatorCoverageStatus: "weak"` on the real-world Calorix UI screenshots.
This failure is a **true quality signal** — the gate is doing exactly what it was hardened to
do. A release tag should not be cut until weak locator coverage on real UI images is resolved.

---

## Gate-by-Gate Results

| # | Gate | Command | Duration | Result | Notes |
|---|------|---------|---------|--------|-------|
| 1 | Deterministic verify | `npm run verify` | ~45 s | **PASS** | 241 unit/e2e + 22 integration tests, typecheck clean, build clean, 10 sidecar parser tests |
| 2 | Coverage | `npm run test:coverage` | ~15 s | **PASS** | Stmts 85.36% / Branches 71.37% / Funcs 87.95% / Lines 87.09% — all above thresholds |
| 3 | NVIDIA free live | `verify:nvidia-live` | 59.8 s | **PASS** | 4/4 probes passed |
| 4 | OpenRouter free live | `verify:openrouter-free-live` | 88.3 s | **PASS** | 2/2 tests passed, 3 skipped (paid routes correctly excluded) |
| 5 | Default MCP live | `verify:mcp-live` | 180.6 s | **PASS (retry)** | 1/1 passed. First attempt failed: sidecar was cold, 240 s foreground budget exhausted before pipeline completed. Retry with warm sidecar succeeded in 181 s. |
| 6 | Calorix bounded smoke | `verify:calorix-live` (MAX_AUDIT_PAIRS=3) | 672 s | **FAIL** | `locatorCoverageStatus: "weak"` — gate correctly rejected the report |
| 7 | Calorix full audit | `verify:calorix-full-live` | not run | **SKIP** | Not executed: bounded smoke already failed with the same root cause; running the unbounded gate would duplicate the finding at ~10× cost |

---

## Findings

### F1 — Calorix locator coverage is weak on real UI images (Blocker)

**Gate:** Calorix bounded smoke (gate 6)  
**Assertion failed:** `locatorCoverageStatus` must not match `^(failed|weak)$`  
**Received:** `"weak"`

The LocateAnything sidecar returned elements for fewer than 75% of the prompt query IDs
sent during element discovery (`computeLocatorCoverageStatus` in `src/locator/element-map.ts`
line 172: `queryIds.size >= promptCount * 0.75` → `"complete"`, else → `"weak"`). Coverage
is query-ID-based, not pixel-area-based. This is a recurring pattern — the previously
persisted Calorix run (`run-1781530941630-a2ada2`) also produced `"weak"`.

**Impact:** Any real-world UI diff run on complex application screens will produce weak or
incomplete locator results. The pipeline handles this gracefully (it still outputs diffs), but
the hardened test gate deliberately treats weak coverage as a release blocker because undetected
elements cannot be classified or reviewed.

**Root causes to investigate:**
- LocateAnything model confidence threshold may be too high for dense UI screenshots,
  causing many query prompts to return zero hits
- The `today/expected.png` and `today/actual.png` Calorix images may have more UI density
  or element categories than the model was fine-tuned on
- The set of locator query prompts may not match the element vocabulary present in the images

**Required before release:**
- Tune or replace the locator strategy for dense UI screens, or
- Document that weak coverage on dense UIs is an accepted limitation with explicit gate relaxation

### F2 — MCP live foreground budget is sensitive to sidecar cold-start (Low risk)

**Gate:** Default MCP live (gate 5, first attempt)  
**Observation:** `UI_DIFF_FOREGROUND_BUDGET_MS=240000` is exhausted when the sidecar is cold.
Pipeline takes ~180 s when the sidecar is warm, but exceeded 240 s on first attempt.

**Impact:** In production, if the sidecar is restarted and a `discover_ui_diffs` call arrives
immediately, the foreground budget may fire before the pipeline completes. The call returns
`diffCount=0` (structured-incomplete) rather than a full result. The async handle pattern
(`start_ui_diff_run` / `get_ui_diff_run_status`) is the correct path for long runs and is
not affected by this.

**Mitigation in place:** Async run handle tools (Task 7) are available and tested. The
`discover_ui_diffs` synchronous path is a convenience shortcut with a documented budget.

**Recommended:** Increase default `UI_DIFF_FOREGROUND_BUDGET_MS` to at least 300 s, or
document that callers must use the async handle pattern when sidecar cold-start is possible.

### F3 — Known architecture risk: union-box geometry coverage (Accepted)

**Status:** Documented in implementation status; no new gate failure this run.

Deterministic geometry diffs use a union bounding box over matched element pairs. Pixel
changes inside the union box but outside individual element shapes are included in the
geometry diff's coverage, potentially masking unrelated nearby changes until shape-aware
coverage is implemented.

---

## Provider Health (from live runs)

| Provider | Role | Status |
|----------|------|--------|
| NVIDIA native (Kimi K2.6, Nemotron-nano) | Auditor + Reviewer | Available, 4/4 probes passed |
| OpenRouter free (auditor + reviewer routes) | Auditor + Reviewer | Available, 2/2 passed |
| OpenRouter paid routes | Paid mode only | Not tested (paid mode not enabled) |

Both NVIDIA native and OpenRouter free routes are currently serving. Default free-mode
pipeline selects NVIDIA or OpenRouter depending on probe results at runtime.

---

## Coverage Snapshot

| Metric | Value | Threshold | Status |
|--------|-------|-----------|--------|
| Statements | 85.36% | 85% | PASS |
| Branches | 71.37% | 70% | PASS |
| Functions | 87.95% | 85% | PASS |
| Lines | 87.09% | 85% | PASS |

---

## Release Recommendation

**NOT READY for production release tag at HEAD `7ab7733`.**

The codebase, deterministic test suite, coverage thresholds, and provider live probes are
all green. The blocker is F1: the LocateAnything sidecar produces weak element coverage on
real application screenshots, and the hardened Calorix gate correctly rejects the result.

**To reach release readiness:**
1. Resolve F1 (locator strategy for dense UIs) and pass `verify:calorix-live` and
   `verify:calorix-full-live` on the Calorix image pair without weak coverage
2. Resolve F2: increase the default foreground budget to ≥300 s or add explicit sidecar
   warm-up documentation (required per external reviewer, not optional)

**Subsystems with passing gates (not a partial sign-off — release remains blocked by F1):**
- The MCP tool API surface (all 7 tools: `compare_ui_images`, `discover_ui_diffs`, `ui_diff_model_health`, `read_ui_diff_report`, `capture_mobile_screen`, `start_ui_diff_run`, `get_ui_diff_run_status`)
- Deterministic geometry diff generation
- Free-mode model selection (NVIDIA + OpenRouter fallback)
- Report schema, checkpoint writes, async run handle
- Path traversal security guard in `getRun()`
- All unit/integration test gates and coverage thresholds

---

## Screen Parser Hardening Plan — Implementation Complete (2026-06-15)

**HEAD at time of implementation:** `42ae4fc` — chore: add locator lane benchmark

All 10 tasks from `docs/superpowers/plans/2026-06-15-screen-parser-locator-hardening.md` are implemented and merged to master. The implementation replaces the LocateAnything-only discovery path with a multi-lane screen parser.

### Deterministic Gates at HEAD

| Gate | Result |
|------|--------|
| `npm run verify` (unit + integration + sidecar + build) | **PASS** — 22 integration tests, 14 sidecar tests, typecheck clean |
| `npm run test:coverage` | **PASS** — Stmts 85.4% / Branches 71.42% / Funcs 87.56% / Lines 87.45% |

### What Changed

- **CV lane (always-on):** OpenCV Canny + morphological closing detects non-text component boxes on every sidecar call. Catches cards, buttons, and UI regions the grounding model misses.
- **OCR lane boundary:** Adapter is wired; production deploys enable Tesseract or PaddleOCR via `detect_ocr_text()`.
- **OmniParser lane (optional):** Enabled via `UI_DIFF_ENABLE_OMNIPARSER=1`. AGPL license gate documented.
- **YOLO UI lane (optional):** Enabled via `UI_DIFF_YOLO_UI_MODEL_PATH`. Rico+WebUI model support.
- **NMS:** `suppressDuplicateElements()` merges overlapping boxes from multiple lanes with `+`-joined `queryId` provenance.
- **Per-image coverage:** `computeImageLocatorCoverage()` gates on both expected and actual images independently; giant boxes rejected; weak status requires 12+ useful elements and 75%+ query coverage.
- **Target-map artifacts:** `target-map-expected.json` and `target-map-actual.json` written per run; live gates assert their presence.
- **Sidecar warmup:** `UI_DIFF_SIDECAR_WARMUP=1` fires a tiny-PNG request before live gate test to prevent cold-start timeouts.

### Live Gates Pending

The Calorix bounded and full live gates must be re-run with the new multi-lane sidecar to confirm F1 (weak locator coverage) is resolved. The deterministic CV lane should materially increase element count on dense UI screenshots. Run:

```powershell
$env:RUN_CALORIX_UI_DIFF_LIVE="1"
$env:UI_DIFF_SIDECAR_WARMUP="1"
npm run verify:calorix-live

$env:RUN_CALORIX_FULL_LIVE="1"
npm run verify:calorix-full-live
```

**Release remains blocked until both Calorix gates pass at HEAD.**
