# Provider Fallback And Projection Gates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two independent pipeline improvements that increase robustness and reduce wasted VLM quota:

1. **Provider fallback** — when the selected auditor or reviewer fails with a retryable error (HTTP 5xx, 429, timeout, network), automatically retry the call using the next ranked model that passed probes, rather than recording `auditor_error` and losing the audit permanently.
2. **Projection gate** — in single-pass (projection) mode only, filter pairs before the VLM audit loop by measuring the changed-pixel ratio in the projected bounding box; pairs below threshold skip VLM entirely and record a `projection_gate_no_change` trace entry.

**Architecture:** Fallback is encapsulated in a `VisionJsonCaller` wrapper; `audit-target.ts` and `target-recovery.ts` are unchanged. Projection gate is a pre-loop filter in the pipeline with structured trace output. Both improvements surface in the existing `debugSummary` field.

**Tech Stack:** TypeScript ESM, Zod v4, Vitest, existing pipeline and model-registry infrastructure.

---

## Problem

**Provider failures cascade.** The current pipeline selects one auditor and one reviewer at the start of the run. Both are used for every audit pair. If either experiences a retryable error (HTTP 5xx, 429, timeout), every criterion call for that pair records `auditor_error` and moves on. The June 17 Calorix debug trace confirmed this pattern: the full run had 81 projected pairs and a high audit error rate, leaving `visualClassificationStatus: "incomplete"`. A fallback to the next ranked passing model would absorb transient provider failures without losing audit coverage.

**Projected no-change pairs waste quota.** In single-pass mode, `projectElementsToActual` copies ALL expected element boxes to the actual image. Elements whose location and content did not change are still paired and sent through the full VLM audit (5+ model calls each). Most real screenshots have large unchanged regions. A pixel-diff gate that skips pairs where the projected region contains fewer than 2% changed pixels would eliminate these before any model call, saving quota and reducing run time.

---

## File Structure

- Create `src/models/fallback-caller.ts`
- Modify `src/models/model-registry.ts`: add `selectFallbackModelsForMode`
- Modify `src/schemas/core.ts`: add `"projection_gate_no_change"` to `AuditDecisionStatusSchema`; add `projectionGated` to `RunDebugSummarySchema`
- Create `src/pairing/projection-gate.ts`
- Modify `src/pipeline/run-ui-diff.ts`: use fallback callers, apply projection gate
- Modify `src/debug/run-debug.ts`: update `summarizeRunDebug` to count `projectionGated`
- Create `tests/unit/fallback-caller.test.ts`
- Create `tests/unit/projection-gate.test.ts`
- Modify `tests/e2e/compare-ui-images.test.ts`: assert `debugSummary.projectionGated` is defined
- Modify `tests/live/calorix-smoke.live.test.ts`: assert `projectionGated >= 0`
- Modify `docs/release/production-readiness-checklist.md`: add gate and fallback checks
- Modify `docs/implementation-status.md`: track this plan

---

## Task 1: Fallback Vision Caller Module

**Files:**
- Create: `src/models/fallback-caller.ts`
- Modify: `src/models/model-registry.ts`
- Create: `tests/unit/fallback-caller.test.ts`

- [ ] **Step 1: Create fallback caller module**

Create `src/models/fallback-caller.ts`:

```ts
import type { VisionJsonCaller } from "./vision-json.js";

export interface FallbackCandidate {
  caller: VisionJsonCaller;
  provider: string;
  model: string;
}

export function isRetryableProviderError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Retry on rate limit, server errors, and network failures.
  // Do NOT retry on 400 (bad request), 401 (auth), or JSON parse errors
  // from the provider — those indicate a non-transient problem.
  return /HTTP 429|HTTP 5\d{2}|request failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout/i.test(msg);
}

export function makeFallbackVisionCaller(candidates: FallbackCandidate[]): VisionJsonCaller {
  if (candidates.length === 0) {
    throw new Error("makeFallbackVisionCaller requires at least one candidate");
  }
  return async (req) => {
    let lastErr: unknown;
    for (const candidate of candidates) {
      try {
        return await candidate.caller(req);
      } catch (err) {
        lastErr = err;
        if (!isRetryableProviderError(err)) {
          throw err;
        }
        // Retryable: try next candidate
      }
    }
    throw lastErr;
  };
}
```

