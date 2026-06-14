# NVIDIA API VLM Research For UI Diff MCP

**Date:** 2026-06-14

**Purpose:** Identify native NVIDIA Build/NIM/API vision-language model candidates for automated mobile UI diff auditing. This research corrects the earlier plan gap where NVIDIA was treated as a provider without enough model-by-model suitability analysis.

## Research Boundary

This document covers native NVIDIA Build/NIM/API candidates only. OpenRouter free-model research is handled separately in `docs/superpowers/plans/2026-06-14-free-first-ui-diff-hardening.md`.

The target task is not generic image captioning. The model must be suitable for at least one of these UI-diff roles:

- Criterion auditor: compare expected/actual crops and directional overlays, then return strict JSON diff records.
- Reviewer: validate whether a proposed diff is supported by visual evidence.
- Target recovery: inspect unassigned visual-diff regions and classify what visible UI element or criterion changed.
- Locator assistant: produce text-only candidate labels/boxes only when LocateAnything misses significant visual mass.

## NVIDIA API Facts

- NVIDIA hosted chat completions use the OpenAI-compatible endpoint `https://integrate.api.nvidia.com/v1/chat/completions`.
- NIM VLM examples use OpenAI-style message content with `image_url` parts.
- NIM VLM docs support base64 data URLs for local image bytes.
- NVIDIA structured-generation docs recommend `response_format: { "type": "json_schema" }` over `json_object`; `json_object` only guarantees valid JSON, not schema adherence.
- Some model-specific docs do not explicitly list structured JSON, so every candidate must pass a live strict-schema probe before use.
- NVIDIA Build free endpoints are development/trial infrastructure; throughput and quota must be measured per key/model.

Sources:

- https://docs.api.nvidia.com/nim/reference/llm-apis
- https://docs.api.nvidia.com/nim/reference/mistralai-mixtral-8x22b-instruct-infer
- https://docs.nvidia.com/nim/vision-language-models/1.7.0/examples/qwen3.6/api.html
- https://docs.nvidia.com/nim/vision-language-models/1.2.0/structured-generation.html
- https://docs.nvidia.com/nim/vision-language-models/1.5.0/examples/nemotron-nano-12b-v2-vl/api.html

## Canonical NVIDIA-Hosted Candidate Ranking

This is the only ranked list in this document. It ranks NVIDIA-hosted image-capable candidates for UI-diff use based on current provider evidence, likely model strength, role fit, licensing, and expected need for live probes.

This is not a final measured benchmark. Exact runtime selection still requires the live probe suite: two-image order, directional overlay comprehension, strict JSON, crop-level diff classification, target recovery, latency, throughput, quota, and rate-limit behavior. NVIDIA does not expose enough public per-key speed/usage data to make a reliable static speed ranking, so speed is a measured gate.

OpenRouter and NVIDIA currently present Kimi K2.6 and MiniMax M3 as stronger broad multimodal/agentic candidates than Nemotron Nano and likely stronger than several older Qwen/Nemotron candidates for UI/UX and visual reasoning. Therefore they are ranked first for quality probing. Schema-readiness, licensing, and speed do not create alternate rankings; they are gates that can disqualify or demote a candidate at runtime.

### 1. `moonshotai/kimi-k2.6`

**Recommended role:** top NVIDIA-hosted auditor/reviewer and target-recovery candidate.

**Why it is strong:**

- NVIDIA Build says Free Endpoint, Partner Endpoint, and Download are available.
- NVIDIA's API docs describe Kimi-K2.6 as an open-source native multimodal agentic model with 1T total parameters and 32B active parameters.
- It accepts text, image, and video inputs through a MoonViT vision encoder.
- It is designed for long-horizon agentic workflows and OpenRouter describes it as suitable for coding-driven UI/UX generation and visual inputs.
- It is marked ready for commercial/non-commercial use in NVIDIA's API docs.

**Risks/gates:**

