# Pi LocateAnything Benchmark Evidence

**Date:** 2026-08-09
**Status:** Q4_K selected as sole Pi candidate. No production-readiness claim.

## Host

- **Machine:** Raspberry Pi 4, ARM64 Cortex-A72
- **Physical RAM:** 7.6 GiB
- **Swap:** 2 GiB persistent (not disabled during benchmarks)
- **OS:** Debian ARM64
- **Engine:** `locate-anything.cpp` (external C++ backend), commit `77376ab332de918220f7a7e391542eefb5407c9f`
- **Model source:** [mudler/locate-anything.cpp-gguf](https://huggingface.co/mudler/locate-anything.cpp-gguf), derived from NVIDIA weights
- **Official model:** `nvidia/LocateAnything-3B`
- **CPU threads:** 4
- **Generation mode:** hybrid

## Reproducible Command Shape

The two C++ runs used the CLI below with literal prompt `text`. Paths are shown as they existed on this host; model and engine files remain external to this repository.

```bash
/usr/bin/time -v \
  /home/agent-runner/projects/locate-anything.cpp/build/examples/cli/locate-anything-cli detect \
  --model <q4-or-q5-gguf> \
  --input <today-dark-402x874-or-resized-276x600.png> \
  --prompt text \
  --output <result.json> \
  --annotated <result.png> \
  --mode hybrid \
  --threads 4
```

The official path instantiated `LocateAnythingWorker` with the local `nvidia/LocateAnything-3B` files, `device="cpu"`, and `dtype=torch.bfloat16`, then called its scene-text detection path with the same 276x600 RGB input. Model load completed in `9.477s`; inference was stopped after 1,200 seconds without a result. This was an intentional bounded stop, not a completed inference benchmark. The log records PyTorch switching from unsupported BF16 MKL-DNN matmul to BLAS.

## Benchmark Results

| Backend/model | Input dimensions | Detections | Elapsed (s) | Peak RSS (KiB) | Process swap | Decision |
|---|---:|---:|---:|---:|---|---|
| Official `nvidia/LocateAnything-3B` BF16 CPU | 276x600 | no response | 1,200 | not comparable | N/A | **Reject:** CPU lacks BF16 matmul path; PyTorch reported no answer before timeout. |
| `locate-anything.cpp` Q4_K | 276x600 | 21 | 473.506 | 4,797,980 | baseline | **Selected Pi candidate.** |
| `locate-anything.cpp` Q4_K | 402x874 | 22 | 762.240 | 5,057,200 | baseline | Quality baseline only (not production input size). |
| `locate-anything.cpp` Q5_K | 276x600 | 13 | 591.213 | 5,127,908 | ~245 MiB increase under concurrent load | **Reject:** slower, larger, lower coverage, new swap use under concurrent host load. |

## Q4_K Selection Details

- **Backend identity:** `locate-anything.cpp/ggml`
- **Model SHA-256:** `894088a00a2cd2bbb7f34b12893988dd0376c8ed92213a9f2cf6420f1e3901da`
- **ABI version:** 1
- **Engine commit:** `77376ab332de918220f7a7e391542eefb5407c9f`
- **Input:** canonical Calorix Today reference resized to 276x600 (production locator input size)

The rejected Q5_K file SHA-256 is `2664a5fdf221c43a3a1216f527135d35a99816ffe68ce5652fc40c298be020d4`. The official Hugging Face directory was identified by model ID rather than represented as one file hash; it contains multiple weight shards, so this evidence does not falsely claim a single-model-file digest for that path.

## Visual Review Boundary

Saved annotated outputs were visually inspected. Findings:

- Q4 boxes are broadly useful and cover detected regions.
- Model-generated text labels are garbled at 600 px input size.
- The independent OCR lane remains authoritative for text transcription; model labels are not treated as OCR truth.

The inspected local evidence files were `/tmp/locate-q4-hybrid-text.png`, `/tmp/locate-q4-hybrid-text-600.png`, and `/tmp/locate-q5-hybrid-text-600.png`. They are ephemeral benchmark evidence and are not committed release artifacts. Stage 5 must reproduce the selected Q4 result inside a durable run artifact directory before the adapter can pass its live gate.

## Rejection Rationale

**Official BF16:** No response produced within 1,200 seconds. PyTorch reported the CPU lacks the BF16 matmul path. Not a viable Pi backend.

**Q5_K:** Fewer detections (13 vs 21), slower (591s vs 474s), higher peak RSS (5,127,908 vs 4,797,980 KiB), and accumulated ~245 MiB process swap under concurrent host load. Lower visible coverage than Q4_K at the same input dimensions. Not selected.

## Source Provenance

- Engine: [mudler/locate-anything.cpp](https://github.com/mudler/locate-anything.cpp), MIT license.
- GGUF weights: [mudler/locate-anything.cpp-gguf](https://huggingface.co/mudler/locate-anything.cpp-gguf), derived from NVIDIA weights.
- Model: [nvidia/LocateAnything-3B](https://huggingface.co/nvidia/LocateAnything-3B), NVIDIA model license.
