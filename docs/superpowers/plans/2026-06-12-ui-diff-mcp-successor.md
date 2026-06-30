# UI Diff MCP Successor Implementation Plan

> **Status: rejected / superseded.** This plan was rejected by the project owner on 2026-06-12 because it over-indexed on manual config, anchors, root-cause/action advice, and oversized per-target prompt bundles. Do not implement this document. Use the current research/design spec instead: `docs/superpowers/specs/2026-06-12-ui-diff-mcp-research-design.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `ui-diff-mcp`, the general successor to `mobile-ui-diff-mcp`, so implementation agents can get exact, actionable differences between an actual mobile app screenshot and a mockup design.

**Architecture:** The successor uses a staged evidence pipeline: capture and normalize images, create deterministic visual artifacts, split the screen into review targets, run criterion-scoped model judges, run an independent reviewer, resolve conflicts, and return a compact agent action contract. Calorix is the first integration target, but all Calorix-specific knowledge must live in config, target maps, fixtures, and reference context files rather than core code.

**Tech Stack:** TypeScript, Node.js, MCP SDK, Vitest, Sharp/PNGJS/pixelmatch, Zod, provider adapters for OpenRouter and NVIDIA, optional Android ADB capture, optional Flutter anchor artifacts, JSON-schema-constrained model outputs.

---

## Context Snapshot

The current folder `C:\Users\xursc\projects\ui-diff-mcp` was initialized as a git repository and connected to:

```bash
git remote add origin https://github.com/ia23a-lachnita/ui-diff-mcp.git
```

The remote advertised no branches during setup, so this plan starts the successor as the first tracked artifact.

The predecessor at `C:\Users\xursc\projects\mobile-ui-diff-mcp` already has valuable pieces:

- MCP tools for `compare_images`, `run_mobile_ui_diff`, `run_screen_ui_diff`, Android and iOS capture.
- Deterministic image analysis using pixel diff, ROI diff, masks, region detection, radial chart diagnostics, color sampling, text/OCR stubs, and overlap legibility checks.
- A staged pipeline attempt with `RunOrchestrator`, `EvidenceGraph`, `EvidenceBundleBuilder`, `ConflictResolver`, `VerdictEngine`, model judge providers, and criterion judge caching.
- OpenRouter and NVIDIA provider adapters with structured JSON-schema outputs, retries, diagnostics, and primary/reviewer roles.
- Calorix-specific config showing reference facts, mockup source references, Flutter anchors, target maps, dynamic masks, and visual parity requirements.

The successor should reuse these ideas but not blindly copy the accumulated complexity. The new core should be smaller, stricter, and designed around criterion-scoped audits from the beginning.

---

## Product Contract

The MCP server must answer one question for implementation agents:

> What exactly differs between the actual app and the mockup, where is it, why is it likely happening, and what is the safest next code/config action?

The answer must be:

- **Exact:** Always reference coordinates, target IDs, criterion IDs, artifacts, and measured values when available.
- **Scoped:** Never ask a model to inspect the whole screen for everything in one shot.
- **Auditable:** Every model finding must point to the image crops, overlays, deterministic measurements, and prompt version used.
- **General:** Core code must not contain Calorix component names, colors, routes, or data assumptions.
- **Actionable:** Output must include strict machine-readable actions, not only prose.
- **Conservative:** Model findings never authorize edits when they contradict source facts, target validation, deterministic evidence, or reviewer consensus.

---

## High-Level Pipeline

```text
MCP tool call
  -> RunOrchestrator
  -> CaptureAdapter or supplied actualImage
  -> ImageNormalizer
  -> ArtifactBuilder
  -> TargetDiscovery
  -> CriterionPlanner
  -> DeterministicAnalyzers
  -> CriterionBundleBuilder
  -> PrimaryCriterionJudge
  -> ReviewerCriterionJudge
  -> ConflictResolver
  -> VerdictEngine
  -> Compact MCP response + report.json + artifacts
