# LocateAnything Sidecar

This sidecar exposes the HTTP contract used by `ui-diff-mcp`:

```text
POST /v1/locate-ui-elements
```

It wraps NVIDIA's `LocateAnythingWorker` from `NVlabs/Eagle/Embodied` and converts model box tokens into the MCP locator schema.

## Setup

Clone Eagle and install the Embodied package in a Python environment with CUDA support:

```powershell
git clone https://github.com/NVlabs/Eagle.git C:\Users\xursc\projects\Eagle
cd C:\Users\xursc\projects\Eagle\Embodied
pip install -e .
cd C:\Users\xursc\projects\ui-diff-mcp
pip install -r sidecars\locateanything\requirements.txt
```

Then start the adapter:

```powershell
$env:LOCATEANYTHING_EAGLE_EMBODIED_DIR="C:\Users\xursc\projects\Eagle\Embodied"
.\scripts\start-locateanything-sidecar.ps1
```

The default URL is:

```text
http://127.0.0.1:39731
```

## Remote GPU

The TypeScript client sends `imageBase64` and `imageMimeType` with each request, so the sidecar does not need access to the same filesystem as the MCP process. A remote GPU service is valid if it exposes the same endpoint and response schema.

## Hardware Note

An RTX 3070 with 8 GB VRAM may fail to load or run `nvidia/LocateAnything-3B`. Treat CUDA out-of-memory as a release-gate blocker for that machine, not as a passing live result.

## Verification

Parser-only tests do not load the model:

```powershell
python -m unittest sidecars.locateanything.test_parser
```