- [ ] **Step 2: Add selectFallbackModelsForMode to model-registry.ts**

Add after `selectModelForMode`:

```ts
export function selectFallbackModelsForMode(
  logicalRole: "auditor" | "reviewer" | "escalation" | "target_recovery",
  mode: VisionMode,
  probeResults: ProbeResult[],
  maxCandidates: number,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  excludedRoutes: Array<{ provider: ModelEntry["provider"]; model: string }> = []
): ModelEntry[] {
  const results: ModelEntry[] = [];
  const excluded = [...excludedRoutes];
  const seen = new Set<string>();

  while (results.length < maxCandidates) {
    const next = selectModelForMode(logicalRole, mode, probeResults, env, excluded);
    if (!next) break;
    const key = `${next.provider}:${next.model}`;
    if (seen.has(key)) break;
    seen.add(key);
    results.push(next);
    excluded.push({ provider: next.provider, model: next.model });
  }

  return results;
}
```

- [ ] **Step 3: Write tests**

Create `tests/unit/fallback-caller.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeFallbackVisionCaller, isRetryableProviderError, type FallbackCandidate } from "../../src/models/fallback-caller.js";

const dummyReq = { prompt: "test", images: [], jsonSchema: { name: "t", schema: {} }, timeoutMs: 5000 };
const ok1 = { parsed: {}, rawContent: "", model: "m1", provider: "nvidia" };
const ok2 = { parsed: {}, rawContent: "", model: "m2", provider: "openrouter" };

function cand(caller: FallbackCandidate["caller"], provider = "nvidia", model = "m1"): FallbackCandidate {
  return { caller, provider, model };
}

describe("makeFallbackVisionCaller", () => {
  it("returns first candidate response when no error", async () => {
    const result = await makeFallbackVisionCaller([cand(vi.fn().mockResolvedValue(ok1))])(dummyReq);
    expect(result.model).toBe("m1");
  });

  it("falls back to second candidate on HTTP 503", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("NVIDIA HTTP 503: service unavailable")), "nvidia", "m1");
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "openrouter", "m2");
    const result = await makeFallbackVisionCaller([c1, c2])(dummyReq);
    expect(result.model).toBe("m2");
  });

  it("falls back on HTTP 429 rate limit", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("OpenRouter HTTP 429: rate limited")));
    const c2 = cand(vi.fn().mockResolvedValue(ok2), "openrouter", "m2");
    const result = await makeFallbackVisionCaller([c1, c2])(dummyReq);
    expect(result.model).toBe("m2");
  });

  it("does NOT fall back on HTTP 400 bad request", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("OpenRouter HTTP 400: schema invalid")));
    const c2 = cand(vi.fn().mockResolvedValue(ok2));
    await expect(makeFallbackVisionCaller([c1, c2])(dummyReq)).rejects.toThrow("400");
  });

  it("does NOT fall back on JSON parse error", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("OpenRouter response content is not valid JSON: abc")));
    const c2 = cand(vi.fn().mockResolvedValue(ok2));
    await expect(makeFallbackVisionCaller([c1, c2])(dummyReq)).rejects.toThrow("not valid JSON");
  });

  it("throws last error when all candidates exhausted", async () => {
    const c1 = cand(vi.fn().mockRejectedValue(new Error("HTTP 429: rate limited")));
    const c2 = cand(vi.fn().mockRejectedValue(new Error("HTTP 503: overloaded")), "openrouter", "m2");
    await expect(makeFallbackVisionCaller([c1, c2])(dummyReq)).rejects.toThrow("HTTP 503");
  });

  it("throws when constructed with empty candidates", () => {
    expect(() => makeFallbackVisionCaller([])).toThrow("at least one candidate");
  });
});

describe("isRetryableProviderError", () => {
  it.each([
    ["NVIDIA HTTP 429: rate limited", true],
    ["NVIDIA HTTP 503: service unavailable", true],
    ["NVIDIA request failed: ETIMEDOUT", true],
    ["OpenRouter request failed: ECONNRESET", true],
    ["OpenRouter HTTP 400: bad request", false],
    ["OpenRouter HTTP 401: unauthorized", false],
    ["OpenRouter response content is not valid JSON: {}", false],
  ])("%s → %s", (msg, expected) => {
    expect(isRetryableProviderError(new Error(msg))).toBe(expected);
  });
});
```

