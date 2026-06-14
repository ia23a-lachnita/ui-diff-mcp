# Free Model Benchmark Summary

Run `npm run benchmark:models` with `OPENROUTER_API_KEY` and/or `NVIDIA_API_KEY` set to populate `.ui-diff/generated/model-benchmark.json`.

## Latest Results

No benchmark has been run yet. After running, paste a summary here (without secrets or API keys).

## Columns

| Provider | Model | Role | Probe | TTFT (ms) | Notes |
|----------|-------|------|-------|-----------|-------|

## Methodology

- Each eligible free route in `CANONICAL_MODEL_RANKING` is probed once.
- TTFT is measured from request start to first response byte via `Date.now()` diff around the probe call.
- Schema success and UI-diff fixture accuracy are recorded by the probe result (`pass`/`fail`/`not_checked`).
- OpenRouter free calls are throttled to 18 RPM.
- Results are written to `.ui-diff/generated/model-benchmark.json` (excluded from git).
