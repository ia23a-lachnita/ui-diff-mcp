# ui-diff-mcp

MCP server for comparing mobile app screenshots against mockup designs using free-first visual model diffing. Calorix is the primary integration target.

Design spec: `docs/superpowers/specs/2026-06-12-ui-diff-mcp-research-design.md`

## Free-First Default

The default mode (`free`) never calls paid OpenRouter routes. It probes direct Gemini routes first, then direct Mistral routes, OpenCode Zen's image-capable `mimo-v2.5-free`, native NVIDIA free VLM endpoints, and finally OpenRouter `:free` routes. Every route must pass the role's real image-count and JSON probe before selection. Paid OpenRouter models are disabled unless `mode: "paid"` is passed and `UI_DIFF_ENABLE_PAID_MODE=1` is set.

OpenCode currently also lists `deepseek-v4-flash-free`, but its model metadata is text-only. It is intentionally excluded from auditor, reviewer, and target-recovery roles because those roles require four or five crop images. OpenCode documents its free models as limited-time routes, so catalog presence never replaces runtime probes.

Gemini model-list probing on this machine showed `gemini-3.1-pro-preview`, `gemini-3.5-flash`, and `gemini-3.1-flash-lite` are visible. A direct live call to `gemini-3.1-pro-preview` returned free-tier quota limit 0, so it remains first in the quality ranking but is expected to fail closed unless quota is available. `gemini-3.5-flash` is the current direct Gemini live-gate model.

Mistral model-list probing showed vision-capable routes including `mistral-large-2512`, `mistral-medium-2604`, `mistral-small-2603`, `ministral-14b-2512`, and `ministral-8b-2512`. Live role probing on this machine showed `ministral-14b-2512` and `ministral-8b-2512` correctly handle the five-image payload required by auditor/reviewer/recovery. `mistral-large-2512`, `mistral-medium-2604`, and `mistral-small-2603` miscounted or misclassified simple probe images, so they are not current pipeline routes.

Before starting a free-model run, the pipeline estimates the required request count and checks available quota against the OpenRouter key info endpoint. If estimated calls exceed available free quota, the run exits immediately with `status: "insufficient_free_quota"` rather than consuming quota silently.

## Modes

`mode` selects the provider/model route policy. It does not select how much of the UI to inspect.

| Mode | Behavior |
| --- | --- |
| `free` | Default. Gemini direct, Mistral direct, OpenCode MiMo, NVIDIA free endpoints, then OpenRouter `:free`. Never paid OpenRouter. |
| `free_gemini` | Only direct Gemini routes. Current live gate uses `gemini-3.5-flash`. |
| `free_mistral` | Only direct Mistral routes. Current live gate uses `ministral-14b-2512`. |
| `free_opencode` | Only OpenCode Zen visual routes. Currently `mimo-v2.5-free`. |
| `free_openrouter` | Only OpenRouter `:free` routes. |
| `free_nvidia` | Only native NVIDIA free endpoint routes. |
| `paid` | Explicit opt-in requiring `UI_DIFF_ENABLE_PAID_MODE=1`. Records paid model use in `report.json`. |
| `deterministic_only` | No VLM calls. Returns deterministic signal evidence only. |

## Diff Scopes

Use `diffScope` to select the visual scope independently from provider `mode`.

```json
{ "kind": "screen" }
```

Audits the whole screen first: global placement, major color/appearance changes, broad shape/border/layer differences, and whole-screen diff masks. Target-level recovery is bypassed.

```json
{ "kind": "regions", "regions": ["top", "nav"] }
```

Audits only selected deterministic regions. Current region names are `top`, `middle`, `bottom`, `header`, `content`, and `nav`. Target recovery is restricted to uncovered components inside the selected regions.

```json
{ "kind": "target", "query": "scan button" }
```

Resolves a target by locator label, visible text, and element type, then audits only the best matching pair. If the target cannot be resolved, the report includes a warning and does not pretend the target was checked.

```json
{ "kind": "full" }
```

Default. Runs screen/region summaries, scope-level VLM audit where deterministic triggers fire, and the existing target-level audit/recovery path.

