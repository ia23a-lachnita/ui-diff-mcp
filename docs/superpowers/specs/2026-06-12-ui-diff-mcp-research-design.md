# UI Diff MCP Research Design

**Status:** draft after project-owner rejection of the first plan. Gemini 3 Pro Preview review in progress.

**Purpose:** `ui-diff-mcp` compares a mockup image and an actual mobile app screenshot, then reports every meaningful visual difference with location, visual category, evidence, and artifacts.

**Non-purpose:** It does not explain root cause, suggest app-code edits, suggest MCP config edits, or decide what an implementation agent should change. It only reports visible diffs as exactly as possible.

---

## Research Takeaways

- MCP should expose a small, task-specific tool surface with Zod schemas and structured output. The TypeScript SDK supports `registerTool`, `outputSchema`, `structuredContent`, and local `stdio` transport, which fits a local screenshot-analysis server.
- MCP security matters because this server may capture screens and run local commands. The server must avoid shell interpolation, validate paths, keep command execution narrow, and never expose broad filesystem or arbitrary command tools.
- Pixel comparison is still useful as a coverage signal. `pixelmatch` is fast and has anti-aliasing handling and configurable thresholds, but pixel diff alone cannot classify UI differences.
- Visual regression tools converge on the same loop: capture, compare, report. Most struggle with dynamic content, mobile devices, and explaining what changed; this MCP should specialize in those gaps rather than become a dashboard product.
- UI target discovery should use visual grounding. Research on UI grounding frames the problem as locating a UI element from a screenshot and language expression, not relying on app metadata.
- LocateAnything is a strong candidate for target discovery because it explicitly supports GUI grounding, dense detection, text localization, and bounding-box generation. It should be an optional locator adapter, not assumed available.
- OpenRouter and NVIDIA can both support multimodal structured outputs, but model support varies by provider and date. The MCP must run health probes against candidate models instead of hardcoding a permanent “best” model.
- OpenRouter’s live model metadata on 2026-06-12 showed `nex-agi/nex-n2-pro:free` as a free model with both image input and structured-output support. This is a candidate, not a guarantee.
- NVIDIA Nemotron Nano 12B v2 VL is a relevant reviewer/vision candidate, especially for image/document-style understanding, but the exact endpoint/free availability must be probed at runtime.
- Free-tier model APIs are not stable infrastructure. Rate limits, endpoint churn, and model capability changes must be expected and reported as `model_unavailable`, not hidden behind degraded reports.
- LangGraph.js is useful for durable state, streaming, interrupts, and resumed graph execution. For the first version, a typed DAG/pipeline is faster to build and easier to test; keep the design LangGraph-compatible, but do not make LangGraph a required dependency until runs need resumability or human review.

---

## Product Boundary

The MCP receives:

- `expectedImage`: mockup/design image.
- `actualImage`: screenshot or freshly captured screen.
- Optional capture instructions.
- Optional prior generated MCP state.

The MCP returns:

- A compact JSON result with diff summary, target list, and artifact paths.
- A full `report.json` with all evidence.
- Visual artifacts: normalized images, overlays, crops, boxes, and coverage maps.

The MCP must not require:

- User-authored target maps.
- User-authored ROI boxes.
- User-authored ignore masks.
- Flutter anchor dumps.
- Manual visual criteria config.

The MCP may persist generated state:

- Auto-discovered target memory.
- Prior model health results.
- Prior target pairing corrections.
- Stable project-specific naming learned from previous runs.

Generated state must be inspectable and editable, but the default workflow must work from images alone.

---

## Proposed Architecture

```text
MCP tool
  -> image intake/capture
  -> normalize expected + actual
  -> deterministic signal extraction
  -> model locator pass
  -> target pairing graph
  -> criterion audit passes
  -> reviewer/consistency pass
  -> coverage check
  -> report writer
```

Use a plain typed orchestrator for MVP. Represent each stage as a node-like function with typed inputs/outputs so it can later move into LangGraph if durable execution becomes useful.

### Why Not LangGraph First

LangGraph would help if runs become long-lived, resumable, interactive, or cross-session. The first MCP run is a bounded local analysis job. Adding LangGraph immediately increases dependency and state complexity before the target discovery and diff-report contract are proven.

### When To Add LangGraph

Add LangGraph when at least one is true:

- Model calls regularly exceed one host turn and need checkpoint resume.
- Human review of generated target memory becomes part of the run.
- The pipeline starts branching dynamically based on uncertainty.
- The same run must be inspected or resumed after process failure.

---

## Deterministic Checks

Deterministic checks are not “truth.” They are measurable signals that help ensure coverage and reduce model hallucination.

- Image metadata: dimensions, scale ratio, orientation, color space.
- Pixel diff: changed-pixel mask, percent, connected components.
- Perceptual similarity: SSIM/MS-SSIM or equivalent local similarity score for regions.
- Edge/shape diff: edge maps to catch border radius, stroke, icon outline, and clipping changes.
- Color sampling: dominant colors and sampled fills/strokes in matched boxes.
- OCR/text boxes: detected text, text bounding boxes, approximate font height, truncation.
- Geometry: box position, size, center, alignment, spacing, overlap, containment, baseline estimates.
- Coverage: every significant changed pixel cluster must be assigned to a target diff or reported as `unclassified_visual_change`.