- [ ] **Step 4: Verify**

```powershell
npx vitest run tests/unit/fallback-caller.test.ts
```

Expected: all tests pass.

---

## Task 2: Pipeline Uses Multi-Candidate Fallback Callers

**Files:**
- Modify: `src/pipeline/run-ui-diff.ts`

- [ ] **Step 1: Add imports**

Add to existing imports in `run-ui-diff.ts`:

```ts
import { makeFallbackVisionCaller } from "../models/fallback-caller.js";
import { selectFallbackModelsForMode } from "../models/model-registry.js";
```

- [ ] **Step 2: Replace single-entry model selection with ranked fallback list**

Find the section that calls `selectModelForMode` for auditor and reviewer, and replace:

```ts
const auditorEntry = selectModelForMode("auditor", mode, probeResults, process.env);
const reviewerEntry = selectModelForMode("reviewer", mode, probeResults, process.env);
```

with:

```ts
const auditorCandidates = selectFallbackModelsForMode("auditor", mode, probeResults, 3, process.env);
const reviewerCandidates = selectFallbackModelsForMode("reviewer", mode, probeResults, 3, process.env);
const auditorEntry = auditorCandidates[0];
const reviewerEntry = reviewerCandidates[0];
```

- [ ] **Step 3: Replace single-caller construction with fallback chains**

Find the section that builds `auditorCaller` and `reviewerCaller`:

```ts
const auditorCaller = makeVisionCaller(auditorEntry, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);
const reviewerCaller = makeVisionCaller(reviewerEntry, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);
```

Replace with:

```ts
const auditorCaller = makeFallbackVisionCaller(
  auditorCandidates.map(e => ({
    caller: makeVisionCaller(e, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl),
    provider: e.provider,
    model: e.model
  }))
);
const reviewerCaller = makeFallbackVisionCaller(
  reviewerCandidates.map(e => ({
    caller: makeVisionCaller(e, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl),
    provider: e.provider,
    model: e.model
  }))
);
```

The `modelSelection` field still records `auditorEntry` and `reviewerEntry` (primary candidates). The actual model used on each call is captured per-call in `AuditCriterionTrace.model` from `response.model`.

- [ ] **Step 4: Verify**

```powershell
npm run verify
```

Expected: tests pass, typecheck clean, build clean. No behavior change in tests since the fallback chain has only one effective candidate in unit test mocks.

---

## Task 3: Projection Gate Pre-Audit Filter

**Files:**
- Modify: `src/schemas/core.ts`
- Create: `src/pairing/projection-gate.ts`
- Modify: `src/debug/run-debug.ts`
- Modify: `src/pipeline/run-ui-diff.ts`
- Create: `tests/unit/projection-gate.test.ts`

- [ ] **Step 1: Add schema values**

In `src/schemas/core.ts`:

Add `"projection_gate_no_change"` to `AuditDecisionStatusSchema` (insert after `"criterion_not_triggered"`):

```ts
export const AuditDecisionStatusSchema = z.enum([
  "criterion_not_triggered",
  "projection_gate_no_change",
  "auditor_has_diff",
  "auditor_no_diff",
  "auditor_error",
  "auditor_schema_error",
  "empty_evidence",
  "reviewer_accepted",
  "reviewer_rejected",
  "reviewer_needs_escalation",
  "reviewer_error"
]);
```