Example MCP payload:

```json
{
  "expectedImagePath": "C:/mockups/Today.png",
  "actualImagePath": "C:/screenshots/today.png",
  "mode": "free",
  "diffScope": { "kind": "regions", "regions": ["nav"] }
}
```

## Artifacts As Machine Evidence

All generated images (pixel diff, directional overlay, crop pairs, recovery crops) are machine evidence consumed by audit and recovery models. They are not a manual inspection workflow. Do not rely on visual artifact review as a substitute for structured `report.json` output.

## Report Parts And Usage Accounting

`report.json` is the slim manifest. Large report sections are written as referenced JSON parts under `artifacts/parts/` instead of being duplicated inline:

- `elements.json`
- `pairs.json`
- `diffs.json`
- `unresolved-regions.json`
- `debug-summary.json`
- `usage-summary.json`
- `scope-summary.json`

`reportParts[].path` is relative to the `report.json` directory. `read_ui_diff_report` hydrates these parts before returning the report, so existing MCP consumers still receive a full schema-valid report even though the on-disk manifest keeps `elements`, `pairs`, `diffs`, and unresolved regions compact.

`usageSummary` is first-class run-level accounting. It records input tokens, output tokens, total tokens, reasoning tokens, successful calls, failed calls, fallbacks, route exhaustion, and duration totals by phase, role, and provider/model route. If a provider reports only total tokens, input/output are left as zero and `totalOnlyUsageCalls` increments; the MCP does not invent a fake split.

## LocateAnything Live Gate Sizing

`LOCATEANYTHING_MAX_DIMENSION` controls the largest image dimension sent to the LocateAnything sidecar. The default remains `1200` for detail.

`600` is a local timeout workaround, not a quality default. It shrinks a `1206x2622` Calorix mockup to roughly `276x600` for the locator, which can hide small icons, thin borders, and text. Prefer the highest dimension that fits the sidecar budget, and run the sequential locator benchmark before production sign-off:

```powershell
$env:UI_DIFF_LIVE_EXPECTED_IMAGE = "C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE = "C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-07-02-static-scan-fab.png"
$env:LOCATEANYTHING_SIDECAR_URL = "http://127.0.0.1:39731"
$env:UI_DIFF_LOCATOR_BENCHMARK_DIMENSIONS = "600,900,1200"
npm run benchmark:locator
```

Every report records `locatorInputSizing`, including original image size, sent image size, scale, `maxDimension`, and whether actual elements were independently located or projected from expected elements. Runs also save the exact image payloads sent to the sidecar as `locator-input-expected.png` and, in dual-locator mode, `locator-input-actual.png`; these appear in `runArtifacts` as `locator_input_expected` and `locator_input_actual`.

## Installation

```bash
npm install
```

## Verification

```bash
npm run verify
```

## Build

```bash
npm run build
```

## Running the server

```bash
node dist/src/index.js
```

## Environment Variables

Copy `.env.example` and fill in the relevant keys.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPENCODE_API_KEY` | No | `public` | Optional OpenCode Zen credential override. The current free route accepts the public credential. |
| `OPENCODE_ZEN_BASE_URL` | No | `https://opencode.ai/zen/v1` | OpenCode Zen API base URL. |
| `GEMINI_API_KEY` | For Gemini direct mode | — | Gemini API key from AI Studio. Routes are always probe-gated because visible models may have zero free-tier quota. |
| `GEMINI_BASE_URL` | No | `https://generativelanguage.googleapis.com/v1beta` | Override Gemini API base URL. |
| `MISTRAL_API_KEY` | For Mistral direct mode | — | Mistral API key for direct vision routes. |
| `MISTRAL_BASE_URL` | No | `https://api.mistral.ai/v1` | Override Mistral API base URL. |
| `OPENROUTER_API_KEY` | For OpenRouter free mode | — | OpenRouter API key. Free-tier account sufficient for `:free` routes. |
| `NVIDIA_API_KEY` | For NVIDIA free mode | — | NVIDIA Build/NIM API key for native NVIDIA free VLM endpoints. |
| `NVIDIA_VLM_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | Override NVIDIA base URL for self-hosted NIM. |
| `UI_DIFF_ENABLE_PAID_MODE` | For paid mode only | — | Must be exactly `1` before `mode: "paid"` can use paid routes. |
| `LOCATEANYTHING_SIDECAR_URL` | No | `http://127.0.0.1:39731` | URL of the LocateAnything sidecar. |
| `LOCATEANYTHING_EAGLE_EMBODIED_DIR` | For local sidecar only | — | Path to Eagle Embodied install. |
| `LOCATEANYTHING_IN_TOKEN_LIMIT` | No | `4096` | Image token budget for local sidecar. |
| `LOCATEANYTHING_GENERATION_MODE` | No | `hybrid` | Sidecar worker mode: `fast`, `slow`, or `hybrid`. |
| `LOCATEANYTHING_MAX_NEW_TOKENS` | No | `512` | Sidecar generation cap. |
| `UI_DIFF_MAX_AUDIT_PAIRS` | No | — | Cap the number of element pairs audited. Bounded runs are marked `auditLimited: true` in the report. Bounded smoke and full classification are distinguishable via `visualClassificationStatus` and `auditScope`. |

