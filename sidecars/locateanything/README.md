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
python -m venv C:\Users\xursc\projects\.venvs\ui-diff-mcp-locateanything
C:\Users\xursc\projects\.venvs\ui-diff-mcp-locateanything\Scripts\python.exe -m pip install --upgrade pip setuptools wheel
C:\Users\xursc\projects\.venvs\ui-diff-mcp-locateanything\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
cd C:\Users\xursc\projects\Eagle\Embodied
C:\Users\xursc\projects\.venvs\ui-diff-mcp-locateanything\Scripts\python.exe -m pip install --no-deps -e .
cd C:\Users\xursc\projects\ui-diff-mcp
C:\Users\xursc\projects\.venvs\ui-diff-mcp-locateanything\Scripts\python.exe -m pip install -r sidecars\locateanything\requirements.txt
```

Then start the adapter:

```powershell
$env:LOCATEANYTHING_EAGLE_EMBODIED_DIR="C:\Users\xursc\projects\Eagle\Embodied"
$env:LOCATEANYTHING_IN_TOKEN_LIMIT="4096"
$env:LOCATEANYTHING_GENERATION_MODE="hybrid"
$env:LOCATEANYTHING_MAX_NEW_TOKENS="512"
C:\Users\xursc\projects\.venvs\ui-diff-mcp-locateanything\Scripts\python.exe -m uvicorn sidecars.locateanything.server:app --host 127.0.0.1 --port 39731
```

The default URL is:

```text
http://127.0.0.1:39731
```

## Remote GPU

The TypeScript client sends `imageBase64` and `imageMimeType` with each request, so the sidecar does not need access to the same filesystem as the MCP process. A remote GPU service is valid if it exposes the same endpoint and response schema.

## Hardware Note

An RTX 3070 with 8 GB VRAM may fail to run `nvidia/LocateAnything-3B` at the model repository's default image token budget. The sidecar supports an explicit memory budget:

```powershell
$env:LOCATEANYTHING_IN_TOKEN_LIMIT="4096"
$env:LOCATEANYTHING_GENERATION_MODE="hybrid"
$env:LOCATEANYTHING_MAX_NEW_TOKENS="512"
```

The helper script sets `LOCATEANYTHING_IN_TOKEN_LIMIT=4096`, `LOCATEANYTHING_GENERATION_MODE=hybrid`, and `LOCATEANYTHING_MAX_NEW_TOKENS=512` when the variables are unset. Use a higher token limit only on GPUs with enough free VRAM. Treat CUDA out-of-memory as a release-gate blocker for that machine, not as a passing live result.

## Verification

Parser-only tests do not load the model:

```powershell
python -m unittest sidecars.locateanything.test_parser
```

### OCR lane

The sidecar v2 contract includes an `ocr_text` lane. The first implementation ships the adapter boundary and records `model: "disabled"` unless an OCR engine is installed. Production candidates:

- Tesseract/Tesseract.js: simplest local deployment and word boxes.
- PaddleOCR: stronger OCR and document parsing, heavier Python dependency.

The release gate must pass without user-authored OCR config. If OCR is enabled, the report records the engine in `locatorMetadata.lanes.ocr_text.model`.
