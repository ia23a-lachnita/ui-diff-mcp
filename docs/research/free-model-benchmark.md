# Free Model Benchmark Summary

Run `npm run benchmark:models` with `OPENROUTER_API_KEY` and/or `NVIDIA_API_KEY` set to populate `.ui-diff/generated/model-benchmark.json`.

## Latest Results

No benchmark has been run yet. After running, paste a summary here (without secrets or API keys).

## Columns

| Provider | Model | Role | Probe | TTFT (ms) | tok/s | Schema | Notes |
|----------|-------|------|-------|-----------|-------|--------|-------|

## Candidate Sources

Candidates come from `CANONICAL_MODEL_RANKING` in `src/models/model-registry.ts`. Each entry lists eligible free provider routes and cost class. The ranking is a quality/probe order, not a static speed ranking — speed is measured at probe time.

### Native NVIDIA Free Endpoints

Probed when `NVIDIA_API_KEY` is set. Default base URL: `https://integrate.api.nvidia.com/v1`.

| Rank | Model | Notes |
|-----:|-------|-------|
| 1 | `moonshotai/kimi-k2.6` | Top native NVIDIA free route. |
| 2 | `minimaxai/minimax-m3` | Non-commercial license — blocked in commercial contexts. |
| 3 | `mistralai/mistral-large-3-675b-instruct-2512` | Native NVIDIA only; paid on OpenRouter. |
| 4 | `qwen/qwen3.5-397b-a17b` | Heavy; speed measured at probe time. |
| 5 | `qwen/qwen3.6-35b-a3b` | NIM/self-host or configured endpoint candidate. |
| 6 | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | Strong recovery candidate. |
| 7 | `meta/llama-3.2-90b-vision-instruct` | Reviewer candidate after stronger general multimodal routes. |
| 8 | `meta/llama-3.2-11b-vision-instruct` | Crop-level candidate after stronger routes. |
| 9 | `nvidia/nemotron-nano-12b-v2-vl` | Lightweight VL candidate after stronger routes. |
| 10 | `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` | Crop-level candidate after stronger routes. |
| 11 | `nvidia/cosmos3-nano-reasoner` | Target-recovery candidate. |
| 12 | `google/google-paligemma` | Last NVIDIA candidate if it passes UI-diff probes. |

### OpenRouter Free Routes

Probed when `OPENROUTER_API_KEY` is set. Only `:free` slugs are eligible in `free` and `free_openrouter` modes.

| Rank | Model | Notes |
|-----:|-------|-------|
| 1 | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | Free image-capable route from OpenRouter Models API. |
| 2 | `nex-agi/nex-n2-pro:free` | Free image-capable route from OpenRouter Models API. |
| 3 | `google/gemma-4-31b-it:free` | Free image-capable route from OpenRouter Models API. |
| 4 | `google/gemma-4-26b-a4b-it:free` | Free image-capable route from OpenRouter Models API. |
| 5 | `nvidia/nemotron-nano-12b-v2-vl:free` | Lightweight free image-capable route after stronger routes. |

OpenRouter Models API check on 2026-06-14 did not list `moonshotai/kimi-k2.6:free`. It listed `moonshotai/kimi-k2.6` as a paid image-capable route, so Kimi is only a free route through native NVIDIA in this project.

## Methodology

- Each eligible free route in `CANONICAL_MODEL_RANKING` is probed once.
- TTFT is measured from request start to first token via `Date.now()` around the probe call.
- Schema success: `pass` = strict JSON schema response valid; `fail` = malformed or schema-violating response.
- UI-diff fixture accuracy: auditor correctly identifies expected vs actual order and crop-level change.
- OpenRouter free calls are throttled to 18 RPM (below the 20 RPM hard limit).
- NVIDIA free endpoint limits are measured from live responses and key-specific headers.
- Results are written to `.ui-diff/generated/model-benchmark.json` (excluded from git).
- A `minimaxai/minimax-m3` pass result is marked `commercial_blocked: true` when only non-commercial NVIDIA terms apply.
