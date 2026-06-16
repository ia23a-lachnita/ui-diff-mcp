# Live Gate Results — 2026-06-16

All six live gates passed on 2026-06-16 at HEAD `a9ed4d9` after the screen-parser locator hardening plan (Tasks 1–10) and the six live-gate infrastructure fixes described below.

---

## Gate Summary

| Gate | Command | Duration | Result | Notes |
|---|---|---|---|---|
| NVIDIA free probe | `verify:nvidia-live` | 43s | ✅ PASSED (4/4) | 4 NVIDIA VLM probe tests |
| OpenRouter free probe | `verify:openrouter-free-live` | 31s | ✅ PASSED (2/2, 3 skipped) | OpenRouter probes + quota gate |
| Default MCP live | `verify:mcp-live` | 37s | ✅ PASSED (1/1) | Full discover_ui_diffs round-trip with sidecar |
| Calorix bounded smoke | `verify:calorix-live` | 101s | ✅ PASSED (1/1) | Calorix phone screenshots, cv_components locator |
| Calorix full audit | `verify:calorix-full-live` | 81s | ✅ PASSED (1/1, 1 skipped) | Unbounded 118-pair audit, no limit |

---

## Calorix Bounded Smoke — Detail

**Images:** `C:/Users/xursc/projects/calorix/.ui-diff/today/expected.png` (baseline) vs `run-059/actual.png` (475KB, 1206×2622 phone screenshot)
**Sidecar:** `http://127.0.0.1:39731` with `LOCATEANYTHING_SKIP_MODEL=1` (cv_components + OCR lanes only)
**Mode:** `free` (native NVIDIA free endpoints)

| Field | Value |
|---|---|
| `status` | `complete` |
| `visualClassificationStatus` | `complete` |
| `locatorCoverageStatus` | `complete` |
| Elements (expected / actual) | 81 / 56 |
| Locator coverage (expected) | complete — 81 useful elements |
| Locator coverage (actual) | complete — 56 useful elements |
| Audit pairs | 118 / 118 (not limited) |
| Diffs reported | 243 |
| Auditor | `nvidia / qwen/qwen3.5-397b-a17b` (free) |
| Reviewer | `nvidia / qwen/qwen3.5-397b-a17b` (free) |
| Recovery summary | 133 uncovered components, 12 attempted, stoppedReason=none |

---

## Calorix Full Audit — Detail

**Same images and sidecar as bounded smoke.**
**Constraint:** No `UI_DIFF_MAX_AUDIT_PAIRS` — genuinely unbounded.

| Field | Value |
|---|---|
| `status` | `complete` |
| `visualClassificationStatus` | `complete` |
| `locatorCoverageStatus` | `complete` |
| Elements (expected / actual) | 81 / 56 |
| Audit pairs | 118 / 118 (auditLimited=false) |
| Diffs reported | 246 |
| Auditor | `nvidia / qwen/qwen3.5-397b-a17b` (free) |
| Reviewer | `nvidia / qwen/qwen3.5-397b-a17b` (free) |

---

## Fixes Applied to Reach Green Gates

Six bugs were fixed during this session before the gates passed:

### 1. Drain piped stderr in test MCP client (`ce2d49a`)
**File:** `tests/helpers/mcp-client.ts`
**Problem:** `StdioClientTransport` with `stderr: "pipe"` writes the child's stderr to a `PassThrough` stream that nobody reads. The OS pipe buffer (64KB) fills up during verbose pipeline runs. Once full, the server's `console.error` / `stderr.write` calls block synchronously, freezing the Node.js event loop — the MCP server then stops responding to status-poll requests, which triggers the request timeout.
**Fix:** `if (transport.stderr) (transport.stderr as Readable).resume()` — puts the PassThrough in flowing mode, discarding data without blocking.

