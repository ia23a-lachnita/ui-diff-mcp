# ui-diff-mcp

MCP server for comparing mobile app screenshots against mockup designs using free-first visual model diffing. Calorix is the primary integration target.

Design spec: `docs/superpowers/specs/2026-06-12-ui-diff-mcp-research-design.md`

## Free-First Default

The default mode (`free`) never calls paid models. It probes OpenCode Zen's image-capable `mimo-v2.5-free` route first, then native NVIDIA free VLM endpoints, then OpenRouter `:free` routes. Every route must pass the role's real image-count and JSON probe before selection. Paid models are disabled unless `mode: "paid"` is passed and `UI_DIFF_ENABLE_PAID_MODE=1` is set.

OpenCode currently also lists `deepseek-v4-flash-free`, but its model metadata is text-only. It is intentionally excluded from auditor, reviewer, and target-recovery roles because those roles require four or five crop images. OpenCode documents its free models as limited-time routes, so catalog presence never replaces runtime probes.

Before starting a free-model run, the pipeline estimates the required request count and checks available quota against the OpenRouter key info endpoint. If estimated calls exceed available free quota, the run exits immediately with `status: "insufficient_free_quota"` rather than consuming quota silently.

## Modes

| Mode | Behavior |
| --- | --- |
| `free` | Default. OpenCode MiMo first, then NVIDIA free endpoints, then OpenRouter `:free`. Never paid. |
| `free_opencode` | Only OpenCode Zen visual routes. Currently `mimo-v2.5-free`. |
| `free_openrouter` | Only OpenRouter `:free` routes. |
| `free_nvidia` | Only native NVIDIA free endpoint routes. |
| `paid` | Explicit opt-in requiring `UI_DIFF_ENABLE_PAID_MODE=1`. Records paid model use in `report.json`. |
| `deterministic_only` | No VLM calls. Returns deterministic signal evidence only. |

## Artifacts As Machine Evidence

All generated images (pixel diff, directional overlay, crop pairs, recovery crops) are machine evidence consumed by audit and recovery models. They are not a manual inspection workflow. Do not rely on visual artifact review as a substitute for structured `report.json` output.

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