- It is agentic/general multimodal, not specifically a UI-diff or UI-grounding model.
- It may over-focus on task planning/coding if prompts are not tightly bounded to visible UI diffs only.
- Strict JSON, expected/actual ordering, directional overlay comprehension, and speed must be live-probed.

**Sources:**

- https://build.nvidia.com/moonshotai/kimi-k2.6
- https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k2-6
- https://openrouter.ai/moonshotai/kimi-k2.6-20260420
- https://openrouter.ai/moonshotai/kimi-k2.6:free

### 2. `minimaxai/minimax-m3`

**Recommended role:** top auditor/reviewer and target-recovery candidate when licensing/provider terms allow the run.

**Why it is strong:**

- NVIDIA Build describes MiniMax-M3 as a multimodal VLM.
- It processes text, image, and video inputs and produces text output.
- Model card lists 428B total parameters, about 22B active parameters, a ViT vision encoder, dynamic image/video input, and 1M input context.
- Intended use includes multimodal understanding, agentic workflows, design, and creative tasks.
- OpenRouter describes it as a multimodal foundation model suited for long-horizon agentic work, coding, and tool use.

**Risks/gates:**

- NVIDIA's model card says the model is ready for non-commercial use; the MCP must not select it automatically for commercial production runs unless the configured provider terms explicitly allow that run.
- The Build page calls it "Preview" in search/catalog text, so availability and behavior may change.
- Exact UI diff, directional overlays, strict JSON, and throughput are unproven until live probes run.

**Sources:**

- https://build.nvidia.com/minimaxai/minimax-m3
- https://build.nvidia.com/minimaxai/minimax-m3/modelcard
- https://openrouter.ai/minimax/minimax-m3

### 3. `qwen/qwen3.5-397b-a17b`

**Recommended role:** high-quality native NVIDIA auditor/reviewer candidate, if the free endpoint is available to the configured key and latency is acceptable.

**Why it is strong:**

- NVIDIA API page describes it as a multimodal foundation model with early-fusion vision-language training.
- Build page says Free Endpoint is available.
- It is explicitly designed for vision-language understanding, video understanding, agentic workflows, and tool/function calling.
- It has large context and high-end reasoning capacity, which may help with complicated UI overlays and multi-image evidence.

**Risks:**

- Huge model; speed may be too slow or quota-constrained for per-target audit loops.
- Thinking mode / reasoning output must be disabled or hidden from structured output.
- Must pass strict JSON, expected/actual order, and directional overlay probes before use.

**Sources:**

- https://build.nvidia.com/qwen/qwen3.5-397b-a17b
- https://docs.api.nvidia.com/nim/reference/qwen-qwen3-5-397b-a17b

### 4. `qwen/qwen3.6-35b-a3b`

**Recommended role:** primary native NVIDIA probe candidate for structured UI-diff audits if available in the configured endpoint.

**Why it is strong:**

- NVIDIA NIM docs are recent and explicitly show image input through `image_url`.
- The docs explicitly state structured output uses `response_format` with `type: "json_schema"`.
- Docs describe SGLang API compatibility and image passing with public URLs and base64 data URLs.
- Smaller active-parameter MoE profile than Qwen3.5-397B may give a better quality/speed balance.

**Risks:**

- The Build catalog page found during research did not list it in the same way as qwen3.5; it may be NIM/self-hosted first rather than always available as a hosted free endpoint.
- Must be discovered from the configured NVIDIA endpoint/model list or treated as self-hosted NIM candidate.

**Sources:**

- https://docs.nvidia.com/nim/vision-language-models/1.7.0/examples/qwen3.6/api.html

### 5. `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`

**Recommended role:** primary NVIDIA-owned target-recovery and GUI/OCR reasoning candidate; secondary auditor/reviewer candidate only after schema and speed probes pass.

**Why it is plausible:**