This implementation requires no user-authored target map, ROI map, ignore mask, or anchor dump.

## Configuring OpenCode Zen Free Models

No local OpenCode daemon or `opencode run` process is required. The MCP calls the OpenAI-compatible Zen API directly. The current free route works with the default public credential; set `OPENCODE_API_KEY` only when OpenCode provides a dedicated key.

```powershell
$env:RUN_OPENCODE_LIVE="1"
npm run verify:opencode-live
```

The gate verifies the live catalog, a one-image structured response, and one deduplicated five-image probe shared across auditor, reviewer, and target recovery.

## Configuring Direct Gemini Models

Set `GEMINI_API_KEY` to an AI Studio key. The pipeline probes direct Gemini routes before using them; `gemini-3.1-pro-preview` may be visible but quota-blocked on the free tier, so `gemini-3.5-flash` is the current live-gate route.

```powershell
$env:GEMINI_API_KEY="..."
$env:RUN_GEMINI_LIVE="1"
npm run verify:gemini-live
```

## Configuring Direct Mistral Models

Set `MISTRAL_API_KEY` to a Mistral API key. The pipeline starts with `ministral-14b-2512` because it passed the same five-image role probe used by the auditor/reviewer/recovery gates; `ministral-8b-2512` is the next Mistral fallback.

```powershell
$env:MISTRAL_API_KEY="..."
$env:RUN_MISTRAL_LIVE="1"
npm run verify:mistral-live
```

## Configuring Native NVIDIA Free Models

Set `NVIDIA_API_KEY` to a NVIDIA Build API key. The pipeline probes native NVIDIA candidates from `CANONICAL_MODEL_RANKING` and selects the highest-quality passing model. Use `NVIDIA_VLM_BASE_URL` to point at a self-hosted NIM instead.

```powershell
$env:NVIDIA_API_KEY="nvapi-..."
# $env:NVIDIA_VLM_BASE_URL="http://localhost:8000/v1"  # for self-hosted NIM
```

Run the NVIDIA live gate to verify:

```powershell
$env:RUN_NVIDIA_LIVE="1"
npm run verify:nvidia-live
```

## Configuring OpenRouter Free Models

Set `OPENROUTER_API_KEY` to an OpenRouter key (free-tier account works). The pipeline:

1. Estimates required calls (probes + audit + recovery + review).
2. Queries `GET https://openrouter.ai/api/v1/key` for `limit_remaining`.
3. Exits with `insufficient_free_quota` if estimated calls exceed available quota.
4. Throttles OpenRouter free calls to ≤ 18 requests/minute.

```powershell
$env:OPENROUTER_API_KEY="sk-or-..."
```

Run the free live gate to verify:

```powershell
$env:RUN_FREE_LIVE="1"
npm run verify:free-live
```

## LocateAnything Sidecar

The MCP calls a sidecar endpoint at `POST /v1/locate-ui-elements`. Start the local wrapper after installing NVIDIA's Eagle Embodied package:

```powershell
git clone https://github.com/NVlabs/Eagle.git C:\Users\xursc\projects\Eagle
python -m venv C:\Users\xursc\projects\.venvs\ui-diff-mcp-locateanything
C:\Users\xursc\projects\.venvs\ui-diff-mcp-locateanything\Scripts\python.exe -m pip install --upgrade pip setuptools wheel
C:\Users\xursc\projects\.venvs\ui-diff-mcp-locateanything\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
cd C:\Users\xursc\projects\Eagle\Embodied
C:\Users\xursc\projects\.venvs\ui-diff-mcp-locateanything\Scripts\python.exe -m pip install --no-deps -e .
cd C:\Users\xursc\projects\ui-diff-mcp
C:\Users\xursc\projects\.venvs\ui-diff-mcp-locateanything\Scripts\python.exe -m pip install -r sidecars\locateanything\requirements.txt
$env:LOCATEANYTHING_EAGLE_EMBODIED_DIR="C:\Users\xursc\projects\Eagle\Embodied"
.\scripts\start-locateanything-sidecar.ps1
```

The TypeScript client sends image bytes with each locator request, so `LOCATEANYTHING_SIDECAR_URL` can point to a remote GPU service that exposes the same contract.

Parser-only sidecar tests:

```powershell
python -m unittest sidecars.locateanything.test_parser
```

## MCP Integration

### Claude Code (project-scoped `.mcp.json`)

```json
{
  "mcpServers": {
    "ui-diff": {
      "command": "node",
      "args": ["C:\\Users\\xursc\\projects\\ui-diff-mcp\\dist\\src\\index.js"],
      "env": {
        "OPENROUTER_API_KEY": "<your-key>"
      }
    }
  }
}
```

### Codex (project-scoped `.codex/config.toml`)

```toml
[mcp_servers.ui-diff]
command = "node"
args = ['C:\Users\xursc\projects\ui-diff-mcp\dist\src\index.js']
enabled = true
```

## Live Release Gates

`npm run verify` is deterministic and does not call external APIs. Before production use, run the live gates:

| Gate | Command | Required env |
| --- | --- | --- |
| Direct Gemini models | `npm run verify:gemini-live` | `RUN_GEMINI_LIVE=1`, `GEMINI_API_KEY` |
| Direct Mistral models | `npm run verify:mistral-live` | `RUN_MISTRAL_LIVE=1`, `MISTRAL_API_KEY` |
| OpenCode Zen MiMo | `npm run verify:opencode-live` | `RUN_OPENCODE_LIVE=1`; optional `OPENCODE_API_KEY` |
| Free OpenRouter models | `npm run verify:free-live` | `RUN_FREE_LIVE=1`, `OPENROUTER_API_KEY` |
| Native NVIDIA models | `npm run verify:nvidia-live` | `RUN_NVIDIA_LIVE=1`, `NVIDIA_API_KEY` |
| Full pipeline | `npm run verify:mcp-live` | `RUN_UI_DIFF_LIVE=1`, `LOCATEANYTHING_SIDECAR_URL`; provider keys optional fallbacks |
| Bounded Calorix smoke | `npm run verify:calorix-live` | `RUN_CALORIX_UI_DIFF_LIVE=1`, image paths, sidecar |
| Full Calorix all-target | `npm run verify:calorix-full-live` | `RUN_CALORIX_FULL_LIVE=1`, image paths, sidecar; **do not set `UI_DIFF_MAX_AUDIT_PAIRS`** |

### Bounded Smoke vs Full Classification

A bounded smoke run (`UI_DIFF_MAX_AUDIT_PAIRS` set) is explicitly not full visual classification:

- `auditLimited: true` in compact output and `report.json`.
- `visualClassificationStatus: "incomplete"` unless all pairs happened to be within the limit.
- `auditScope.auditedPairs` / `auditScope.totalPairs` records the actual vs total pair count.

A full all-target run must show `auditLimited: false`. Use `verify:calorix-full-live` to confirm.

See `docs/release/production-readiness-checklist.md` for the complete sign-off sequence.
