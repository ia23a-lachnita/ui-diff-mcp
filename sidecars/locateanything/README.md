# LocateAnything Sidecar

This sidecar exposes the HTTP contract used by `ui-diff-mcp`:

```text
POST /v1/locate-ui-elements
```

It wraps NVIDIA's `LocateAnythingWorker` from `NVlabs/Eagle/Embodied` and converts model box tokens into the MCP locator schema.

## Backend Selection

The sidecar supports two inference backends:

- **`official`**: The original NVIDIA `LocateAnythingWorker` (requires PyTorch, Eagle/Embodied, and CUDA).
- **`cpp`**: A native C++ worker via ctypes (no PyTorch dependency; requires `sidecars.locateanything.cpp_worker` and the shared library).

Set `LOCATEANYTHING_BACKEND` to select explicitly:

```bash
export LOCATEANYTHING_BACKEND="official"   # or "cpp"
```

When unset, the sidecar auto-selects:
- ARM64 (`aarch64`/`arm64`) → `cpp`
- Other architectures → `official`

Diagnostic skip is controlled separately by `LOCATEANYTHING_SKIP_MODEL` (not `LOCATEANYTHING_BACKEND`). Setting `LOCATEANYTHING_BACKEND=skip` is rejected.

The `/health` endpoint reports the active `backend` field and remains stable even for invalid backend values. Load errors include the selected backend name for diagnostics.

## Setup

### Official NVIDIA backend (Windows/Linux with CUDA)

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

### C++ backend (Linux ARM64)

No PyTorch, no Eagle, no GPU. Requires `sidecars.locateanything.cpp_worker` and the `locate-anything.cpp` shared library.

Stage 4 pins exact provenance. The launcher (`scripts/start-locateanything-sidecar.sh`) enforces these
values and refuses to start (or, with `--check-only`, refuses to report ready) if the built library or
model do not match:

- **Engine commit**: `locate-anything.cpp` must be built from commit
  `77376ab332de918220f7a7e391542eefb5407c9f`. Other commits are not verified against this launcher's
  co-location and metrics contract.
- **Build flag**: build with `cmake -DLA_SHARED=ON` (a shared library, not a static one).
- **C API ABI**: the built library must report ABI version `1`. The launcher checks this and fails with
  a rebuild-at-pinned-commit message on mismatch.
- **Model**: the Q4_K quantization only, pinned to SHA-256
  `894088a00a2cd2bbb7f34b12893988dd0376c8ed92213a9f2cf6420f1e3901da`. Q4_K was selected from measured Pi
  evidence over Q5_K (lower detection count, longer runtime, and higher process swap under concurrent
  load); see `docs/implementation-status.md` for the measurements.
- **No model or build output enters Git.** The shared library and `.gguf` model file are build/download
  artifacts; keep them outside the repository (or gitignored) on every host.

```bash
# Build locate-anything.cpp at the pinned commit (see its README for full detail)
cd /home/agent-runner/projects/locate-anything.cpp
git checkout 77376ab332de918220f7a7e391542eefb5407c9f
mkdir -p build-shared && cd build-shared
cmake .. -DLA_SHARED=ON && cmake --build . -j"4"

# The sidecar auto-selects cpp on aarch64/arm64.
# Default paths (override via LOCATEANYTHING_CPP_LIBRARY_PATH / LOCATEANYTHING_CPP_MODEL_PATH):
#   lib:  /home/agent-runner/projects/locate-anything.cpp/build-shared/liblocate_anything.so
#   model: /home/agent-runner/projects/locate-anything.cpp/models/locate-anything-q4_k.gguf

export LOCATEANYTHING_BACKEND="cpp"

# Recommended Pi production path: validate provenance/ABI/co-location, then start via the launcher.
bash scripts/start-locateanything-sidecar.sh --check-only
bash scripts/start-locateanything-sidecar.sh
```

Direct `uvicorn` invocation is a diagnostic/developer path only — it skips the launcher's engine-commit,
model-SHA-256, ABI, RAM-preflight, startup-metrics, and ReDroid co-location checks. Do not use it as the
production path on the Pi:

```bash
# Diagnostic/developer only — bypasses launcher provenance and co-location gating.
python -m uvicorn sidecars.locateanything.server:app --host 127.0.0.1 --port 39731
```

#### Startup readiness vs. inference timeout

`LOCATEANYTHING_STARTUP_TIMEOUT_MS` (architecture default `600000` on ARM64/Pi / `aarch64`,
`120000` on all other supported architectures; max `600000`) and `LOCATEANYTHING_STARTUP_POLL_MS`
(default `500`, max `10000`) are public launcher variables that control only how long
`scripts/start-locateanything-sidecar.sh` polls `/health` for `"ready": true` before failing. The longer
ARM64 default exists because measured Pi Q4 cold start is about 473 seconds. They are unrelated to
`LOCATEANYTHING_TIMEOUT_MS`, the separate Node-side inference-request timeout the MCP client uses for
each `/v1/locate-ui-elements` call; that variable does not affect launcher startup at all.

#### ReDroid co-location evidence

On the C++ backend, if a co-located ReDroid container is detected, the launcher requires
`LOCATEANYTHING_COLOCATION_EVIDENCE` to point at a file proving a prior measured concurrent run stayed
within resource bounds. The file has an exact 9-key `key=value` schema (`schema_version`, `engine_commit`,
`model_sha256`, `abi_version`, `quantization`, `host_machine`, `concurrent_peak_rss_kib`,
`concurrent_swap_delta_kib`, `status`) — see the root `README.md` "ReDroid Co-Location Evidence" section
for the authoritative field table and rejection rules (shell-metacharacter lines are rejected without ever
being evaluated as shell code).

`locateanything-startup.metrics`, written by the launcher after the sidecar becomes ready, is a **separate**
post-ready artifact: it records only that one locator process's own RSS/swap, measured after startup with
no ReDroid workload necessarily running concurrently. It is not proof of concurrent ReDroid co-location and
must never be substituted for `LOCATEANYTHING_COLOCATION_EVIDENCE`.

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

Parser and server tests do not load the model:

```powershell
python -m unittest sidecars.locateanything.test_parser sidecars.locateanything.test_server sidecars.locateanything.test_cpp_worker
```

### OCR lane

The sidecar v2 contract includes an `ocr_text` lane. The first implementation ships the adapter boundary and records `model: "disabled"` unless an OCR engine is installed. Production candidates:

- Tesseract/Tesseract.js: simplest local deployment and word boxes.
- PaddleOCR: stronger OCR and document parsing, heavier Python dependency.

The release gate must pass without user-authored OCR config. If OCR is enabled, the report records the engine in `locatorMetadata.lanes.ocr_text.model`.

### OmniParser lane

`UI_DIFF_ENABLE_OMNIPARSER=1` enables the optional OmniParser lane when its Python dependencies and model weights are installed outside this repository.

The OmniParser model card states the icon detection model is AGPL-licensed. This repo must not vendor those weights. The sidecar reports `license: "AGPL-3.0"` in `/v1/locate-ui-elements` metadata whenever this lane is configured or fails, so release reports can record the active license surface.

### YOLO UI lane

`UI_DIFF_YOLO_UI_MODEL_PATH` points to a local UI-element detector model. Candidate training data includes Rico, VINS, WebUI, and the unified Rico+WebUI YOLO-format dataset. The first production goal is not to train a new model inside this repo; it is to make the sidecar contract accept a local detector and record its model path hash/metadata in reports.
