# Pi Local Locator And Android Validation Design

**Status:** Approved for implementation after a green external review. Production remains blocked.

**Date:** 2026-08-09

## Objective

Run a real LocateAnything model on the Raspberry Pi behind the existing sidecar contract, preserve truthful resource and latency evidence, and make Android validation fail with a precise blocker when this rootless host cannot boot ReDroid.

The implementation extends the current Python/FastAPI sidecar. It does not create a second HTTP server, vendor model weights, or replace the existing endpoint contract.

## Measured Decision

Host: Raspberry Pi 4, ARM64 Cortex-A72, 7.6 GiB physical RAM, 2 GiB persistent swap.

| Backend/model | Input | Result | Elapsed | Peak RSS | Decision |
|---|---:|---:|---:|---:|---|
| Official `nvidia/LocateAnything-3B`, BF16 CPU | 276x600 | no response before stop | 1,200s | not comparable | Reject on this CPU; PyTorch reported the CPU lacks the BF16 matmul path. |
| `locate-anything.cpp` Q4_K | 402x874 | 22 detections | 762.240s | 5,057,200 KiB | Useful quality baseline. |
| `locate-anything.cpp` Q4_K | 276x600 | 21 detections | 473.506s | 4,797,980 KiB | Selected Pi candidate. |
| `locate-anything.cpp` Q5_K | 276x600 | 13 detections | 591.213s | 5,127,908 KiB | Reject: slower, larger, lower coverage; accumulated about 245 MiB process swap under concurrent host load. |

The Q4_K benchmark used:

- external engine commit `77376ab332de918220f7a7e391542eefb5407c9f`;
- model SHA-256 `894088a00a2cd2bbb7f34b12893988dd0376c8ed92213a9f2cf6420f1e3901da`;
- backend identity `locate-anything.cpp/ggml`;
- canonical Calorix Today reference resized to 276x600 for the production locator input size;
- four CPU threads and hybrid generation mode.

Visual inspection found broadly useful Q4 boxes but garbled model-generated text labels at 600 px. The independent OCR lane remains authoritative for text transcription. Combined and generic prompts returned only 1-5 detections, usually from the first category or visible text, so they do not replace the existing separate semantic queries.

Sources and provenance:

