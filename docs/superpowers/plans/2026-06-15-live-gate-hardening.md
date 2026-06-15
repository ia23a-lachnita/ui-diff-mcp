# Live Gate Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the real MCP live gates production-signable by fixing default free-mode model selection validation, deterministic geometry coverage, recovery runtime bounds, and long-running MCP execution behavior.

**Architecture:** Keep the existing typed TypeScript pipeline, but separate synchronous MCP response guarantees from long-running analysis work. Deterministic code must own obvious geometry/coverage records before model calls; VLMs classify ambiguous visual changes and target recovery under explicit budgets. Reports must be written incrementally enough that a timeout or budget stop still leaves a structured, readable incomplete report.

**Tech Stack:** Node.js 22+, TypeScript ESM, MCP TypeScript SDK, Zod, Sharp, pixelmatch, Vitest, LocateAnything sidecar, native NVIDIA VLM API, OpenRouter free routes, optional LangGraph only after the state-machine interfaces in this plan exist.

---

## Live Evidence From 2026-06-15

### Gate Results

| Gate | Command shape | Result | Evidence |
| --- | --- | --- | --- |
| Generic MCP default free | MCP `discover_ui_diffs` with generated two-button fixture and `mode: "free"` | Failed production criterion | `status: "complete"` but `visualClassificationStatus: "incomplete"` |
| Calorix bounded smoke | `npm run verify:calorix-live` with `UI_DIFF_MAX_AUDIT_PAIRS=3` and `mode: "free"` | Failed | MCP request timed out after about 10 minutes |
| Calorix full audit | `npm run verify:calorix-full-live` with no pair limit and `mode: "free"` | Failed | MCP request timed out after about 30 minutes |

### Generic MCP Free-Mode Findings

- Selected auditor: `nvidia/moonshotai/kimi-k2.6`, `costClass: "free"`.
- Selected reviewer: `nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`, `costClass: "free"`.
- LocateAnything produced weak coverage on the synthetic fixture:
  - Expected elements: 1.
  - Actual elements: 2.
  - Pairs: 2.
- The shifted button became two `unclassified_visual_change` records:
  - `{ x: 20, y: 50, width: 160, height: 20 }`.
  - `{ x: 20, y: 94, width: 160, height: 20 }`.
- Root cause: obvious movement geometry is not converted into a deterministic accepted geometry diff with a union location covering expected and actual boxes, so coverage falls through to unclassified pixel components when the VLM audit/recovery does not accept a classified diff.

### Calorix Findings

- Bounded run artifact directory: `C:/Users/xursc/projects/calorix/.ui-diff/runs/run-1781496846086-f1c078`.
- Full run artifact directory: `C:/Users/xursc/projects/calorix/.ui-diff/runs/run-1781497469705-405ac2`.
- No `report.json` was written before either timeout.
- Bounded run wrote 428 artifact files, mostly `recovery-*` PNGs.
- Full run wrote 488 artifact files, mostly `recovery-*` PNGs.
- Root cause: `runTargetRecovery()` attempts one model classification and one reviewer call per uncovered pixel component, sequentially, with no total run budget, no recovery component cap, no checkpointed partial report, and no MCP-level async handle.

### Provider/Model Findings

- Strong native NVIDIA routes are reachable in default `free` mode, but probes expose provider-specific constraints:
  - `moonshotai/kimi-k2.6` passed as auditor but failed the current reviewer probe content check.
  - `minimaxai/minimax-m3` returned non-JSON through the current NVIDIA adapter/probe.
  - `mistralai/mistral-large-3-675b-instruct-2512` returned schema-valid but content-inaccurate probe answers.
  - `meta/llama-3.2-*vision-instruct` NVIDIA routes rejected multi-image requests.
  - Several OpenRouter free routes hit HTTP 429.
- Root cause: the current probe is a single two-image toy task. It does not distinguish role-specific capabilities such as max image count, JSON mode reliability, crop-audit suitability, recovery suitability, or reviewer suitability.

## Research Notes

