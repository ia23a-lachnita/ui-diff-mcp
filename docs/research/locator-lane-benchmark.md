# Locator Lane Benchmark

**Generated:** 2026-07-03T19:19:02.959Z
**Sidecar:** http://127.0.0.1:39731
**Expected:** C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png
**Actual:** C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-07-02-static-scan-fab.png
**Conclusion:** complete

Trials are executed sequentially so local sidecar CPU/GPU contention does not distort elapsed times.

## Dimension Summary

| Max Dimension | Status | Expected Time | Actual Time | Expected Useful | Actual Useful | Error |
|---------------|--------|---------------|-------------|-----------------|---------------|-------|
| 600 | complete | 109.9s | 144.4s | 74 | 75 | none |
| 900 | complete | 254.4s | 254.3s | 91 | 80 | none |
| 1200 | error | - | - | - | - | Sidecar request failed: fetch failed |

## Stability Compared To Largest Completed Dimension

| Max Dimension | Compared To | Expected Missing | Actual Missing | Expected Extra | Actual Extra |
|---------------|-------------|------------------|----------------|----------------|--------------|
| 600 | 900 | 71 | 61 | 54 | 57 |

## Per-Dimension Details

### 600px

| Image | Useful Elements | Query Coverage Ratio | Query Counts |
|-------|----------------|----------------------|--------------|
| expected | 74 | 0.88 | `{"text_labels":16,"icons+text_labels":7,"cv_components+text_labels":1,"buttons":19,"icons":5,"cv_components+icons":1,"cv_components":25}` |
| actual | 75 | 1.25 | `{"text_labels":9,"buttons+text_labels":4,"icons+text_labels":8,"buttons+icons+text_labels":4,"cv_components+text_labels":1,"buttons":8,"buttons+cv_components":1,"icons":16,"cv_components+icons":3,"cv_components":21}` |

### 900px

| Image | Useful Elements | Query Coverage Ratio | Query Counts |
|-------|----------------|----------------------|--------------|
| expected | 91 | 1.00 | `{"buttons+icons+text_labels":4,"icons+text_labels":1,"text_labels":12,"cv_components+text_labels":1,"buttons+text_labels":6,"icons":5,"charts_indicators":16,"cv_components":46}` |
| actual | 80 | 1.00 | `{"icons+text_labels":3,"cv_components+icons+text_labels":3,"cv_components+text_labels":14,"text_labels":3,"buttons":11,"icons":5,"charts_indicators":3,"cv_components":38}` |

### 1200px

Status: `error`

Error: Sidecar request failed: fetch failed


## Interpretation

`600` is a local timeout workaround, not a production-quality default. Prefer the highest dimension that fits the sidecar budget, and use this benchmark to decide whether the quality/runtime trade-off is acceptable on the current machine.