- NVIDIA Build model card describes it as image/video/audio/text multimodal.
- The model card explicitly lists Graphical User Interface (GUI), OCR, document intelligence, and GUI automation as supported/expected workflows.
- Build catalog lists it with Downloadable Free Endpoint availability.
- The model card says it was improved using Qwen3-VL-30B-A3B-Instruct, Qwen3.5, Qwen2.5-VL-72B, and other strong models.
- GUI/OCR relevance makes it especially interesting for unassigned visual-diff region recovery and missed-target labeling.

**Risks:**

- The Build model card emphasizes broad enterprise multimodal workflows, not exact mockup-vs-screenshot visual diff.
- It is a reasoning model and may emit extra reasoning unless constrained.
- Reasoning models may produce verbose reasoning or inconsistent schema unless constrained.
- It may be slower than Nemotron Nano 12B v2 VL for repeated per-target calls.
- Strict JSON schema and expected/actual order must be live-probed before it can audit diffs.

**Sources:**

- https://build.nvidia.com/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning/modelcard
- https://docs.nvidia.com/nim/vision-language-models/1.7.0/examples/nemotron-3-nano-omni-30b-a3b-reasoning/api.html

### 6. `nvidia/nemotron-nano-12b-v2-vl`

**Recommended role:** lightweight native NVIDIA free candidate for auditor/reviewer/target recovery.

**Why it is strong:**

- Build page says Free Endpoint is available and reports high recent API usage.
- Model card says it supports text, image, video, and multi-image inputs.
- It supports up to five input images, 128K input+output tokens, and image dimensions relevant to mobile screenshots.
- It is designed for document intelligence, visual Q&A, summarization, and multi-image reasoning. UI screenshots are closer to document/layout understanding than natural-scene-only tasks.
- Reasoning is off by default and can be explicitly disabled with `/no_think`.

**Risks:**

- It is document/VQA oriented, not explicitly UI-diff or UI-grounding oriented.
- Model card does not by itself prove strict JSON schema support, so strict-schema live probing is mandatory.
- Alpha channel is not supported, so transparent overlays must be flattened before sending.

**Sources:**

- https://build.nvidia.com/nvidia/nemotron-nano-12b-v2-vl
- https://build.nvidia.com/nvidia/nemotron-nano-12b-v2-vl/modelcard
- https://docs.nvidia.com/nim/vision-language-models/1.5.0/examples/nemotron-nano-12b-v2-vl/api.html

### 7. `meta/llama-3.2-90b-vision-instruct`

**Recommended role:** high-quality native NVIDIA visual reviewer/escalation candidate if free endpoint quota and latency are acceptable.

**Why it is plausible:**

- NVIDIA Build search result says Free Endpoint and Partner Endpoint are available.
- Llama 3.2 Vision models are instruction-tuned for visual recognition, image reasoning, captioning, and image Q&A.
- Model card benchmarks show strong DocVQA, ChartQA, and diagram understanding for the 90B vision-instruct variant, which is relevant to UI screenshots.

**Risks:**

- Larger than 11B, likely slower for loops over many target pairs.
- Model card does not establish strict JSON support. Probe required.
- Strong safety tuning may sometimes reject or over-generalize unusual prompts.
- NVIDIA Build availability can vary by geography/account; the model page redirected to an unavailable-experience page in one browser check even though the catalog lists free/download availability. Treat availability as live probe data, not a static guarantee.

**Sources:**

- https://build.nvidia.com/meta/llama-3.2-90b-vision-instruct
- https://build.nvidia.com/meta/llama-3.2-11b-vision-instruct/modelcard
- https://docs.nvidia.com/nim/vision-language-models/1.2.0/examples/llama3-2/api.html

### 8. `meta/llama-3.2-11b-vision-instruct`

**Recommended role:** lightweight native NVIDIA reviewer/auditor candidate, especially for crops and local overlays.

**Why it is plausible:**