```

The important design shift from the predecessor is that the default unit of analysis is:

```text
screen target + criterion
```

not:

```text
whole screen + broad prompt
```

---

## Core Concepts

### Targets

A target is a visible UI element or region, such as a card, icon, text label, chart, tab item, sheet header, or repeated row.

Targets can be created from:

- Explicit config boxes.
- Flutter anchor dumps.
- Accessibility metadata when available.
- Model-assisted screen segmentation.
- Diff-region clustering as a fallback.

### Criteria

A criterion is one focused visual question that always produces a structured pass/fail/caveat result.

Default criteria:

- Target identity: does the crop point to the intended element?
- Position and size: is the element in the correct place and proportion?
- Spacing and alignment: are margins, gaps, baselines, and grouping relationships correct?
- Typography: text content, scale, weight, line height, truncation, baseline, and hierarchy.
- Color and contrast: design token match, contrast, active/inactive states, gradients.
- Shape and stroke: border radius, stroke width, ring radius, icon outline, dividers.
- Layering and clipping: occlusion, z-order, overflow, shadows/glow, masks.
- State and data tolerance: fixture values vs dynamic values, allowed masks.
- Component-specific geometry: charts, progress bars, navigation bars, media thumbnails.

### Evidence

Evidence is a typed claim with provenance:

```ts
export interface EvidenceItem {
  id: string;
  subjectId: string;
  criterionId?: string;
  source: 'pixel' | 'geometry' | 'ocr' | 'color' | 'anchor' | 'reference' | 'model' | 'reviewer';
  authority: 'source' | 'deterministic' | 'model' | 'reviewer';
  polarity: 'match' | 'mismatch' | 'uncertain' | 'error';
  claim: string;
  confidence: number;
  measurements?: Record<string, string | number | boolean>;
  artifactPaths?: string[];
  proposedChangeVector?: ChangeVector;
  blocked?: boolean;
  blockReason?: ReasonCode;
}
```

### Agent Action Contract

Every completed run returns a strict action contract:

```ts
export interface AgentActionContract {
  acceptanceStatus: 'accepted' | 'rejected' | 'incomplete' | 'metric_only';
  visualAuditStatus: 'pass' | 'pass_with_caveats' | 'fail' | 'error' | 'unavailable' | 'not_run' | 'skipped_by_config';
  canEditApp: boolean;
  canEditConfig: boolean;
  canStopIterating: boolean;
  requiresUserDecision: boolean;
  topNextAction: string;
  allowedChangeVectors: AllowedChangeVector[];
  blockedChangeVectors: BlockedChangeVector[];
  requiredArtifactPaths: string[];
}
```

---

## File Structure

Create the project as a clean TypeScript package:

```text
src/
  index.ts
  mcp/
    server.ts
    tools.ts
    schemas.ts
  cli/
    compare.ts
    health.ts
  config/
    uiDiffConfig.ts
    modelRegistry.ts
    defaults.ts
  capture/
    CaptureAdapter.ts
    AndroidCaptureAdapter.ts
    IosSimulatorCaptureAdapter.ts
    NoopCaptureAdapter.ts
  image/
    load.ts
    normalize.ts
    diff.ts
    masks.ts
    crops.ts
    overlays.ts
    regions.ts
  targets/
    types.ts
    explicitTargets.ts
    flutterAnchors.ts
    modelSegmentation.ts
    diffRegionTargets.ts
    targetResolver.ts
  criteria/
    catalog.ts
    planner.ts
    schemas.ts
  pipeline/
    RunOrchestrator.ts
    ArtifactBuilder.ts
    EvidenceGraph.ts
    CriterionBundleBuilder.ts
    ConflictResolver.ts
    VerdictEngine.ts
    types.ts
  analyzers/
    IAnalyzer.ts
    PixelDiffAnalyzer.ts
    ColorAnalyzer.ts
    GeometryAnalyzer.ts
    OcrAnalyzer.ts
    OverlapAnalyzer.ts
    TargetValidationAnalyzer.ts
  judges/
    IModelProvider.ts
    ModelRouter.ts
    PromptBuilder.ts
    ResponseParser.ts
    CriterionJudge.ts
    ReviewerJudge.ts
    JudgeCache.ts
    providers/
      OpenRouterProvider.ts
      NvidiaProvider.ts
  reports/
    compactResponse.ts
    reportWriter.ts
    markdownSummary.ts
  utils/
    fs.ts
    exec.ts
    hash.ts
    time.ts
test/
  unit/
  integration/
docs/
  architecture/
  examples/
  superpowers/plans/