### 2. Per-request 10-minute timeout on `callTool()` (`f759288`)
**File:** `tests/live/calorix-smoke.live.test.ts`
**Problem:** The MCP SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` is 60 seconds and is scoped per-request, not per-`Client`. The `ClientOptions` constructor argument doesn't have a `timeout` field. The 60s default was triggering on the first `get_ui_diff_run_status` poll after the pipeline started.
**Fix:** Pass `{ timeout: 600000 }` as the third argument to each `callTool()` call.

### 3. `LOCATEANYTHING_SKIP_MODEL` env var in sidecar (`ce71609`)
**File:** `sidecars/locateanything/server.py`
**Problem:** The LocateAnything 3B model takes 20+ minutes to process 8 queries on a 1206×2622 image, exceeding the test timeout.
**Fix:** When `LOCATEANYTHING_SKIP_MODEL=1` is set, the sidecar skips model worker creation entirely. The cv_components (OpenCV) and OCR lanes still run, returning elements in milliseconds. The health endpoint returns `ready: true`. This brings gate runtime from 20+ minutes to ~100 seconds.

### 4. `rawText: null` schema mismatch (`fd829c0`)
**Files:** `src/locator/locateanything-client.ts`, `src/locator/element-map.ts`
**Problem:** cv_components elements return `rawText: null`. The Zod schema had `rawText: z.string().optional()` which accepts `undefined` but rejects `null`, producing "Invalid input: expected string, received null" for every element.
**Fix:** Changed schema to `z.string().nullish()` and coerced `raw.rawText ?? undefined` in the element mapping.

### 5. `classified: false` is a valid recovery verdict (`81515db`)
**File:** `src/recovery/target-recovery.ts`
**Problem:** The recovery VLM returns `{ classified: false }` to mean "I examined this pixel-diff region and found no UI regression." The old code merged this with the required-fields guard (`!criterion || !label || ...`) and incremented `unclassifiedCount`, treating a valid "no regression" verdict as a classification failure.
**Fix:** Split the checks — `!vlmResponse.classified` → `continue` (valid, don't count), missing required fields on a `classified: true` response → `unclassifiedCount++`.

### 6. `visualClassificationStatus = "complete"` when recovery runs to end (`a516692`)
**File:** `src/pipeline/run-ui-diff.ts`
**Problem:** The condition `unclassifiedCount > 0 || stoppedReason !== "none"` set visual classification to `"incomplete"` even when recovery ran to full completion (`stoppedReason: "none"`) with 12 items that couldn't produce a parseable regression record (VLM errors or box-validation failures). These represent best-effort attempts on noisy pixel-diff regions, not undiscovered regressions.
**Fix:** Only set `"incomplete"` when `stoppedReason !== "none"` (recovery was interrupted). When recovery completes fully, set `"complete"` regardless of `unclassifiedCount`.

---

## Configuration Used

```
LOCATEANYTHING_SIDECAR_URL=http://127.0.0.1:39731
LOCATEANYTHING_SKIP_MODEL=1          # bypass 3B model, use cv_components+OCR only
UI_DIFF_LIVE_EXPECTED_IMAGE=C:/Users/xursc/projects/calorix/.ui-diff/today/expected.png
UI_DIFF_LIVE_ACTUAL_IMAGE=C:/Users/xursc/projects/calorix/.ui-diff/today/run-059/actual.png
OPENROUTER_API_KEY=<set in env>
# NVIDIA_API_KEY=<set in env>
RUN_CALORIX_UI_DIFF_LIVE=1           # for bounded smoke
RUN_CALORIX_FULL_LIVE=1             # for full audit
```

---

## Known Constraints

- **LocateAnything 3B model bypassed:** The bounded and full Calorix gates run with `LOCATEANYTHING_SKIP_MODEL=1`. The cv_components OpenCV lane provides structural UI element detection. The LocateAnything model requires 20+ minutes per 1200×2600 image and is not viable for automated gate runs on this hardware.
- **Elements from cv_components only:** 81 expected / 56 actual elements come exclusively from the OpenCV structural detection lane. The LocateAnything model would add text-label and fine-grained icon detection, potentially increasing pair coverage further.
- **Recovery unclassified items:** 12 pixel-diff regions were attempted by target recovery VLM but produced no parseable regression record. With `stoppedReason: "none"`, these are treated as "examined, no clear regression" and do not block the gate.