- NVIDIA Build page says Free Endpoint is available.
- Model card says it is optimized for visual recognition, image reasoning, captioning, and image Q&A.
- Intended use includes visual grounding, DocVQA, and visual reasoning.
- NVIDIA docs show OpenAI chat completion with image URL for this model.

**Risks:**

- Older model than Qwen3.5/Qwen3.6/Nemotron Nano 12B v2 VL.
- Strict JSON support not proven from the model card; probe required.
- May be less reliable for exact spatial diffs and small UI deltas than newer candidates.
- NVIDIA Build availability can vary by geography/account; record endpoint availability per run.

**Sources:**

- https://build.nvidia.com/meta/llama-3.2-11b-vision-instruct
- https://build.nvidia.com/meta/llama-3.2-11b-vision-instruct/modelcard
- https://docs.nvidia.com/nim/vision-language-models/1.2.0/examples/llama3-2/api.html

### 9. `nvidia/cosmos3-nano-reasoner`

**Recommended role:** target-recovery and spatial-reasoning probe candidate; not a default auditor.

**Why it is plausible:**

- NVIDIA Build page says Downloadable Free Endpoint.
- Model card says it accepts text+image and text+video.
- It can output structured reasoning, 2D/3D point localization, and bounding-box coordinates for vision tasks.
- Physical/spatial reasoning could help classify unassigned visual regions and layout shifts.

**Risks:**

- It is built for physical AI, robotics, space/time/physics reasoning, and embodied planning, not UI diff.
- It may over-reason or hallucinate scene semantics.
- Model card warns outputs are not guaranteed and must not be treated as ground truth.
- Use only after UI-diff fixture probes, not as first default.

**Sources:**

- https://build.nvidia.com/nvidia/cosmos3-nano-reasoner
- https://build.nvidia.com/nvidia/cosmos3-nano-reasoner/modelcard

### 10. `nvidia/llama-3.1-nemotron-nano-vl-8b-v1`

**Recommended role:** fast/light candidate for crop-level review if still available; not a top default.

**Why it is plausible:**

- Build page says Free Endpoint and Download Available.
- It is described as multi-modal, understanding text/images and creating informative responses.
- It has high recent API usage.
- NVIDIA docs emphasize image-before-text ordering for better results.

**Risks:**

- Older than Nemotron Nano 12B v2 VL.
- It appears document/OCR oriented and may be weaker than newer alternatives.
- Strict JSON support not shown in the opened docs; probe required.

**Sources:**

- https://build.nvidia.com/nvidia/llama-3.1-nemotron-nano-vl-8b-v1
- https://build.nvidia.com/nvidia/llama-3.1-nemotron-nano-vl-8b-v1/modelcard
- https://docs.nvidia.com/nim/vision-language-models/1.3.0/examples/llama-nemotron-nano/api.html

### 11. `google/paligemma` / `google/google-paligemma`

**Recommended role:** low-priority fallback probe for simple visual Q&A only.

**Why it is plausible:**

- NVIDIA Build page says Free Endpoint.
- Model card says image+text input and text output.
- It is a one-shot visual language understanding model.

**Risks:**

- Small 3B model and likely too weak for exact mobile UI diff classification.
- Model card is caption/question oriented, not structured multi-image comparison.
- No evidence found for strict JSON schema support.
- Use only as fallback if it surprisingly passes UI-diff probes.

**Sources:**

- https://build.nvidia.com/google/google-paligemma
- https://build.nvidia.com/google/google-paligemma/modelcard

## Excluded Or Demoted Models