```

---

## Public MCP Tools

### `compare_images`

Compare supplied expected and actual images. This is the generic lowest-level tool.

### `run_screen_ui_diff`

Load `ui-diff.config.json`, optionally capture the actual screen, then run the full pipeline.

### `capture_screen`

Capture only, useful when agents need a fresh screenshot artifact.

### `model_judges_health`

Check provider API keys, model availability, structured output compatibility, and vision-image support.

### `discover_targets`

Return non-mutating target suggestions from anchors, screen segmentation, and diff clusters.

### `explain_report`

Read an existing `report.json` and return compact, task-focused next actions.

---

## Configuration Contract

The generic config shape:

```json
{
  "modelPolicy": {
    "mode": "visual_parity",
    "freeModelPreference": true,
    "primary": { "provider": "openrouter", "model": "auto:best-free-vision" },
    "reviewer": { "provider": "nvidia", "model": "auto:best-free-vision" },
    "requireReviewerForCodeHints": true,
    "timeoutMs": 120000,
    "maxRetries": 1
  },
  "screens": {
    "screen-id": {
      "platform": "android",
      "expectedImage": "path/to/mockup.png",
      "outputDir": ".ui-diff/screen-id",
      "capture": {},
      "targets": [],
      "criteria": [],
      "referenceContext": {},
      "dynamicRegions": [],
      "ignoreRegions": []
    }
  }
}
```

Model names must not be hardcoded as permanent "best" defaults. Free model availability changes often. Implement `auto:best-free-vision` as a runtime registry decision:

1. Query configured provider health if provider APIs expose model metadata.
2. Prefer models with vision input, JSON-schema or reliable JSON support, adequate context length, and low recent failure rate.
3. Cache the selected model per run with `modelRegistrySnapshot` in `report.json`.
4. Let users pin exact models in config for reproducibility.

Calorix can pin current known candidates, but the core default should remain discoverable and replaceable.

---

## Prompt Strategy

The model prompt system must be built from versioned templates.

Each model call gets:

- One target.
- One criterion or a batch of criteria for the same target.
- Full expected screen.
- Full actual screen.
- Annotated actual screen with target box.
- Expected crop.
- Actual crop.
- Structural diff crop or overlay.
- Deterministic measurements.
- Reference facts.
- Dynamic/ignored-region explanation.
- A strict JSON schema.

Primary judge role:

```text
You are a criterion-scoped mobile UI visual auditor.
Validate the highlighted target before evaluating the criterion.
Compare ACTUAL against EXPECTED. Do not invert the images.
Evaluate only this criterion. Ignore unrelated differences.
Return exactly one structured result for the criterion.
```

Reviewer role:

```text
You are an adversarial reviewer.
Check whether the primary finding is supported by the images and deterministic evidence.
Do not introduce unrelated findings.
If target identity is wrong or ambiguous, block the criterion result.
If source facts contradict the finding, mark it uncertain.
```

The prompts must explicitly prevent common predecessor failures:

- Empty evidence arrays.
- Expected/actual inversion.
- Treating data values as visual defects.
- Reporting config metadata as visual caveats.
- Letting a broad whole-screen observation become a code hint.
- Accepting an overlap or legibility measurement when the target box points at the wrong element.

---

## Implementation Tasks

### Task 1: Bootstrap TypeScript Package

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `src/mcp/server.ts`
- Test: `test/unit/packageSmoke.test.ts`

- [ ] **Step 1: Add package metadata and scripts**

```json
{
  "name": "ui-diff-mcp",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "start": "node dist/index.js",
    "compare": "tsx src/cli/compare.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "commander": "^14.0.3",
    "pixelmatch": "^7.2.0",
    "pngjs": "^7.0.0",
    "sharp": "^0.34.5",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^25.9.1",
    "@types/pixelmatch": "^5.2.6",
    "@types/pngjs": "^6.0.5",
    "tsx": "^4.20.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.7"
  }
}
```

- [ ] **Step 2: Add TypeScript config**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Add smoke test**

```ts
import { describe, expect, it } from 'vitest';