Add `projectionGated` field to `RunDebugSummarySchema`:

```ts
projectionGated: z.number().int().min(0).default(0),
```

- [ ] **Step 2: Create projection-gate.ts**

Create `src/pairing/projection-gate.ts`:

```ts
import type { Box, ElementPair, UiElement, AuditCriterionTrace } from "../schemas/core.js";
import { UiCriterionSchema } from "../schemas/core.js";

const CLASSIFIABLE_CRITERIA = UiCriterionSchema.exclude(["unclassified_visual_change"]).options;

export function computeProjectedChangedRatio(
  diffMask: Uint8Array,
  imageWidth: number,
  box: Box
): number {
  const x = Math.max(0, Math.round(box.x));
  const y = Math.max(0, Math.round(box.y));
  const w = Math.min(Math.round(box.width), imageWidth - x);
  const imageHeight = Math.floor(diffMask.length / imageWidth);
  const h = Math.min(Math.round(box.height), imageHeight - y);
  if (w <= 0 || h <= 0) return 0;
  let changed = 0;
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const idx = (y + row) * imageWidth + (x + col);
      if ((diffMask[idx] ?? 0) > 0) changed++;
    }
  }
  return changed / (w * h);
}

export interface ProjectionGateResult {
  auditPairs: ElementPair[];
  gatedTraces: AuditCriterionTrace[];
  gatedPairCount: number;
}

export function applyProjectionGate(
  pairs: ElementPair[],
  expectedElements: UiElement[],
  actualElements: UiElement[],
  diffMask: Uint8Array,
  imageWidth: number,
  thresholdRatio: number
): ProjectionGateResult {
  const auditPairs: ElementPair[] = [];
  const gatedTraces: AuditCriterionTrace[] = [];

  for (const pair of pairs) {
    const expEl = expectedElements.find(e => e.id === pair.expectedId);
    const actEl = actualElements.find(e => e.id === pair.actualId);
    const refEl = expEl ?? actEl;

    if (!refEl) {
      auditPairs.push(pair);
      continue;
    }

    // Only gate pairs where the actual element is projected.
    // In dual-locator mode, actual elements have source "locator" — no gate applied.
    if (actEl?.source !== "projected") {
      auditPairs.push(pair);
      continue;
    }

    const box = actEl.box;
    const changedRatio = computeProjectedChangedRatio(diffMask, imageWidth, box);

    if (changedRatio >= thresholdRatio) {
      auditPairs.push(pair);
      continue;
    }

    // Gate this pair: record one trace entry per classifiable criterion.
    const skipReason = `projection gate: ${(changedRatio * 100).toFixed(2)}% changed pixels (threshold ${(thresholdRatio * 100).toFixed(0)}%)`;
    for (const criterion of CLASSIFIABLE_CRITERIA) {
      gatedTraces.push({
        pairId: pair.id,
        ...(pair.expectedId !== undefined ? { expectedId: pair.expectedId } : {}),
        ...(pair.actualId !== undefined ? { actualId: pair.actualId } : {}),
        targetLabel: refEl.label,
        targetType: refEl.type,
        criterion,
        status: "projection_gate_no_change",
        evidenceCount: 0,
        skipReason,
        imageRoles: [],
        artifactPaths: []
      });
    }
  }

  return {
    auditPairs,
    gatedTraces,
    gatedPairCount: pairs.length - auditPairs.length
  };
}
```

- [ ] **Step 3: Update summarizeRunDebug**

In `src/debug/run-debug.ts`, add `projectionGated` to the summary built by `summarizeRunDebug`:

```ts
projectionGated: new Set(
  trace.audit
    .filter(t => t.status === "projection_gate_no_change")
    .map(t => t.pairId)
).size,
```

This counts unique pairs that were gated (one entry per criterion per pair, but we count pairs).

- [ ] **Step 4: Integrate into pipeline**

In `src/pipeline/run-ui-diff.ts`, add the import:

```ts
import { applyProjectionGate } from "../pairing/projection-gate.js";
```