| Model | Decision | Reason |
| --- | --- | --- |
| `nvidia/nemotron-parse` | Exclude from auditor/reviewer; possible future OCR/structure helper only | It is a document text-extraction model returning encoded text, boxes, and semantic document classes. It is not a general UI-diff auditor. |
| `deepseek-ai/deepseek-v4-pro` | Exclude from visual audit | NVIDIA Build lists a free endpoint, but describes it as a 1M-context coding/reasoning MoE. NVIDIA API docs place it under Large Language Models and show text-only chat message usage, not image input. It can only be considered later for text-only report consolidation, not visual diff classification. |
| `deepseek-ai/deepseek-v4-flash` | Exclude from visual audit | Same DeepSeek V4 family; NVIDIA describes it as a coding/agent/reasoning MoE, not a VLM. |
| `nvidia/nemotron-3-ultra-550b-a55b` | Exclude from visual audit | Strong free-endpoint reasoning/coding/planning LLM, but the NVIDIA page shows text chat content and does not document image input. It can be useful for text-only report summarization later, not visual diff classification. |
| `nvidia/llama-3.1-nemotron-ultra-253b-v1` | Exclude | Text/reasoning model; NVIDIA page marks Free Endpoint deprecated and does not document image input. |
| `nvidia/vila` | Exclude | Deprecated endpoint. |
| `nvidia/neva-22b` | Exclude | Deprecated endpoint. |
| `nvidia/llama-3.1-nemoguard-8b-content-safety` and other content-safety models | Exclude | Safety classifiers, not visual diff models. |
| `meta/llama-guard-4-12b` | Exclude | Multimodal safety classifier, not UI diff. |
| `qwen/qwen-image`, `qwen/qwen-image-edit` | Exclude | Image generation/editing, not image understanding diff audit. |
| `nvidia/ising-calibration-1-35b-a3b` | Exclude by default | Specialized quantum calibration chart VLM; not a general mobile UI diff model despite image input. |
| `google/diffusiongemma-26b-a4b-it` | Exclude by default | Diffusion LLM/text generation focus, not proven visual UI audit fit. |
| Text-only Nemotron/Qwen/Llama models | Exclude | No image input. |

## Runtime Selection Gates

The canonical ranking above is the starting order. The runtime selector must not hardcode it as truth. It must test each configured/available candidate in ranked order and choose the first model that passes:

- image input
- two-image expected/actual order
- strict JSON or parser-safe schema output
- directional overlay comprehension
- crop-level UI diff classification
- unassigned-region recovery
- latency and throughput budget

## Required Live Probe Suite

Each candidate must run the same probe set before it can be used:

1. **Two-image order probe**
   - Input: generated expected image with blue button, actual image with red shifted button.
   - Required output: JSON naming expected color/position and actual color/position without inversion.

2. **Strict schema probe**
   - Use `response_format: { type: "json_schema" }` when supported.
   - If unsupported, use prompt-only JSON and reject unless Zod parses exactly.

3. **Directional overlay probe**
   - Input: expected crop, actual crop, directional overlay, pixel mask.
   - Required output: identify cyan as expected-only and magenta as actual-only.

4. **UI criterion probe**
   - Input: button/card/progress-bar fixture.
   - Required output: classify one geometry diff, one color diff, and one missing/extra diff.

5. **No-root-cause/no-fix probe**
   - Required output must not mention why the app differs or what code/config to change.

6. **Throughput probe**
   - Record TTFT, total duration, completion tokens/sec, provider/model id, and whether reasoning was emitted.

7. **Quota/availability probe**
   - Record HTTP status, rate-limit headers if present, and trial/free endpoint failures.

## Recommendation

Do not state “use NVIDIA models” generically. State:

- Native NVIDIA is first priority only when a specific NVIDIA-hosted candidate passes the UI-diff probe suite.
- Use the canonical ranking above as the only initial NVIDIA-hosted order.
- Schema-readiness, licensing, quota, and speed are runtime gates, not separate rankings.
- DeepSeek V4 Pro is intentionally excluded from visual audit despite NVIDIA free-endpoint availability because the NVIDIA docs present it as a text/code/reasoning LLM, not an image-capable VLM.
- Cosmos is promising for spatial target recovery but not a default auditor without evidence.
- PaliGemma is a fallback, not a serious default, unless live probes prove otherwise.
- Content-safety, deprecated, text-only, image-generation, and narrow domain-specific models must be filtered out before probing.
