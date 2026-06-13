# ui-diff-mcp

Successor project for `mobile-ui-diff-mcp`.

Current research/design spec:

- `docs/superpowers/specs/2026-06-12-ui-diff-mcp-research-design.md`

Rejected historical plan:

- `docs/superpowers/plans/2026-06-12-ui-diff-mcp-successor.md`

This repository is intended to become a general MCP server for comparing mobile app screenshots against mockup designs, with Calorix as the first demanding integration target.

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

Create a `.env` file in the root of the project and add the following variables:

- `OPENROUTER_API_KEY` (required)
- `LOCATEANYTHING_SIDECAR_URL` (optional, defaults to `http://127.0.0.1:39731`)
- `LOCATEANYTHING_EAGLE_EMBODIED_DIR` (required only when starting the local LocateAnything sidecar)
- `NVIDIA_API_KEY` (optional)
- `NVIDIA_VLM_BASE_URL` (optional)

This implementation requires no user-authored target map, ROI map, ignore mask, or anchor dump.

## LocateAnything Sidecar

The MCP calls a sidecar endpoint at `POST /v1/locate-ui-elements`. Start the local wrapper after installing NVIDIA's Eagle Embodied package:

```powershell
git clone https://github.com/NVlabs/Eagle.git C:\Users\xursc\projects\Eagle
cd C:\Users\xursc\projects\Eagle\Embodied
pip install -e .
cd C:\Users\xursc\projects\ui-diff-mcp
pip install -r sidecars\locateanything\requirements.txt
$env:LOCATEANYTHING_EAGLE_EMBODIED_DIR="C:\Users\xursc\projects\Eagle\Embodied"
.\scripts\start-locateanything-sidecar.ps1
```

The TypeScript client sends image bytes with each locator request, so `LOCATEANYTHING_SIDECAR_URL` can point to a remote GPU service that exposes the same contract. Local RTX 3070 8 GB runs may fail with CUDA out-of-memory; that is a live-gate blocker for the local machine.

Parser-only sidecar tests are included in `npm run verify` and can also be run directly:

```powershell
python -m unittest sidecars.locateanything.test_parser
```

## MCP Integration

### Claude Code (project-scoped `.mcp.json`)

Add to `<project>/.mcp.json`:

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

Add to `<project>/.codex/config.toml`:

```toml
[mcp_servers.ui-diff]
command = "node"
args = ['C:\Users\xursc\projects\ui-diff-mcp\dist\src\index.js']
enabled = true
```

Set `OPENROUTER_API_KEY` in your shell environment or a `.env` file before starting Codex.

## Live Release Gates

The default `npm run verify` command is deterministic and does not call external APIs.
Before production use, run the live gates with real credentials and a real LocateAnything sidecar:

```powershell
$env:RUN_UI_DIFF_LIVE="1"
$env:OPENROUTER_API_KEY="<real-openrouter-key>"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
npm run verify:live
```

`verify:live` must pass before declaring the MCP production-ready. It calls OpenRouter and the LocateAnything sidecar directly; rate limits, missing keys, and unavailable sidecars are release blockers for that run.

### Optional Calorix Live Smoke

Use a real Calorix mockup/screenshot pair when available:

```powershell
$env:RUN_CALORIX_UI_DIFF_LIVE="1"
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-09-criterion-audit-validation.png"
$env:OPENROUTER_API_KEY="<real-openrouter-key>"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
npm run verify:calorix-live
```