- MCP structured tool results should include `structuredContent` that matches the tool output schema, so all new run-state or async tools must keep strict output schemas. Source: [MCP tools specification](https://modelcontextprotocol.io/specification/draft/server/tools).
- MCP has no implicit protocol-level state handle; stateful tools should return explicit handles and accept them in later calls. This supports a long-run `runId`/handle design instead of trying to hold long Calorix audits inside one request. Source: [MCP tools specification](https://modelcontextprotocol.io/specification/draft/server/tools).
- OpenRouter structured outputs are model-dependent and should be enforced with `response_format: { type: "json_schema" }`, local validation, and provider capability checks. Source: [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs).
- NVIDIA VLM support and image limits vary by model/release; the live run confirmed this with single-image-only errors on Llama vision routes. Source: [NVIDIA NIM VLM overview](https://docs.nvidia.com/nim/vision-language-models/latest/introduction.html) and [NVIDIA NIM VLM support matrix](https://docs.nvidia.com/nim/vision-language-models/1.5.0/support-matrix.html).
- LangGraph.js can help later with durable state and resumability, but first this project needs explicit stage-state objects, checkpoints, and idempotent report writes. Source: [LangGraph.js reference](https://reference.langchain.com/javascript/langchain-langgraph).

## File Structure

- Modify `tests/live/mcp-full.live.test.ts`: make the generic live MCP gate use default `mode: "free"` and assert exact model selection is recorded without forcing OpenRouter-only providers.
- Create `tests/live/mcp-openrouter-free.live.test.ts`: preserve the OpenRouter-only free route gate separately.
- Modify `package.json`: split scripts into `verify:mcp-live`, `verify:openrouter-free-live`, and keep provider probe gates explicit.
- Modify `scripts/require-live-env.js`: document and validate the new live gate names.
- Modify `src/models/model-registry.ts`: add role-specific route capability metadata and selection rules.
- Modify `src/models/probes.ts`: replace the single toy probe with role-specific probes.
- Modify `src/models/vision-json.ts`: record provider response mode, image count, latency, and parse mode in caller metadata.
- Create `src/diff/deterministic-diffs.ts`: produce deterministic diff records for geometry, presence, and high-confidence color changes.
- Modify `src/pipeline/run-ui-diff.ts`: insert deterministic diff generation before VLM audit, add run budgets, checkpoint reports, and recovery limits.
- Modify `src/recovery/target-recovery.ts`: add component clustering, ranking, caps, deadline checks, and graceful incomplete output.
- Modify `src/report/report-writer.ts`: support checkpoint/partial report writes and atomic final writes.
- Modify `src/schemas/core.ts`: add run budget, stage status, recovery summary, and checkpoint metadata.
- Modify `src/server.ts`: add async long-run tool surface or bounded foreground behavior with explicit incomplete report paths.
- Add tests under `tests/unit/**` and `tests/integration/**` for deterministic geometry, role-specific probes, recovery caps, partial reports, and MCP long-run behavior.
- Modify `docs/implementation-status.md`: track execution of this hardening plan.
- Modify `docs/release/production-readiness-checklist.md`: make the corrected live gates required before production sign-off.

## Task 1: Correct Live Gate Semantics

**Files:**
- Modify: `tests/live/mcp-full.live.test.ts`
- Create: `tests/live/mcp-openrouter-free.live.test.ts`
- Modify: `package.json`
- Modify: `scripts/require-live-env.js`
- Modify: `docs/release/production-readiness-checklist.md`

- [ ] **Step 1: Change the generic MCP live gate to default free mode**

In `tests/live/mcp-full.live.test.ts`, change the tool call to:

```ts
arguments: {
  expectedImagePath: expected,
  actualImagePath: actual,
  projectRoot: tmpDir,
  mode: "free"
}
```

Replace OpenRouter-only provider assertions with:

```ts
expect(report.modelSelection?.auditor).toEqual(expect.objectContaining({
  provider: expect.stringMatching(/^(nvidia|openrouter)$/),
  model: expect.any(String),
  costClass: "free"
}));
expect(report.modelSelection?.reviewer).toEqual(expect.objectContaining({
  provider: expect.stringMatching(/^(nvidia|openrouter)$/),
  model: expect.any(String),
  costClass: "free"
}));
```

- [ ] **Step 2: Preserve the OpenRouter-only gate as its own test file**

Create `tests/live/mcp-openrouter-free.live.test.ts` by copying the current OpenRouter-specific behavior from `mcp-full.live.test.ts`, keeping `mode: "free_openrouter"` and provider assertions set to `openrouter`.

- [ ] **Step 3: Split npm scripts**

In `package.json`, change:

```json
"verify:live": "node scripts/require-live-env.js RUN_UI_DIFF_LIVE && npm run build && npm run test:live"
```

to:

```json
"verify:mcp-live": "node scripts/require-live-env.js RUN_UI_DIFF_LIVE && npm run build && vitest run tests/live/mcp-full.live.test.ts --testTimeout 900000",
"verify:openrouter-free-live": "node scripts/require-live-env.js RUN_OPENROUTER_FREE_LIVE && npm run build && vitest run tests/live/openrouter.live.test.ts tests/live/mcp-openrouter-free.live.test.ts --testTimeout 300000"
```

Keep `verify:free-live` for backward compatibility for one release by making it call `verify:openrouter-free-live`.

- [ ] **Step 4: Update env guard messages**

In `scripts/require-live-env.js`, add explicit cases:

```js
} else if (varName === "RUN_OPENROUTER_FREE_LIVE") {
  console.error("Also set OPENROUTER_API_KEY and LOCATEANYTHING_SIDECAR_URL before running verify:openrouter-free-live.");
} else if (varName === "RUN_UI_DIFF_LIVE") {
  console.error("Also set OPENROUTER_API_KEY, NVIDIA_API_KEY, and LOCATEANYTHING_SIDECAR_URL before running verify:mcp-live.");
}
```

- [ ] **Step 5: Verify**

Run:

```powershell
npm run verify
$env:RUN_UI_DIFF_LIVE='1'; $env:LOCATEANYTHING_SIDECAR_URL='http://127.0.0.1:39731'; npm run verify:mcp-live
```

Expected before later tasks: `verify:mcp-live` may still fail with `visualClassificationStatus: "incomplete"`, but it must select default `free` mode and record exact models.

- [ ] **Step 6: Commit**

```powershell
git add tests/live/mcp-full.live.test.ts tests/live/mcp-openrouter-free.live.test.ts package.json scripts/require-live-env.js docs/release/production-readiness-checklist.md docs/implementation-status.md
git commit -m "test: split default and openrouter live gates"
git push origin master
```

## Task 2: Add Role-Specific Model Capability Probes

**Files:**
- Modify: `src/models/model-registry.ts`
- Modify: `src/models/probes.ts`
- Modify: `src/models/vision-json.ts`
- Test: `tests/unit/model-registry.test.ts`
- Test: `tests/unit/model-probes.test.ts`
- Test: `tests/live/nvidia-live.test.ts`

- [ ] **Step 1: Add route capability metadata**

Extend `ModelEntry` in `src/models/model-registry.ts`:

```ts
export interface ModelRouteCapabilities {
  maxImages: number;
  supportsJsonSchema: boolean;
  supportsJsonObject: boolean;
  supportsStreaming: boolean;
  allowedRoles: Array<"auditor" | "reviewer" | "target_recovery">;
}
```

Each candidate route must include capabilities. Initial values must be derived from live evidence:

```ts
{ provider: "nvidia", model: "meta/llama-3.2-90b-vision-instruct", capabilities: { maxImages: 1, supportsJsonSchema: true, supportsJsonObject: true, supportsStreaming: true, allowedRoles: ["reviewer"] } }
```

Routes with 404 from NVIDIA live probes must be marked `enabled: false` until research/probes confirm the endpoint name.

- [ ] **Step 2: Replace the single probe with three role probes**

In `src/models/probes.ts`, implement:

```ts
export async function probeAuditCapability(entry: ModelEntry): Promise<ProbeResult>
export async function probeReviewerCapability(entry: ModelEntry): Promise<ProbeResult>
export async function probeRecoveryCapability(entry: ModelEntry): Promise<ProbeResult>
```

Audit probe input must use five images because `auditElementPair()` sends expected crop, actual crop, directional overlay, pixel mask, and context crop.

Recovery probe input must use four images because `runTargetRecovery()` sends expected crop, actual crop, overlay, and mask.

Reviewer probe must use a fixed synthetic maximum payload of five images because probes run before actual audit records exist. The five images represent the largest reviewer evidence packet used by the current audit path: expected crop, actual crop, directional overlay, pixel mask, and context crop.

- [ ] **Step 3: Add parse-mode fallback without silent downgrade**

In `src/models/vision-json.ts`, add an explicit `jsonMode` request option:

```ts
jsonMode: "json_schema" | "json_object" | "parser_only"
```

Only use `parser_only` when the probe result records `jsonSchemaMode: "parser_only"` and the model returned valid JSON in the role probe. Record the mode in `modelHealth` and `modelSelection`.

- [ ] **Step 4: Update selection**

In `selectModelForMode()`, filter by:

```ts
probe.status === "pass" &&
probe.role === logicalRole &&
probe.maxImagesSupported >= requiredImagesForRole(logicalRole) &&
probe.schemaValid === true &&
probe.contentAccurate === true
```

Do not select a model for reviewer if it passed only the auditor probe.

- [ ] **Step 5: Verify**

Run:

```powershell
npm run verify
$env:RUN_NVIDIA_LIVE='1'; npm run verify:nvidia-live
```

Expected: failed providers remain visible in `modelHealth`; selected models are role-capable for their actual image counts.

- [ ] **Step 6: Commit**

```powershell
git add src/models tests/unit/model-registry.test.ts tests/unit/model-probes.test.ts tests/live/nvidia-live.test.ts docs/implementation-status.md
git commit -m "feat: add role-specific model probes"
git push origin master
```

## Task 3: Deterministic Geometry And Presence Diff Records

**Files:**
- Create: `src/diff/deterministic-diffs.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Test: `tests/unit/deterministic-diffs.test.ts`
- Test: `tests/e2e/compare-ui-images.test.ts`

- [ ] **Step 1: Create deterministic diff generator**

Create `src/diff/deterministic-diffs.ts`:

```ts
import crypto from "node:crypto";
import type { Box, DiffRecord, ElementPair, UiElement } from "../schemas/core.js";

export function unionBox(a: Box, b: Box): Box {
  const x1 = Math.min(a.x, b.x);
  const y1 = Math.min(a.y, b.y);
  const x2 = Math.max(a.x + a.width, b.x + b.width);
  const y2 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function buildDeterministicDiffs(input: {
  pairs: ElementPair[];
  expectedElements: UiElement[];
  actualElements: UiElement[];
  minMovePx: number;
}): DiffRecord[] {
  const diffs: DiffRecord[] = [];
  for (const pair of input.pairs) {
    const expected = input.expectedElements.find(e => e.id === pair.expectedId);
    const actual = input.actualElements.find(e => e.id === pair.actualId);
    if (pair.status === "matched" && expected && actual) {
      const dx = Math.round(actual.box.x - expected.box.x);
      const dy = Math.round(actual.box.y - expected.box.y);
      const dw = Math.round(actual.box.width - expected.box.width);
      const dh = Math.round(actual.box.height - expected.box.height);
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dw) + Math.abs(dh) >= input.minMovePx) {
        diffs.push({
          id: crypto.randomBytes(6).toString("hex"),
          pairId: pair.id,
          criterion: "geometry",
          severity: Math.abs(dx) + Math.abs(dy) >= 12 ? "high" : "medium",
          title: `${expected.label} geometry differs`,
          location: unionBox(expected.box, actual.box),
          evidence: [
            `Expected box x=${expected.box.x}, y=${expected.box.y}, w=${expected.box.width}, h=${expected.box.height}.`,
            `Actual box x=${actual.box.x}, y=${actual.box.y}, w=${actual.box.width}, h=${actual.box.height}.`,
            `Delta dx=${dx}px, dy=${dy}px, dw=${dw}px, dh=${dh}px.`
          ],
          measurements: [
            { name: "deltaX", value: dx, unit: "px" },
            { name: "deltaY", value: dy, unit: "px" },
            { name: "deltaWidth", value: dw, unit: "px" },
            { name: "deltaHeight", value: dh, unit: "px" }
          ],
          artifactPaths: [],
          reviewerStatus: "accepted",
          model: "deterministic"
        });
      }
    }
    if (pair.status === "missing" && expected) {
      diffs.push({
        id: crypto.randomBytes(6).toString("hex"),
        pairId: pair.id,
        criterion: "presence",
        severity: "high",
        title: `${expected.label} missing in actual screenshot`,
        location: expected.box,
        evidence: [`Expected element exists at x=${expected.box.x}, y=${expected.box.y}, w=${expected.box.width}, h=${expected.box.height}; no actual element was paired.`],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "accepted",
        model: "deterministic"
      });
    }
    if (pair.status === "extra" && actual) {
      diffs.push({
        id: crypto.randomBytes(6).toString("hex"),
        pairId: pair.id,
        criterion: "presence",
        severity: "medium",
        title: `${actual.label} extra in actual screenshot`,
        location: actual.box,
        evidence: [`Actual element exists at x=${actual.box.x}, y=${actual.box.y}, w=${actual.box.width}, h=${actual.box.height}; no expected element was paired.`],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "accepted",
        model: "deterministic"
      });
    }
  }
  return diffs;
}
```

- [ ] **Step 2: Insert before VLM audit**

In `src/pipeline/run-ui-diff.ts`, after `const pairs = pairElements(...)`, call:

```ts
const deterministicDiffs = buildDeterministicDiffs({
  pairs,
  expectedElements,
  actualElements,
  minMovePx: 4
});
allDiffs.push(...deterministicDiffs);
```

When later calling `findUncoveredComponents()`, pass `allDiffs`, not only VLM `merged` diffs.

Document the limitation in `docs/release/production-readiness-checklist.md`: union-box coverage intentionally prevents shifted elements from being reported as unclassified pixel fragments, but unrelated changes inside the same union box may be considered covered until the later shape-aware coverage task exists.

- [ ] **Step 3: Add regression test for shifted button**

In `tests/unit/deterministic-diffs.test.ts`, assert a 20px vertical shift produces one geometry diff whose `location` covers both old and new button boxes:

```ts
expect(diff.location).toEqual({ x: 20, y: 50, width: 160, height: 64 });
expect(diff.reviewerStatus).toBe("accepted");
expect(diff.model).toBe("deterministic");
```

- [ ] **Step 4: Verify**

Run:

```powershell
npm run verify
$env:RUN_UI_DIFF_LIVE='1'; $env:LOCATEANYTHING_SIDECAR_URL='http://127.0.0.1:39731'; npm run verify:mcp-live
```

Expected: the generic shifted-button live gate ends with `visualClassificationStatus: "complete"` or fails only because locator pairing did not produce a usable matched pair.

- [ ] **Step 5: Commit**

```powershell
git add src/diff src/pipeline/run-ui-diff.ts tests/unit/deterministic-diffs.test.ts tests/e2e/compare-ui-images.test.ts docs/implementation-status.md
git commit -m "feat: add deterministic geometry diffs"
git push origin master
```

## Task 4: Make Locator Output Usable For Geometry Diffing

**Files:**
- Modify: `src/locator/element-map.ts`
- Modify: `src/pairing/pair-elements.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Test: `tests/unit/element-map.test.ts`
- Test: `tests/unit/pair-elements.test.ts`

- [ ] **Step 1: Normalize useless labels**

In `buildElementMap()`, replace numeric-only or prompt-echo labels with a generated label:

```ts
function normalizeElementLabel(rawLabel: string, queryId: string, type: UiElementType, index: number): string {
  const trimmed = rawLabel.trim();
  if (/^\d+$/.test(trimmed) || trimmed.toLowerCase().startsWith("locate ")) {
    return `${type}-${queryId}-${index}`;
  }
  return trimmed;
}
```

- [ ] **Step 2: Preserve query category as evidence**

Add `queryId` to internal element metadata if the schema already allows it; if not, add `locatorQueryId?: string` to `UiElementSchema`.

- [ ] **Step 3: Relax pairing for same-region cross-type locator mistakes**

In `pairElements()`, when geometry score is high and one side is `text` while the other is `image` or `unknown`, do not force a low type score to dominate. Use:

```ts
const typeScore = expected.type === actual.type ? 1 : geometryScore >= 0.72 ? 0.55 : 0;
```

- [ ] **Step 4: Add synthetic locator regression**

Test expected label `"0"` of type `text` and actual prompt-echo label `"Locate images thumbnails and avatars"` of type `image` with overlapping/shifted boxes. Expected: generated labels, a matched or uncertain pair, and deterministic geometry can still cover the shift.

- [ ] **Step 5: Verify**

Run:

```powershell
npm run verify
$env:RUN_UI_DIFF_LIVE='1'; $env:LOCATEANYTHING_SIDECAR_URL='http://127.0.0.1:39731'; npm run verify:mcp-live
```

- [ ] **Step 6: Commit**

```powershell
git add src/locator/element-map.ts src/pairing/pair-elements.ts src/pipeline/run-ui-diff.ts tests/unit/element-map.test.ts tests/unit/pair-elements.test.ts docs/implementation-status.md
git commit -m "fix: make locator pairing robust to weak labels"
git push origin master
```

## Task 5: Bound And Rank Target Recovery

**Files:**
- Modify: `src/recovery/target-recovery.ts`
- Modify: `src/report/coverage.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/schemas/core.ts`
- Test: `tests/unit/target-recovery.test.ts`
- Test: `tests/unit/coverage.test.ts`

- [ ] **Step 1: Add recovery config**

Create this interface in `src/recovery/target-recovery.ts`:

```ts
export interface RecoveryBudget {
  maxComponents: number;
  maxModelCalls: number;
  deadlineMs: number;
  minComponentPixels: number;
}
```

Default values:

```ts
const DEFAULT_RECOVERY_BUDGET: RecoveryBudget = {
  maxComponents: 12,
  maxModelCalls: 24,
  deadlineMs: 120000,
  minComponentPixels: 80
};
```

Allow env overrides:

```ts
UI_DIFF_MAX_RECOVERY_COMPONENTS
UI_DIFF_MAX_RECOVERY_MODEL_CALLS
UI_DIFF_RECOVERY_BUDGET_MS
UI_DIFF_MIN_RECOVERY_PIXELS
```

- [ ] **Step 2: Rank components before recovery**

Sort uncovered components by:

```ts
pixelCount descending,
box.width * box.height descending,
y ascending,
x ascending
```

Only the first `maxComponents` are sent to VLM recovery. The rest must be counted in `skippedComponents`.

- [ ] **Step 3: Stop on deadline and return partial results**

Inside the recovery loop, check:

```ts
if (Date.now() >= budget.deadlineMs) {
  stoppedReason = "deadline_exceeded";
  break;
}
```

Return:

```ts
{
  recovered,
  unclassifiedCount,
  attemptedComponents,
  skippedComponents,
  stoppedReason
}
```

- [ ] **Step 4: Add recovery summary to report**

In `src/schemas/core.ts`, add:

```ts
export const RecoverySummarySchema = z.object({
  totalUncoveredComponents: z.number().int().min(0),
  attemptedComponents: z.number().int().min(0),
  skippedComponents: z.number().int().min(0),
  recoveredDiffs: z.number().int().min(0),
  unclassifiedCount: z.number().int().min(0),
  stoppedReason: z.enum(["none", "component_cap", "model_call_cap", "deadline_exceeded"]).default("none")
});
```

Add `recoverySummary?: RecoverySummary` to `UiDiffReportSchema`.

- [ ] **Step 5: Verify recovery no longer explodes**

Add a unit test with 100 uncovered components and `maxComponents: 5`. Expected:

```ts
expect(result.attemptedComponents).toBe(5);
expect(result.skippedComponents).toBe(95);
```

- [ ] **Step 6: Commit**

```powershell
git add src/recovery src/report src/pipeline/run-ui-diff.ts src/schemas/core.ts tests/unit/target-recovery.test.ts tests/unit/coverage.test.ts docs/implementation-status.md
git commit -m "fix: bound target recovery work"
git push origin master
```

## Task 6: Write Partial Reports Before Long Model Work

**Files:**
- Modify: `src/report/report-writer.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/schemas/core.ts`
- Test: `tests/unit/report-writer.test.ts`
- Test: `tests/integration/mcp-tools.integration.test.ts`

- [ ] **Step 1: Add stage status**

In `src/schemas/core.ts`, add:

```ts
export const StageStatusSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["pending", "running", "complete", "failed", "skipped"]),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().min(0).optional(),
  detail: z.string().optional()
});
```

Add `stages: z.array(StageStatusSchema).default([])` to `UiDiffReportSchema`.

- [ ] **Step 2: Add checkpoint writer**

In `src/report/report-writer.ts`, implement:

```ts
export async function writeReportCheckpoint(report: UiDiffReport): Promise<string> {
  const reportPath = path.join(report.artifactRoot, "report.json");
  const tmpPath = `${reportPath}.tmp`;
  await fs.mkdir(report.artifactRoot, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(UiDiffReportSchema.parse(report), null, 2));
  await fs.rename(tmpPath, reportPath);
  return reportPath;
}
```

- [ ] **Step 3: Checkpoint after each major stage**

In `run-ui-diff.ts`, call `writeReportCheckpoint()` after:

1. normalization and deterministic artifacts,
2. locator and pairing,
3. deterministic diffs,
4. model probing,
5. audit loop,
6. target recovery.

If a later stage times out internally, the latest `report.json` must still exist with `status: "incomplete"` and `visualClassificationStatus: "incomplete"`.

- [ ] **Step 4: Verify**

Add a test that injects a recovery caller which waits beyond a tiny deadline. Expected: `report.json` exists, schema-valid, and records the stopped recovery stage.

- [ ] **Step 5: Commit**

```powershell
git add src/report/report-writer.ts src/pipeline/run-ui-diff.ts src/schemas/core.ts tests/unit/report-writer.test.ts tests/integration/mcp-tools.integration.test.ts docs/implementation-status.md
git commit -m "feat: checkpoint ui diff reports"
git push origin master
```

## Task 7: Add MCP Long-Run Handle For Calorix-Scale Audits

**Files:**
- Modify: `src/server.ts`
- Create: `src/pipeline/run-store.ts`
- Modify: `src/schemas/tool-schemas.ts`
- Test: `tests/integration/mcp-tools.integration.test.ts`

- [ ] **Step 1: Add run store**

Create `src/pipeline/run-store.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";

export interface RunHandleState {
  runId: string;
  status: "queued" | "running" | "complete" | "incomplete" | "failed";
  reportPath?: string;
  artifactRoot?: string;
  projectRoot: string;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

const runs = new Map<string, RunHandleState>();

export async function putRun(state: RunHandleState): Promise<void> {
  runs.set(state.runId, state);
  const stateDir = path.join(state.projectRoot, ".ui-diff", "generated", "run-state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, `${state.runId}.json`), JSON.stringify(state, null, 2));
}

export async function getRun(projectRoot: string, runId: string): Promise<RunHandleState | undefined> {
  const inMemory = runs.get(runId);
  if (inMemory) return inMemory;
  const statePath = path.join(projectRoot, ".ui-diff", "generated", "run-state", `${runId}.json`);
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8")) as RunHandleState;
  } catch {
    return undefined;
  }
}
```

The filesystem state is required because stdio MCP servers may be restarted with the client; an in-memory map alone loses run handles.

- [ ] **Step 2: Add async tool**

In `src/server.ts`, add `start_ui_diff_run`. It starts `runUiDiff()` without holding the MCP request open and returns:

```json
{
  "runId": "run-...",
  "status": "queued",
  "message": "Run started. Poll read_ui_diff_report or get_ui_diff_run_status."
}
```

- [ ] **Step 3: Add status tool**

Add `get_ui_diff_run_status` with input `{ "projectRoot": "...", "runId": "..." }` and output:

```json
{
  "runId": "run-...",
  "status": "running",
  "reportPath": "...",
  "artifactRoot": "..."
}
```

- [ ] **Step 4: Keep foreground tool bounded**

`discover_ui_diffs` must still work, but it should enforce `UI_DIFF_FOREGROUND_BUDGET_MS` defaulting to 45000 ms. The value must always be shorter than the client RPC timeout passed by tests or caller integrations. If the budget is exceeded, return structured output with `status: "incomplete"` and a report path, not an MCP timeout.

- [ ] **Step 5: Verify**

Add an integration test where the model caller waits longer than the foreground budget. Expected: no MCP protocol timeout; the tool returns a structured incomplete result.

- [ ] **Step 6: Commit**

```powershell
git add src/server.ts src/pipeline/run-store.ts src/schemas/tool-schemas.ts tests/integration/mcp-tools.integration.test.ts docs/implementation-status.md
git commit -m "feat: add async ui diff run handles"
git push origin master
```

## Task 8: Final Live Gates And Release Sign-Off

**Files:**
- Modify: `docs/implementation-status.md`
- Modify: `docs/release/production-readiness-checklist.md`

- [ ] **Step 1: Run deterministic verification**

```powershell
npm run verify
npm run test:coverage
git diff --check
```

Expected: all pass. Coverage must stay at or above the configured thresholds.

- [ ] **Step 2: Run provider gates**

```powershell
$env:RUN_OPENROUTER_FREE_LIVE='1'; $env:LOCATEANYTHING_SIDECAR_URL='http://127.0.0.1:39731'; npm run verify:openrouter-free-live
$env:RUN_NVIDIA_LIVE='1'; npm run verify:nvidia-live
```

Expected: at least one role-capable free route passes for auditor and reviewer; exact selected providers/models are logged and recorded.

- [ ] **Step 3: Run default MCP live gate**

```powershell
$env:RUN_UI_DIFF_LIVE='1'; $env:LOCATEANYTHING_SIDECAR_URL='http://127.0.0.1:39731'; npm run verify:mcp-live
```

Expected: `status !== "failed"`, `visualClassificationStatus === "complete"` for the shifted-button fixture, and a deterministic geometry diff covers both changed pixel components.

- [ ] **Step 4: Run Calorix bounded live gate**

```powershell
$env:RUN_CALORIX_UI_DIFF_LIVE='1'
$env:LOCATEANYTHING_SIDECAR_URL='http://127.0.0.1:39731'
$env:UI_DIFF_LIVE_EXPECTED_IMAGE='C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png'
$env:UI_DIFF_LIVE_ACTUAL_IMAGE='C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-09-criterion-audit-validation.png'
$env:UI_DIFF_MAX_AUDIT_PAIRS='3'
npm run verify:calorix-live
```

Expected: no MCP timeout. If the report is incomplete, it must include `reportPath`, `recoverySummary`, selected models, and all deterministic artifacts.

- [ ] **Step 5: Run Calorix full live gate**

```powershell
Remove-Item Env:UI_DIFF_MAX_AUDIT_PAIRS -ErrorAction SilentlyContinue
$env:RUN_CALORIX_FULL_LIVE='1'
$env:LOCATEANYTHING_SIDECAR_URL='http://127.0.0.1:39731'
$env:UI_DIFF_LIVE_EXPECTED_IMAGE='C:\Users\xursc\projects\calorix\docs\mockups\image\dark\single\Today.png'
$env:UI_DIFF_LIVE_ACTUAL_IMAGE='C:\Users\xursc\projects\calorix\docs\screenshots\today-screen-2026-06-09-criterion-audit-validation.png'
npm run verify:calorix-full-live
```

Expected: no MCP timeout. A complete full audit is preferred; an incomplete full audit is acceptable only if it stops by explicit budget and writes a schema-valid report naming exactly what remained unclassified.

- [ ] **Step 6: Commit final sign-off status**

```powershell
git add docs/implementation-status.md docs/release/production-readiness-checklist.md
git commit -m "docs: record live gate hardening signoff"
git push origin master
```

## Acceptance Criteria

- The default production MCP live gate uses `mode: "free"`, not `mode: "free_openrouter"`.
- OpenRouter-only live behavior remains tested separately.
- Every report records exact selected provider/model/cost class/json mode for auditor and reviewer.
- Obvious geometry movement creates deterministic accepted diff records with union boxes that cover the changed pixel mass.
- Target recovery has component, model-call, and deadline budgets.
- Calorix bounded and full live gates do not end in MCP protocol timeout.
- A stopped or incomplete run still writes a schema-valid `report.json`.
- No report contains root-cause explanations, implementation advice, or acceptance language.
- No user-authored target maps, ROI maps, ignore masks, or anchor dumps are introduced.

## Gemini Review

Gemini CLI using `gemini-3.1-pro-preview` reviewed the plan on 2026-06-15.

- `AGREEMENT_STATUS: agree`.
- Must-fix: foreground budget default was too close to likely MCP client timeouts. Applied: Task 7 now defaults to `45000 ms` and requires it to be shorter than client RPC timeout.
- Must-fix: reviewer probes cannot depend on real audit records because probes happen before audits. Applied: Task 2 now uses a fixed five-image reviewer probe.
- Should-fix: in-memory run handles are fragile for stdio MCP restarts. Applied: Task 7 now persists run handle state under `.ui-diff/generated/run-state/`.
- Should-fix: union-box deterministic geometry coverage can hide unrelated changes inside the union box. Applied: Task 3 now requires documenting this limitation in the production checklist.

Final Gemini blocker pass after revisions:

- `AGREEMENT_STATUS: agree`.
- `MUST_FIX: None`.
- `SHOULD_FIX: None`.
- Notes: all prior findings were addressed; the plan is ready for execution.