These checks should never produce code suggestions. They produce measurements and artifacts.

---

## UI Criteria

Criteria are visual categories used to classify diffs. They are built in, not manually authored by users.

- Presence: missing, extra, duplicated, or invisible element.
- Geometry: position, size, scale, aspect ratio, radius, stroke width.
- Spacing/alignment: margins, gaps, baselines, centering, grouping, row/column rhythm.
- Typography/content: text mismatch, font size, weight, line height, wrapping, truncation.
- Color/appearance: fill, stroke, gradient, opacity, contrast, active/inactive state.
- Icon/image: wrong icon, missing icon, image crop, thumbnail, illustration mismatch.
- Layering/clipping: overlap, occlusion, shadow/glow, z-order, clipped content.
- Component state: selected tab, disabled state, loading state, toggle state, progress value.
- Chart/special geometry: arcs, rings, bars, progress tracks, angles, lengths, handles.

The report groups differences by target and criterion, but the target discovery must be automatic.

---

## Target Discovery

The first plan’s manual target config is rejected. Target discovery must be generated by the MCP.

### Stage 1: Visual Signals

Create pixel/edge/color/OCR signals from expected and actual images. Diff-region clustering means connected-component grouping over changed-pixel or changed-edge masks. It is not a fallback and not a user-facing strategy; it is a coverage signal that says, “there is changed visual mass here.”

### Stage 2: Locator Model

Run a locator pass over expected and actual separately. Preferred adapters:

1. A tested OpenRouter/NVIDIA vision model that passes a bounding-box JSON probe.
2. LocateAnything through a cloud/NIM/Hugging Face endpoint or separately managed local service.
3. A generic VLM locator prompt as a weaker temporary path.

Do not bundle local LocateAnything into the MVP. A 3B VLM local deployment would require Python/PyTorch, GPU setup, or a separate model-serving stack, which would slow delivery and make installation fragile. Keep the core MCP lightweight and define `LocateAnythingProvider` as an adapter interface for a later companion service or cloud endpoint.

Locator output:

```json
{
  "elements": [
    {
      "id": "generated stable id",
      "label": "short visual label",
      "type": "text|button|card|image|icon|chart|nav|list_item|unknown",
      "box": { "x": 0.1, "y": 0.2, "width": 0.4, "height": 0.08 },
      "text": "optional OCR/visible text",
      "confidence": 0.0
    }
  ]
}
```

### Stage 3: Pairing Graph

Pair expected elements to actual elements using:

- Box overlap and relative position.
- OCR/text similarity.
- Visual type similarity.
- Color/shape/image embeddings when available.
- Parent/child layout relationships.

Unpaired expected elements become possible missing elements. Unpaired actual elements become possible extra elements.

### Stage 4: Diff Candidates

Create candidates from:

- Paired elements with geometry, color, text, or crop-level visual differences.
- Unpaired elements.
- Changed-pixel clusters not covered by any paired or unpaired element.

The last category is reported explicitly as `unclassified_visual_change`, so no diff disappears.

---

## Model Roles

Do not use only two broad personas.

- Locator: finds UI elements and boxes. Sees full image; does not judge diffs.
- Pairing verifier: checks expected/actual element matches when deterministic pairing is uncertain.
- Criterion auditor: checks one target pair and one criterion. Sees crops and a small context image, not every artifact by default.
- Consistency reviewer: reviews only the proposed diff record and supporting artifacts. It can reject or downgrade, not add unrelated findings.
- Consolidator: merges duplicate diff records and ensures coverage. Prefer deterministic code; use a model only when grouping labels are unclear.

Prompt payload must be minimal:

- Locator: full image only, box schema.
- Criterion auditor: expected crop, actual crop, local overlay, target context crop, criterion rubric.
- Reviewer: diff record, same crops, deterministic measurements.
- Full expected/actual screens are included only for locator and for auditor cases where local context is insufficient.

---

## Model Strategy

Use provider adapters, not fixed model assumptions.

### Required Probe

Before a model is used in a run, probe:

- Accepts image input.
- Returns strict JSON for a bounding-box schema.
- Returns strict JSON for a criterion-result schema.
- Latency under configured timeout.
- Does not invert expected/actual in a tiny known fixture.

Probe enforcement:

- The probe cannot be disabled for free or auto-selected models.
- Probe cache TTL defaults to 15 minutes for free models and 24 hours for pinned paid/local models.
- A model that fails probing is excluded from the run.
- If no candidate passes, the MCP returns `model_unavailable` and still writes deterministic artifacts, but it must label the run incomplete rather than pretending a visual diff audit happened.
- The error message should name the failed provider/model and recommend configuring a stable provider key or endpoint.

### Candidate Policy