- Engine: [mudler/locate-anything.cpp](https://github.com/mudler/locate-anything.cpp), MIT license.
- GGUF weights: [mudler/locate-anything.cpp-gguf](https://huggingface.co/mudler/locate-anything.cpp-gguf), derived from NVIDIA weights.
- Model: [nvidia/LocateAnything-3B](https://huggingface.co/nvidia/LocateAnything-3B), NVIDIA model license.

## Architecture

```text
ui-diff-mcp
  scripts/start-locateanything-sidecar.sh
    -> existing Python + uvicorn process on 127.0.0.1:39731

  sidecars/locateanything/server.py
    GET  /health                         unchanged
    POST /v1/locate-ui-elements          unchanged
      cv_components lane
      ocr_text lane
      omniparser lane
      yolo_ui lane
      locateanything lane
        official worker on supported hosts
        OR
        CppLocateAnythingWorker on ARM64
          ctypes.CDLL(external liblocate_anything.so)
          persistent la_ctx
          one Python threading.Lock for the full request
          one la_capi_locate_buffer call per existing query
```

The C++ checkout, shared library, GGUF files, and benchmark artifacts remain external and uncommitted. The repository stores only adapter code, validation policy, tests, and operator documentation.

## Existing Contract

No new endpoint is introduced.

`POST /v1/locate-ui-elements` continues to accept:

- `imagePath`, optional `imageBase64`, and `imageMimeType`;
- one or more `{id, prompt}` queries;
- `generationMode` and `maxBoxesPerQuery`.

It continues to return:

- model identity and received image dimensions;
- elements with `queryId`, `label`, pixel `box`, `rawBox1000`, `confidence`, and `rawText`;
- warnings and lane metadata.

The C API output is `{"detections":[{"label":string,"box":[x1,y1,x2,y2]}]}` in received-image pixel coordinates. The adapter must reject non-finite, unordered, empty, or out-of-bounds boxes, then derive:

- `box = {x, y, width, height}` in received-image pixels;
- `rawBox1000 = [x1, y1, x2, y2]` normalized to 0..1000;
- exact request `queryId`;
- `rawText` from the model label and a documented bounded confidence policy.

## C ABI Boundary

Only symbols present in upstream `include/la_capi.h` are used:

```c
int la_capi_abi_version(void); /* must equal 1 */
la_ctx *la_capi_load(const char *gguf_path, int n_threads);
void la_capi_free(la_ctx *ctx);
char *la_capi_locate_buffer(
  la_ctx *ctx,
  const unsigned char *bytes,
  size_t len,
  const char *prompt,
  int mode
);
void la_capi_free_string(char *value);
const char *la_capi_last_error(la_ctx *ctx);
```

The shared context and its last-result state are not assumed thread-safe. One `threading.Lock` serializes the complete multi-query request, and every returned C string is freed exactly once.

## Backend Selection

- An explicit backend or artifact override is authoritative and fails closed when invalid.
- On ARM64, automatic selection chooses the C++ backend only when the checkout commit, shared-library ABI, GGUF hash, architecture, and memory preflight all pass.
- On supported non-ARM hosts, the official Python worker remains available.
- The C++ path must not import Torch, Eagle, or Decord.
- `LOCATEANYTHING_SKIP_MODEL=1` remains diagnostic and can never satisfy a release gate.
- The current official worker compatibility defect is fixed test-first: unset `LOCATEANYTHING_TOP_K` maps to integer `0`; explicit values remain positive validated integers.

## Resource And Timing Policy

The host's configured swap is not removed. Release evidence must instead record:

- `MemAvailable` before model load;
- process RSS and peak RSS after load and inference;
- process swap before and after inference;
- queue wait, each query duration, and total request duration;
- model/backend/quantization/hash/ABI provenance.

New process swap use, sustained page thrashing, OOM termination, or insufficient physical headroom is a failed gate. Q4 and ReDroid are not run concurrently on this 8 GiB host unless a separate measured co-location gate proves adequate headroom without new swap use.

The present timeouts are not viable for a complete Pi request: the client defaults to 300 seconds, Calorix uses 600 seconds, one Q4 query measured 473.506 seconds, and eight separate queries may exceed one hour. Configuration must support the measured ceiling, while agents use `start_ui_diff_run` plus `get_ui_diff_run_status` for the long-running MCP workflow. HTTP keepalive does not override the Node request timeout.

## Vision-Reuse Requirement

At the pinned engine commit, every `Engine::locate_image` call repeats image preprocessing, ViT encoding, and projection before text decoding. Persistent model load alone therefore does not make the eight-query pipeline practical.

A bounded external-fork experiment must split prepared image/projected embeddings from query decode and expose a prepared-image C ABI. It is adopted only if parity tests prove the same boxes/labels as the current call for all existing query modes. If the experiment is unavailable or fails parity, full Pi semantic validation remains blocked for throughput even if a one-query direct locator gate passes.

## Direct Locator Quality Gate

The bounded gate calls the existing `/v1/locate-ui-elements` endpoint with the canonical Calorix Today reference and saves:

- exact image bytes sent to the sidecar;
- raw response and provenance;
- an annotated image with readable query/category labels;
- timing, RSS, peak RSS, and process-swap evidence.

It checks query-category hit coverage, stable query IDs, finite in-bounds boxes, duplicate limits, expected model hash/ABI, and non-diagnostic model execution. A bounded Q4 gate is evidence for the locator adapter only, not a full UI-diff production sign-off.

## Android Runtime Truth

Rootless Podman accepts the three binderfs device mappings. ReDroid still cannot boot:

- Android second-stage init receives `EPERM` mounting `/dev/blkio` and `/dev/cpuctl`;
- `/dev/memcg` returns `EINVAL`;
- init then receives `SIGHUP` and exits `129`;
- `--cgroupns=host`, `--cgroups=disabled`, and their combination do not change the result.

This matches Podman's documented rootless boundary: a rootless privileged container cannot gain privileges the invoking user lacks. The existing ReDroid scripts should understand binderfs source devices, use a fully qualified pinned image, preserve supplemental binder/KVM groups, and then fail early with this verified rootless-runtime blocker instead of repeatedly launching a doomed container.

No sudo, NOPASSWD, root Docker access, or other host privilege change is requested. Virtual Android validation remains blocked until a supported rootful Android host/runtime is available. A physical ADB device is the supported alternative on this Pi.

## APK Provenance

Calorix Actions run `31182023073` produced `android-apk-1f538641f5e5f5c4a48c95cdfb97462838187106` from exact source SHA `1f538641f5e5f5c4a48c95cdfb97462838187106`, with a checksum file. Because the main Calorix worktree contains an unrelated `.mcp.json` edit, source-clean attestation uses a temporary clean worktree at that SHA. Install, seed, capture, and UI-diff gates remain conditional on a real Android target.

## Acceptance Boundary

Implementation is complete only when:

- Q4 is the single unambiguous Pi selection and its provenance is verified;
- the existing sidecar serves real C++ detections through the unchanged contract;
- ABI, conversion, ownership, locking, timeout, memory, and launcher paths have focused tests;
- the direct real-model locator gate passes with saved, inspectable artifacts;
- the vision-reuse decision is backed by parity and throughput evidence;
- ReDroid reports the verified rootless blocker honestly;
- `npm run verify` and every available relevant live gate pass or record an exact external blocker.

This design does not claim that ReDroid boots, that Q4 and ReDroid can co-reside, that one locator query proves full pipeline throughput, or that ui-diff-mcp is production-ready.

## Review And Worker Record

Antigravity conversation `pi-locateanything-redroid-2026-08-09` first returned `AGREEMENT_STATUS: agree` with must-fix items: mutex protection, a multi-minute request lifecycle, and physical-RAM/co-location gates. It recommended vision reuse and a Q5 memory ceiling. After those items were incorporated, the final pre-implementation review returned `AGREEMENT_STATUS: agree` and `MUST_FIX: none`. The remaining suggestion, to bypass PyTorch-specific runtime configuration for the C++ worker, is included as a Stage 2 test. Response noise: the final wrapper appended an unrelated `task-8 find completed` statement; it is not execution evidence. No repository mutation was observed.

Editing-route record:

- `2026-08-09T14:49:11+02:00` Grok 4.5 high: free usage quota; no mutation.
- `2026-08-09T14:52:31+02:00` Qwen 3.7 Max: HTTP 403 free quota exhausted; no mutation.
- `2026-08-09T14:58:05+02:00` OpenCode Nemotron 3 Ultra: HTTP 504 idle timeout; no mutation.
- MiMo 2.5 produced the initial draft; its correction pass was stopped at `2026-08-09T15:18:00+02:00` after retaining speculative in-repo C code and fabricated ABI names.
- DeepSeek V4 Flash finished at `2026-08-09T15:38:10+02:00` after analysis but without writing; its contradictory truncated hash output was discarded.
- Claude Fable 5 then returned the monthly spend-limit error with no mutation.
- The host fallback replaced only these planning documents and related tracking lines after every declared editing route was exhausted.