describe('package smoke', () => {
  it('loads test runner', () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 4: Verify**

Run:

```bash
npm install
npm run build
npm test
```

Expected: TypeScript build succeeds and the smoke test passes.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src test
git commit -m "chore: bootstrap ui diff mcp package"
```

### Task 2: Define Core Types and Schemas

**Files:**

- Create: `src/pipeline/types.ts`
- Create: `src/config/uiDiffConfig.ts`
- Create: `src/criteria/schemas.ts`
- Create: `src/targets/types.ts`
- Test: `test/unit/configSchema.test.ts`

- [ ] **Step 1: Add strict enums and interfaces**

Create `src/pipeline/types.ts` with `EvidenceItem`, `CriterionResult`, `RunReport`, `AgentActionContract`, `ChangeVector`, `ReasonCode`, and artifact path types.

- [ ] **Step 2: Add Zod schemas**

Create config schemas for provider config, screen config, targets, criteria, ignore regions, dynamic regions, reference context, and capture settings.

- [ ] **Step 3: Test defaults**

Write tests that prove:

- `modelPolicy.mode` defaults to `visual_parity`.
- `requireReviewerForCodeHints` defaults to `true`.
- `auto:best-free-vision` is accepted as a model alias.
- Calorix-specific target IDs are accepted as config data, not enum values.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- test/unit/configSchema.test.ts
npm run build
```

Expected: schema tests and build pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline src/config src/criteria src/targets test/unit/configSchema.test.ts
git commit -m "feat: define ui diff config and evidence types"
```

### Task 3: Implement Image Normalization and Deterministic Artifacts

**Files:**

- Create: `src/image/load.ts`
- Create: `src/image/normalize.ts`
- Create: `src/image/diff.ts`
- Create: `src/image/masks.ts`
- Create: `src/image/crops.ts`
- Create: `src/image/overlays.ts`
- Test: `test/unit/imageArtifacts.test.ts`

- [ ] **Step 1: Port minimal image IO from predecessor**

Use Sharp for resizing/normalization and PNGJS/pixelmatch for exact pixel diff.

- [ ] **Step 2: Produce standard artifacts**

For every run, write:

```text
expected.png
actual.png
actual-normalized.png
diff.png
structural-diff.png
overlay-expected-red-actual-cyan.png
metadata.json
```

- [ ] **Step 3: Test artifact creation**

Use two tiny generated PNG fixtures and assert:

- Diff pixels are counted.
- Output dimensions match expected.
- Overlay file exists.
- Structural diff respects masks.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- test/unit/imageArtifacts.test.ts
npm run build
```

Expected: deterministic image artifact tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/image test/unit/imageArtifacts.test.ts
git commit -m "feat: add deterministic image artifacts"
```

### Task 4: Implement Target Resolution

**Files:**

- Create: `src/targets/explicitTargets.ts`
- Create: `src/targets/flutterAnchors.ts`
- Create: `src/targets/diffRegionTargets.ts`
- Create: `src/targets/modelSegmentation.ts`
- Create: `src/targets/targetResolver.ts`
- Test: `test/unit/targetResolver.test.ts`

- [ ] **Step 1: Implement explicit target loader**

Targets from config have stable IDs and boxes in normalized, expected, or actual coordinates.

- [ ] **Step 2: Implement Flutter anchor loader**

Read a Flutter anchor artifact and convert anchor rectangles into target candidates. Missing anchor files emit warnings and do not fail the run unless a target marks the anchor as required.

- [ ] **Step 3: Implement diff-region fallback**

Convert connected diff components into target candidates only when no explicit or anchor target covers the changed area.

- [ ] **Step 4: Add model segmentation stub**

Create the interface and return no suggestions until the model provider layer exists. The interface must accept full expected/actual images and return proposed targets with confidence and reason.

- [ ] **Step 5: Test target priority**

Assert resolver priority:

```text
explicit target > required Flutter anchor > optional Flutter anchor > model segmentation > diff-region fallback
```

- [ ] **Step 6: Verify**

Run:

```bash
npm test -- test/unit/targetResolver.test.ts
npm run build
```

Expected: target priority and missing-anchor behavior are correct.

- [ ] **Step 7: Commit**

```bash
git add src/targets test/unit/targetResolver.test.ts
git commit -m "feat: resolve ui diff targets"
```

### Task 5: Implement Criteria Catalog and Planner

**Files:**

- Create: `src/criteria/catalog.ts`
- Create: `src/criteria/planner.ts`
- Test: `test/unit/criterionPlanner.test.ts`

- [ ] **Step 1: Add default criteria**

Default criteria must include identity, position/size, spacing/alignment, typography, color/contrast, shape/stroke, layering/clipping, state/data tolerance, and component-specific geometry.

- [ ] **Step 2: Add target-type filtering**

For example:

- Text targets get typography and legibility criteria.
- Chart targets get geometry criteria.
- Navigation targets get active-state and position criteria.
- Generic containers get shape, spacing, and color criteria.

- [ ] **Step 3: Add config overrides**

Allow config to disable, add, or tighten criteria per target without changing code.

- [ ] **Step 4: Test planner**

Assert a Calorix macro-ring target receives chart geometry criteria while a meal card receives card layout, typography, color, and dynamic data criteria.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- test/unit/criterionPlanner.test.ts
npm run build
```

Expected: criteria are deterministic and target-type aware.

- [ ] **Step 6: Commit**

```bash
git add src/criteria test/unit/criterionPlanner.test.ts
git commit -m "feat: plan criterion scoped audits"
```

### Task 6: Implement Evidence Graph and Bundle Builder

**Files:**

- Create: `src/pipeline/EvidenceGraph.ts`
- Create: `src/pipeline/CriterionBundleBuilder.ts`
- Test: `test/unit/evidenceBundles.test.ts`

- [ ] **Step 1: Implement evidence graph**

Support add, query by subject, query by criterion, block evidence, and serialize stable JSON.

- [ ] **Step 2: Implement criterion bundles**

Each bundle contains exactly one target and one criterion unless batching is explicitly enabled for multiple criteria on the same target.

- [ ] **Step 3: Include artifacts**

Each bundle includes full-screen images, annotated screen, expected crop, actual crop, diff crop, deterministic summaries, reference facts, and prompt version.

- [ ] **Step 4: Test one-criterion isolation**

Assert a typography criterion bundle does not include unrelated chart-specific instructions, and chart geometry criteria do not include meal-card data facts unless the target requires them.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- test/unit/evidenceBundles.test.ts
npm run build
```

Expected: bundles are isolated and serializable.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline test/unit/evidenceBundles.test.ts
git commit -m "feat: build isolated criterion evidence bundles"
```

### Task 7: Implement Model Provider Layer

**Files:**

- Create: `src/judges/IModelProvider.ts`
- Create: `src/judges/providers/OpenRouterProvider.ts`
- Create: `src/judges/providers/NvidiaProvider.ts`
- Create: `src/judges/ResponseParser.ts`
- Create: `src/config/modelRegistry.ts`
- Test: `test/unit/modelProviderParsing.test.ts`

- [ ] **Step 1: Define provider interface**

The interface must support:

- Vision input.
- JSON-schema or strict JSON instruction.
- Timeout.
- Retry on parse error.
- Diagnostics with status code, provider, model, raw preview, and failure reason.

- [ ] **Step 2: Implement OpenRouter provider**

Use `OPENROUTER_API_KEY`. Do not read from committed files. Return structured operational errors as evidence-like diagnostics.

- [ ] **Step 3: Implement NVIDIA provider**

Use `NVIDIA_API_KEY`. Match the same output contract as OpenRouter.

- [ ] **Step 4: Implement model registry**

Support:

```text
auto:best-free-vision
auto:fast-free-vision
auto:strict-json-vision
exact provider/model pins
```

The registry records why a model was selected. It must never claim a model is globally best; it selects best-known-for-this-run.

- [ ] **Step 4a: Add curated fallback model list**

Dynamic provider model discovery is brittle, so the registry must include a manually curated fallback table for known-good vision-capable models per provider. Each entry records provider, model ID, whether it is believed to support image input, whether JSON schema is supported, cost tier such as `free` or `unknown`, last verified date, and notes. Runtime discovery can override or supplement this list, but a failed metadata query must not make `auto:best-free-vision` unusable when a pinned curated candidate exists.

- [ ] **Step 5: Test parser hardening**

Assert parser handles:

- Empty evidence arrays.
- Invalid JSON.
- Missing required fields.
- Extra fields.
- Provider HTTP errors.
- Timeout diagnostics.

- [ ] **Step 6: Verify**

Run:

```bash
npm test -- test/unit/modelProviderParsing.test.ts
npm run build
```

Expected: provider parsing is strict and diagnostic-rich.

- [ ] **Step 7: Commit**

```bash
git add src/judges src/config/modelRegistry.ts test/unit/modelProviderParsing.test.ts
git commit -m "feat: add model provider adapters"
```

### Task 8: Implement Capture Adapters

**Files:**

- Create: `src/capture/CaptureAdapter.ts`
- Create: `src/capture/AndroidCaptureAdapter.ts`
- Create: `src/capture/IosSimulatorCaptureAdapter.ts`
- Create: `src/capture/NoopCaptureAdapter.ts`
- Create: `src/capture/preCapture.ts`
- Test: `test/unit/captureAdapters.test.ts`

- [ ] **Step 1: Define capture adapter interface**

The interface accepts a screen config, output path, optional device ID, and optional pre-capture steps. It returns the actual image path, device metadata, warnings, and executed step summaries.

- [ ] **Step 2: Port Android capture safely**

Use `adb exec-out screencap -p` for screenshots. Support normalized taps through a device-size resolver. Reject shell metacharacters in configured `adbShell` commands and execute commands through argv splitting rather than shell interpolation.

- [ ] **Step 3: Port iOS simulator capture**

Use `xcrun simctl io booted screenshot` for simulator screenshots. If unavailable on the current platform, return a structured `capture_unavailable` error instead of crashing.

- [ ] **Step 4: Add no-op capture**

`NoopCaptureAdapter` supports `platform:"none"` and requires `actualImage`. This keeps image-only comparisons platform agnostic.

- [ ] **Step 5: Test adapter behavior**

Mock command execution and assert:

- Android writes the requested output path.
- Unsafe shell commands are rejected.
- Missing iOS tooling returns a structured unavailable error.
- No-op capture rejects runs without `actualImage`.

- [ ] **Step 6: Verify**

Run:

```bash
npm test -- test/unit/captureAdapters.test.ts
npm run build
```

Expected: capture behavior is deterministic under mocked command execution.

- [ ] **Step 7: Commit**

```bash
git add src/capture test/unit/captureAdapters.test.ts
git commit -m "feat: add mobile capture adapters"
```

### Task 9: Implement Prompt Builder, Primary Judge, and Reviewer

**Files:**

- Create: `src/judges/PromptBuilder.ts`
- Create: `src/judges/CriterionJudge.ts`
- Create: `src/judges/ReviewerJudge.ts`
- Create: `src/judges/JudgeCache.ts`
- Test: `test/unit/promptBuilder.test.ts`
- Test: `test/unit/judgeMerge.test.ts`

- [ ] **Step 1: Version prompt templates**

Set initial prompt version:

```text
criterion-audit-v1
```

Include prompt version in every cache key and report.

- [ ] **Step 2: Build primary prompt**

The prompt must list image order, target ID, criterion ID, target contract, deterministic measurements, source facts, and strict result schema.

- [ ] **Step 3: Build reviewer prompt**

The reviewer receives the same bundle plus the primary result and returns `confirmed`, `rejected`, or `uncertain`.

- [ ] **Step 4: Implement consensus rules**

Rules:

- Reviewer rejection blocks code hints.
- Target mismatch blocks criterion measurement.
- Primary failure plus reviewer uncertainty yields caveat, not code edit.
- Source fact contradiction blocks model result.
- Deterministic contradiction downgrades model confidence.

- [ ] **Step 5: Add cache**

Cache by provider, model, prompt version, expected image hash, actual image hash, crop hash, criterion ID, target ID, and reference fact hash.

- [ ] **Step 6: Verify**

Run:

```bash
npm test -- test/unit/promptBuilder.test.ts test/unit/judgeMerge.test.ts
npm run build
```

Expected: prompts are stable and consensus rules are enforced.

- [ ] **Step 7: Commit**

```bash
git add src/judges test/unit/promptBuilder.test.ts test/unit/judgeMerge.test.ts
git commit -m "feat: add criterion model judges"
```

### Task 10: Implement Deterministic Analyzers

**Files:**

- Create: `src/analyzers/IAnalyzer.ts`
- Create: `src/analyzers/PixelDiffAnalyzer.ts`
- Create: `src/analyzers/ColorAnalyzer.ts`
- Create: `src/analyzers/GeometryAnalyzer.ts`
- Create: `src/analyzers/OcrAnalyzer.ts`
- Create: `src/analyzers/OverlapAnalyzer.ts`
- Create: `src/analyzers/TargetValidationAnalyzer.ts`
- Test: `test/unit/deterministicAnalyzers.test.ts`

- [ ] **Step 1: Implement analyzer interface**

Analyzers receive run context and criterion bundles and emit evidence. They do not build final verdicts.

- [ ] **Step 2: Port pixel, color, and geometry basics**

Port only stable predecessor logic first: pixel diff, ROI crop diff, color sampling, and radial geometry measurements.

- [ ] **Step 3: Add target validation analyzer**

Before legibility or overlap measurements are trusted, validate that the configured target box intersects the intended anchor or contains expected text/shape cues when available.

- [ ] **Step 4: Keep OCR optional**

OcrAnalyzer should emit `unavailable` evidence when no OCR backend is configured. It must not block image-only runs.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- test/unit/deterministicAnalyzers.test.ts
npm run build
```

Expected: analyzers emit typed evidence and never produce final verdicts.

- [ ] **Step 6: Commit**

```bash
git add src/analyzers test/unit/deterministicAnalyzers.test.ts
git commit -m "feat: add deterministic evidence analyzers"
```

### Task 11: Implement Optional OCR Backend Integration

**Files:**

- Create: `src/analyzers/ocr/OcrProvider.ts`
- Create: `src/analyzers/ocr/NoopOcrProvider.ts`
- Create: `src/analyzers/ocr/TesseractCliOcrProvider.ts`
- Modify: `src/analyzers/OcrAnalyzer.ts`
- Test: `test/unit/ocrProvider.test.ts`

- [ ] **Step 1: Define OCR provider interface**

The provider returns text boxes, confidence, source image path, and provider diagnostics. The default provider is `NoopOcrProvider`, which emits `unavailable` evidence without failing the run.

- [ ] **Step 2: Add CLI OCR provider**

Implement a Tesseract CLI adapter behind explicit config. If `tesseract` is missing, return structured `ocr_unavailable` diagnostics.

- [ ] **Step 3: Connect OCR to criterion bundles**

Text boxes from OCR are attached only to bundles whose target crop intersects the OCR box. Do not leak text from unrelated targets into a criterion prompt.

- [ ] **Step 4: Test OCR isolation**

Assert text evidence for one target is not included in another target's criterion bundle.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- test/unit/ocrProvider.test.ts
npm run build
```

Expected: OCR is optional, diagnostic-rich, and target scoped.

- [ ] **Step 6: Commit**

```bash
git add src/analyzers/ocr src/analyzers/OcrAnalyzer.ts test/unit/ocrProvider.test.ts
git commit -m "feat: add optional OCR provider integration"
```

### Task 12: Implement Model-Assisted Target Segmentation

**Files:**

- Modify: `src/targets/modelSegmentation.ts`
- Create: `src/judges/SegmentationPromptBuilder.ts`
- Test: `test/unit/modelSegmentation.test.ts`

- [ ] **Step 1: Define segmentation output schema**

The model returns target candidates with ID suggestion, label, box, coordinate space, confidence, reason, and target type. The parser rejects candidates outside image bounds and clips only after recording a warning.

- [ ] **Step 2: Build segmentation prompt**

The prompt receives full expected and actual images plus the structural diff overlay. It asks only for visible UI regions that are likely useful audit targets. It must not evaluate visual parity.

- [ ] **Step 3: Merge segmentation candidates**

Model-segmented targets are lower priority than explicit config and anchors, but higher priority than raw diff-region fallback. Candidates overlapping an existing higher-priority target are attached as aliases or suggestions, not duplicate targets.

- [ ] **Step 4: Test merge behavior**

Use mocked provider output and assert duplicate candidates are merged, out-of-bounds candidates are rejected or clipped with warnings, and explicit targets win.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- test/unit/modelSegmentation.test.ts
npm run build
```

Expected: model segmentation is useful but never overrides trusted target sources.

- [ ] **Step 6: Commit**

```bash
git add src/targets/modelSegmentation.ts src/judges/SegmentationPromptBuilder.ts test/unit/modelSegmentation.test.ts
git commit -m "feat: add model assisted target segmentation"
```

### Task 13: Implement Orchestrator, Conflict Resolver, and Verdict Engine

**Files:**

- Create: `src/pipeline/RunOrchestrator.ts`
- Create: `src/pipeline/ArtifactBuilder.ts`
- Create: `src/pipeline/ConflictResolver.ts`
- Create: `src/pipeline/VerdictEngine.ts`
- Create: `src/reports/compactResponse.ts`
- Create: `src/reports/reportWriter.ts`
- Test: `test/unit/orchestratorOrder.test.ts`
- Test: `test/unit/conflictResolver.test.ts`
- Test: `test/unit/verdictEngine.test.ts`

- [ ] **Step 1: Enforce stage order**

The primary/reviewer judges can only run after criterion bundles exist. Do this in types and runtime checks.

- [ ] **Step 2: Add bounded model-call concurrency**

Criterion-scoped auditing can create many model calls per screen. The orchestrator must run provider calls with bounded concurrency per provider, defaulting to a conservative limit such as `2`, configurable through `modelPolicy.concurrency`. It must preserve deterministic report ordering even when calls finish out of order, stop early only on configured blocking provider failures, and record rate-limit or retry diagnostics per criterion.

- [ ] **Step 3: Implement conflict resolver**

Authority order:

```text
source/reference facts > deterministic measurements > target validation > reviewer > primary model > raw pixel score
```

- [ ] **Step 4: Implement verdict engine**

Verdict engine derives `visualAuditStatus`, `acceptanceStatus`, `canEditApp`, `canEditConfig`, `canStopIterating`, and top next action.

- [ ] **Step 5: Implement compact response**

The MCP response must stay compact and point to `report.json` and artifact paths for detail. Full raw evidence stays on disk.

- [ ] **Step 6: Verify**

Run:

```bash
npm test -- test/unit/orchestratorOrder.test.ts test/unit/conflictResolver.test.ts test/unit/verdictEngine.test.ts
npm run build
```

Expected: stage ordering, conflict resolution, and final action contracts are deterministic.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline src/reports test/unit/orchestratorOrder.test.ts test/unit/conflictResolver.test.ts test/unit/verdictEngine.test.ts
git commit -m "feat: orchestrate evidence pipeline"
```

### Task 14: Implement MCP Tools and CLI

**Files:**

- Create: `src/mcp/schemas.ts`
- Create: `src/mcp/tools.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/index.ts`
- Create: `src/cli/compare.ts`
- Create: `src/cli/health.ts`
- Test: `test/unit/mcpSchemas.test.ts`

- [ ] **Step 1: Register tools**

Register `compare_images`, `run_screen_ui_diff`, `capture_screen`, `model_judges_health`, `discover_targets`, and `explain_report`.

- [ ] **Step 2: Add CLI commands**

CLI supports the same core path for local debugging without MCP.

- [ ] **Step 3: Implement deep model health checks**

`model_judges_health` must go beyond an API ping. It sends a tiny multimodal fixture to the configured model, asks for a strict JSON-schema response, verifies parseability, records latency, records whether image input was accepted, and reports whether the model is safe for criterion judging.

- [ ] **Step 4: Test schemas**

Assert tool schemas reject unknown unsafe fields and require either `actualImage` or a capture configuration.

- [ ] **Step 5: Verify**

Run:

```bash
npm test -- test/unit/mcpSchemas.test.ts
npm run build
```

Expected: MCP schemas and CLI compile.

- [ ] **Step 6: Commit**

```bash
git add src/mcp src/cli src/index.ts test/unit/mcpSchemas.test.ts
git commit -m "feat: expose ui diff mcp tools"
```

### Task 15: Add Calorix Example Without Calorix Coupling

**Files:**

- Create: `docs/examples/calorix/ui-diff.config.json`
- Create: `docs/examples/calorix/today-target-map.json`
- Create: `docs/examples/calorix/README.md`
- Test: `test/integration/calorixConfigSchema.integration.test.ts`

- [ ] **Step 1: Convert current Calorix config into example**

Use paths from `C:\Users\xursc\projects\calorix` as documentation examples, not hardcoded defaults.

- [ ] **Step 2: Include target map**

Represent Calorix's `today.kcalLeftPill` criterion as a generic target/criterion example.

- [ ] **Step 3: Test example config parses**

The example config must parse without requiring Calorix files to exist in the successor repo.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- test/integration/calorixConfigSchema.integration.test.ts
npm run build
```

Expected: Calorix example validates as generic config.

- [ ] **Step 5: Commit**

```bash
git add docs/examples/calorix test/integration/calorixConfigSchema.integration.test.ts
git commit -m "docs: add generic calorix ui diff example"
```

### Task 16: End-to-End Fixture Run

**Files:**

- Create: `test/fixtures/simple-mobile/expected.png`
- Create: `test/fixtures/simple-mobile/actual.png`
- Create: `test/fixtures/simple-mobile/ui-diff.config.json`
- Test: `test/integration/simpleRun.integration.test.ts`

- [ ] **Step 1: Create tiny visual fixture**

Use a deterministic generated fixture with a text-like block shifted by a few pixels and a color mismatch.

- [ ] **Step 2: Run full pipeline in metric-only mode**

Assert artifacts and report are written.

- [ ] **Step 3: Run full pipeline with mocked model providers**

Assert primary/reviewer consensus influences action contract.

- [ ] **Step 4: Verify**

Run:

```bash
npm test -- test/integration/simpleRun.integration.test.ts
npm run build
```

Expected: end-to-end report is stable with and without mocked model providers.

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/simple-mobile test/integration/simpleRun.integration.test.ts
git commit -m "test: add end to end ui diff fixture"
```

---

## Acceptance Criteria

The first implementation milestone is complete when:

- `npm run build` passes.
- `npm test` passes.
- `compare_images` can compare two local images and write deterministic artifacts.
- `run_screen_ui_diff` can load a config and produce `report.json`.
- Target resolution supports explicit boxes and Flutter anchors.
- The pipeline can run with mocked primary and reviewer judges.
- Model provider failures produce structured diagnostics instead of silent acceptance.
- The compact MCP response includes `acceptanceStatus`, `visualAuditStatus`, `canEditApp`, `topNextAction`, and artifact paths.
- Calorix example config validates while the core remains app-agnostic.

---

## Risks and Guardrails

- **Free model availability changes:** Use aliases plus runtime health checks, and record exact selected models in reports.
- **LLM hallucinated findings:** Require criterion-scoped prompts, deterministic evidence, target validation, and reviewer confirmation for code hints.
- **Over-sectioning cost:** Batch multiple criteria only when they share the same target and image set.
- **Bad anchors:** Treat target mismatch as blocking. Do not accept overlap or legibility measurements when the target is wrong.
- **Dynamic data noise:** Prefer fixture mode. Use tight dynamic regions only where fixtures cannot control data.
- **Calorix leakage:** Keep app-specific IDs, facts, and paths in example config and target maps.
- **Context explosion:** Return compact MCP responses. Store full evidence in artifacts.

---

## Gemini Review

Status: reviewed with legacy Gemini CLI on 2026-06-12, then re-reviewed with `gemini-3-pro-preview`. For new reviews, use `mcp__antigravity_mcp__ask_ai`; do not use either CLI.

Requested model: `gemini-3-pro`.

Result: the installed legacy Gemini CLI rejected `gemini-3-pro` with `ModelNotFoundError`, so the review was run with `gemini-2.5-pro`, the available Pro model exposed by the local tool metadata. The exact limitation is preserved here so the review trail stays honest.

Review summary:

- Architecture was judged sound, especially the criterion-scoped evidence pipeline, primary/reviewer model flow, and evidence authority hierarchy.
- The plan was judged strong on keeping Calorix-specific behavior in config/examples rather than core code.
- Must-fix gaps were identified for platform-specific capture adapters, model-assisted target segmentation beyond the initial stub, and optional OCR backend integration.
- The model health check needed to verify real multimodal JSON-schema behavior, not only API availability.
- The `auto:best-free-vision` registry needed a static curated fallback list because provider metadata APIs can be inconsistent.

Changes incorporated after review:

- Added Task 8 for Android/iOS/no-op capture adapters.
- Added Task 11 for optional OCR backend integration.
- Added Task 12 for model-assisted target segmentation.
- Strengthened Task 7 with a curated fallback model list.
- Strengthened Task 14 with deep multimodal structured-output health checks.

Second review with `gemini-3-pro-preview`:

- `AGREEMENT_STATUS: agree`
- Must-fix items: none.
- Should-fix item: add bounded concurrency for criterion judge calls to avoid rate limits and extreme latency.

Change incorporated after second review:

- Strengthened Task 13 with configurable bounded model-call concurrency and deterministic report ordering.

Final agreement pass with `gemini-3-pro-preview`:

- `AGREEMENT_STATUS: agree`
- Must-fix items: none.
- Gemini's final rationale: bounded concurrency completes the architecture by making model-call execution robust against rate limits while preserving deterministic reports.