Read the threshold from env (default 2%):

```ts
const projectionGateThreshold = parseFloat(process.env["UI_DIFF_PROJECTION_GATE_RATIO"] ?? "0.02");
```

Apply the gate before the audit loop. Replace the existing audit-loop start:

```ts
const auditTotal = auditSelection.pairs.length;
for (let auditIdx = 0; auditIdx < auditSelection.pairs.length; auditIdx++) {
```

with:

```ts
const gateResult = applyProjectionGate(
  auditSelection.pairs,
  expectedElements,
  actualElements,
  pixelDiff.diffMask,
  expectedImg.width,
  projectionGateThreshold
);
debugTrace.audit.push(...gateResult.gatedTraces);
if (gateResult.gatedPairCount > 0) {
  warnings.push(
    `Projection gate skipped ${gateResult.gatedPairCount} of ${auditSelection.pairs.length} pairs ` +
    `with <${(projectionGateThreshold * 100).toFixed(0)}% pixel change in projected region.`
  );
}

const gatedAuditPairs = gateResult.auditPairs;
const auditTotal = gatedAuditPairs.length;
for (let auditIdx = 0; auditIdx < gatedAuditPairs.length; auditIdx++) {
  const pair = gatedAuditPairs[auditIdx]!;
```

Update all references from `auditSelection.pairs[auditIdx]` to `gatedAuditPairs[auditIdx]` inside the loop. The `auditScope` field should reflect the gated count:

```ts
auditScope = {
  auditedPairs: auditTotal,
  totalPairs: pairs.length,
  auditLimited: auditSelection.limited || gateResult.gatedPairCount > 0,
  ...(gateResult.gatedPairCount > 0
    ? { limitReason: `${gateResult.gatedPairCount} pairs gated by projection pixel-change threshold` }
    : auditSelection.warning ? { limitReason: auditSelection.warning } : {})
};
```

- [ ] **Step 5: Write tests**