- Prefer free models only if they pass the probe.
- Prefer specialized grounding models for locator work.
- Prefer strong structured-output VLMs for criterion auditing.
- Do not use `openrouter/free` for reproducible runs unless the report records the resolved model.
- Store exact provider, model, endpoint, probe result, and prompt version in `report.json`.

Rate-limit policy:

- Treat HTTP `429`, provider timeout, quota exhaustion, and missing capability as normal operational states.
- Retry with bounded exponential backoff only inside the configured run budget.
- Do not silently switch from a failed visual model to pixel-only reporting.
- If deterministic coverage exists but models are unavailable, return all deterministic artifacts plus `visualClassificationStatus: "incomplete"`.
- If the user wants reliable repeated runs, recommend a pinned stable model/provider key rather than a free router.

### Current Candidate Notes

- OpenRouter: live metadata on 2026-06-12 found `nex-agi/nex-n2-pro:free` as a free structured-output image-input candidate.
- NVIDIA: `nvidia/nemotron-nano-12b-v2-vl` is a relevant vision candidate and is also available through OpenRouter as a free variant in some listings, but availability must be probed.
- LocateAnything: best-aligned locator candidate by task fit, but adapter availability must be verified.

---

## MCP Tools

Keep the MCP surface small:

- `compare_ui_images`: compare expected and actual image paths.
- `capture_mobile_screen`: optional screenshot capture only.
- `discover_ui_diffs`: run full target discovery and diff classification.
- `ui_diff_model_health`: probe configured/free model candidates.
- `read_ui_diff_report`: summarize an existing report without re-running models.

No `run_screen_ui_diff` requiring user-authored screen config in MVP.

---

## Generated State

The MCP may create:

```text
.ui-diff/
  generated/
    target-memory.json
    model-health-cache.json
    pairing-corrections.json
  runs/
    run-001/
      report.json
      artifacts/
```

Rules:

- Generated state is optional acceleration, not a prerequisite.
- Users may edit it, but they should not have to create it.
- The report must say when generated state affected the result.
- Deleting `.ui-diff/generated` should never break basic image comparison.

---

## What Not To Build

- No manual target-map workflow as the primary path.
- No anchor-dump dependency in MVP, even for Calorix.
- No user-authored ROI/mask setup requirement.
- No root-cause explanation.
- No code-change or config-change advice.
- No “acceptance” language that implies the app is correct.
- No silently ignored dynamic regions.
- No whole-screen mega-prompt that asks for every criterion at once.

---

## MVP Recommendation

Build the first version around:

1. Image intake and deterministic artifacts.
2. Model locator with strict box schema.
3. Expected/actual target pairing graph.
4. Built-in visual criteria.
5. Criterion-scoped diff classification.
6. Coverage enforcement for every significant diff cluster.
7. Compact MCP response plus full artifact report.

Use TypeScript, MCP TypeScript SDK, Sharp/PNGJS/pixelmatch, Zod, and direct provider adapters. Defer LangGraph until the pipeline needs persisted resumability.

---

## Research Sources

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [LangGraph.js overview](https://docs.langchain.com/oss/javascript/langgraph/overview)
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [OpenRouter image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding)
- [OpenRouter models API](https://openrouter.ai/docs/api/api-reference/models/get-models)
- [OpenRouter free router](https://openrouter.ai/openrouter/free)
- [NVIDIA NIM VLM API reference](https://docs.nvidia.com/nim/vision-language-models/latest/api-reference.html)
- [NVIDIA NIM VLM structured generation](https://docs.nvidia.com/nim/vision-language-models/1.0.0/structured-generation.html)
- [NVIDIA LocateAnything](https://research.nvidia.com/labs/lpr/locate-anything/)
- [LocateAnything-3B model card](https://huggingface.co/nvidia/LocateAnything-3B)
- [Google Visual Grounding for User Interfaces](https://research.google/pubs/visual-grounding-for-user-interfaces/)
- [Google ScreenAI](https://research.google/blog/screenai-a-visual-language-model-for-ui-and-visually-situated-language-understanding/)
- [pixelmatch](https://github.com/mapbox/pixelmatch)
- [Percy visual testing tools overview](https://percy.io/blog/visual-testing-tools)

---

## Gemini Review

Gemini 3 Pro Preview review pass 1:

- `AGREEMENT_STATUS: agree`
- Must-fix: explicitly handle free-tier rate limits, endpoint churn, and graceful provider failure.
- Must-fix: enforce short-TTL health probes for free/auto-selected models.
- Should-fix: clarify that local LocateAnything deployment is not MVP-lightweight for a TypeScript MCP server.

Changes incorporated:

- Added explicit `model_unavailable` and `visualClassificationStatus: "incomplete"` behavior.
- Added non-skippable probe enforcement and cache TTLs.
- Added free-tier rate-limit policy.
- Changed locator priority to cloud/API VLM first and local LocateAnything as a later adapter/companion-service path.

Gemini 3 Pro Preview review pass 2:

- `AGREEMENT_STATUS: agree`
- Must-fix: none.
- Should-fix: none.
- Rationale: the design now handles free-tier rate limits, enforces strict model health probing, and correctly defers heavy local VLM deployment behind an adapter interface.