Create `tests/unit/projection-gate.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeProjectedChangedRatio, applyProjectionGate } from "../../src/pairing/projection-gate.js";
import type { ElementPair, UiElement } from "../../src/schemas/core.js";

function makeBox(x: number, y: number, w: number, h: number) {
  return { x, y, width: w, height: h };
}

function makeMask(width: number, height: number, changedBoxes: { x: number; y: number; w: number; h: number }[]): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const { x, y, w, h } of changedBoxes) {
    for (let row = y; row < y + h; row++) {
      for (let col = x; col < x + w; col++) {
        mask[row * width + col] = 255;
      }
    }
  }
  return mask;
}

function makeProjectedPair(pairId: string, expId: string, actId: string): ElementPair {
  return { id: pairId, expectedId: expId, actualId: actId, status: "matched", score: 1.0, reasons: [] };
}

function makeElement(id: string, box: { x: number; y: number; width: number; height: number }, source: UiElement["source"] = "locator"): UiElement {
  return {
    id, label: id, type: "button", box,
    normalizedBox: { x: 0, y: 0, width: 0.1, height: 0.1 },
    confidence: 1.0, source, childIds: []
  };
}

describe("computeProjectedChangedRatio", () => {
  it("returns 0 when no pixels changed in region", () => {
    const mask = makeMask(100, 100, []);
    expect(computeProjectedChangedRatio(mask, 100, makeBox(10, 10, 20, 20))).toBe(0);
  });

  it("returns 1 when all pixels changed in region", () => {
    const mask = makeMask(100, 100, [{ x: 10, y: 10, w: 20, h: 20 }]);
    expect(computeProjectedChangedRatio(mask, 100, makeBox(10, 10, 20, 20))).toBe(1);
  });

  it("returns partial ratio when half region changed", () => {
    const mask = makeMask(100, 100, [{ x: 10, y: 10, w: 10, h: 20 }]);
    const ratio = computeProjectedChangedRatio(mask, 100, makeBox(10, 10, 20, 20));
    expect(ratio).toBeCloseTo(0.5, 5);
  });

  it("handles box clamped to image boundary", () => {
    const mask = makeMask(50, 50, [{ x: 0, y: 0, w: 50, h: 50 }]);
    const ratio = computeProjectedChangedRatio(mask, 50, makeBox(40, 40, 20, 20));
    expect(ratio).toBe(1);
  });
});

describe("applyProjectionGate", () => {
  it("passes through pairs with sufficient pixel change", () => {
    const mask = makeMask(100, 100, [{ x: 0, y: 0, w: 100, h: 100 }]);
    const expEl = makeElement("e1", makeBox(10, 10, 20, 20), "locator");
    const actEl = makeElement("proj-e1", makeBox(10, 10, 20, 20), "projected");
    const pair = makeProjectedPair("p1", "e1", "proj-e1");
    const result = applyProjectionGate([pair], [expEl], [actEl], mask, 100, 0.02);
    expect(result.auditPairs).toHaveLength(1);
    expect(result.gatedPairCount).toBe(0);
    expect(result.gatedTraces).toHaveLength(0);
  });

  it("gates pairs with zero pixel change and emits trace per criterion", () => {
    const mask = makeMask(100, 100, []); // no change anywhere
    const expEl = makeElement("e1", makeBox(10, 10, 20, 20), "locator");
    const actEl = makeElement("proj-e1", makeBox(10, 10, 20, 20), "projected");
    const pair = makeProjectedPair("p1", "e1", "proj-e1");
    const result = applyProjectionGate([pair], [expEl], [actEl], mask, 100, 0.02);
    expect(result.auditPairs).toHaveLength(0);
    expect(result.gatedPairCount).toBe(1);
    expect(result.gatedTraces.length).toBeGreaterThan(0);
    expect(result.gatedTraces.every(t => t.status === "projection_gate_no_change")).toBe(true);
    expect(result.gatedTraces.every(t => t.pairId === "p1")).toBe(true);
    expect(result.gatedTraces[0]?.skipReason).toMatch(/projection gate/);
  });

  it("does NOT gate pairs where actual element source is locator (dual-locator mode)", () => {
    const mask = makeMask(100, 100, []);
    const expEl = makeElement("e1", makeBox(10, 10, 20, 20), "locator");
    const actEl = makeElement("a1", makeBox(10, 10, 20, 20), "locator"); // not projected
    const pair = makeProjectedPair("p1", "e1", "a1");
    const result = applyProjectionGate([pair], [expEl], [actEl], mask, 100, 0.02);
    expect(result.auditPairs).toHaveLength(1);
    expect(result.gatedPairCount).toBe(0);
  });

  it("gates only unchanged pairs when mixed with changed pairs", () => {
    const mask = makeMask(100, 100, [{ x: 50, y: 50, w: 20, h: 20 }]);
    const expEl1 = makeElement("e1", makeBox(10, 10, 10, 10), "locator");
    const actEl1 = makeElement("proj-e1", makeBox(10, 10, 10, 10), "projected");
    const expEl2 = makeElement("e2", makeBox(50, 50, 20, 20), "locator");
    const actEl2 = makeElement("proj-e2", makeBox(50, 50, 20, 20), "projected");
    const pair1 = makeProjectedPair("p1", "e1", "proj-e1"); // no change
    const pair2 = makeProjectedPair("p2", "e2", "proj-e2"); // changed
    const result = applyProjectionGate([pair1, pair2], [expEl1, expEl2], [actEl1, actEl2], mask, 100, 0.02);
    expect(result.auditPairs).toHaveLength(1);
    expect(result.auditPairs[0]?.id).toBe("p2");
    expect(result.gatedPairCount).toBe(1);
  });
});
```

- [ ] **Step 6: Verify**

```powershell
npx vitest run tests/unit/projection-gate.test.ts
```

Expected: all gate tests pass.

---

## Task 4: Full Verification, E2E, Live Gate, And Status Sync

**Files:**
- Modify: `tests/e2e/compare-ui-images.test.ts`
- Modify: `tests/live/calorix-smoke.live.test.ts`
- Modify: `docs/release/production-readiness-checklist.md`
- Modify: `docs/implementation-status.md`

- [ ] **Step 1: Full deterministic verify**

```powershell
npm run verify
```

Expected: all unit, integration, sidecar, build, and typecheck pass.

- [ ] **Step 2: Add E2E assertion for projectionGated**

In `tests/e2e/compare-ui-images.test.ts`, after the existing `debugSummary` assertions, add:

```ts
expect(typeof report.debugSummary?.projectionGated).toBe("number");
```

- [ ] **Step 3: Add live gate assertions**

In `tests/live/calorix-smoke.live.test.ts`, after the existing debug summary assertions, add:

```ts
// projectionGated is always a number (0 or more pairs skipped)
expect(typeof report.debugSummary?.projectionGated).toBe("number");
expect(report.debugSummary?.projectionGated).toBeGreaterThanOrEqual(0);
```

For the full (unbounded) gate only, also assert:

```ts
// In single-pass mode with a realistic screenshot, some unchanged pairs should be gated.
// If projectionGated is 0, all pairs had changes — valid but worth inspecting.
expect(report.warnings?.some(w => w.includes("Projection gate") || w.includes("projection gate") || report.debugSummary?.projectionGated === 0)).toBe(true);
```

- [ ] **Step 4: Update production-readiness-checklist.md**

Add section:

```md
### Provider Fallback And Projection Gate

- The pipeline must use `makeFallbackVisionCaller` so a single retryable provider error
  does not cause an `auditor_error` cascade across all pairs in the run.
- In single-pass mode, `debugSummary.projectionGated` must be defined and greater than or
  equal to zero. If it is 0 on a realistic screenshot pair, investigate whether the
  pixel diff mask was computed correctly — most real runs will have some unchanged regions.
- `UI_DIFF_PROJECTION_GATE_RATIO` (default 0.02) controls the threshold. Do not lower
  below 0.005 without a coverage regression analysis — very low thresholds may miss
  subtle color-shift diffs that span many pixels at low intensity.
```

- [ ] **Step 5: Update implementation-status.md**

Record completed task with commit hash and verification result.

- [ ] **Step 6: Run coverage**

```powershell
npm run test:coverage
```

Expected: statement, branch, function, and line thresholds all remain above configured minimums.

---

## Acceptance Checks

- `makeFallbackVisionCaller` retries on HTTP 429, HTTP 5xx, and network errors but NOT on HTTP 400, 401, or JSON parse errors.
- `selectFallbackModelsForMode` returns up to N distinct passing candidates in canonical ranking order, with no duplicates.
- In single-pass (projection) mode, pairs whose projected bounding box has fewer than `UI_DIFF_PROJECTION_GATE_RATIO` changed pixels do not enter the VLM audit loop.
- Gated pairs produce `projection_gate_no_change` trace entries (one per classifiable criterion) so the reason is visible in `audit-trace.json`.
- `debugSummary.projectionGated` counts unique gated pair ids.
- In dual-locator mode (`UI_DIFF_DUAL_LOCATOR=1`), the projection gate is a no-op — actual elements have `source: "locator"`, not `"projected"`.
- `npm run verify` passes with no regression.
- `npm run test:coverage` passes all thresholds.
- No API keys, base64 image data, full prompt bodies, or manual target configs are introduced.

---

## Self-Review

- Scope: fallback and gate are independent; either can be reverted without touching the other.
- Placeholder scan: no TBD, no TODO, no "similar to" tasks.
- Type consistency: `FallbackCandidate`, `ProjectionGateResult`, `"projection_gate_no_change"`, `projectionGated` — all named consistently throughout.
- Product boundary: both improvements are fully automated; no manual review step, no ROI config, no ignore mask.
- Risk: projection gate with threshold 0.02 might rarely skip a pair with a very subtle change spread over a large region. The threshold is configurable via env var and the skipped pairs are logged in warnings and the audit trace.
