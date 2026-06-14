import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { resolveInputImagePath, createRunDirectory } from "../security/paths.js";
import { loadNormalizedImage } from "../images/normalize.js";
import { writeOverlay } from "../images/artifacts.js";
import { computePixelDiff } from "../signals/pixel-diff.js";
import { extractEdgeMask } from "../signals/edge.js";
import { createDirectionalDiffOverlay, type Rgba } from "../images/directional-diff.js";
import { locateUiElements, LocatorUnavailableError } from "../locator/locateanything-client.js";
import { buildElementMap, computeLocatorMetadata, computeLocatorCoverageStatus } from "../locator/element-map.js";
import { pairElements } from "../pairing/pair-elements.js";
import { selectModelForMode, resolveMode, CANONICAL_MODEL_RANKING, type ModelEntry } from "../models/model-registry.js";
import { probeRequiredModels, type ProbeResult } from "../models/probes.js";
import { estimateFreeRunBudget, lookupOpenRouterQuota, checkFreeQuotaSufficiency } from "../models/free-quota.js";
import { makeOpenRouterVisionCaller, makeNvidiaVisionCaller, type VisionMode } from "../models/vision-json.js";
import { auditElementPair, makeElementSlug, type AuditContext } from "../audit/audit-target.js";
import { reviewAndMergeFindings } from "../audit/review-findings.js";
import { assignDiffComponentsToRecords, findUncoveredComponents } from "../report/coverage.js";
import { runTargetRecovery } from "../recovery/target-recovery.js";
import { writeUiDiffReport } from "../report/report-writer.js";
import type { UiDiffReport, RunStatus, VisualClassificationStatus, LocatorCoverageStatus, DiffRecord, ElementPair, UiArtifact, AuditScope } from "../schemas/core.js";
import { computeColorEvidence } from "../signals/color.js";

export interface RunInput {
  expectedImagePath: string;
  actualImagePath: string;
  projectRoot?: string;
  runLabel?: string;
  mode?: string;
}

export interface RunOutput {
  runId: string;
  status: string;
  diffCount: number;
  reportPath: string;
  artifactRoot: string;
  runArtifacts: UiArtifact[];
  summary: string;
  warnings: string[];
  locatorCoverageStatus: string;
  auditScope?: AuditScope;
}

type ProbeOverride = (entries: ModelEntry[], openRouterApiKey: string, nvidiaApiKey?: string, nvidiaBaseUrl?: string) => Promise<ProbeResult[]>;

export function selectAuditPairsForRun(
  pairs: ElementPair[],
  env: Record<string, string | undefined>
): { pairs: ElementPair[]; limited: boolean; warning?: string } {
  const rawLimit = env["UI_DIFF_MAX_AUDIT_PAIRS"];
  if (!rawLimit) {
    return { pairs, limited: false };
  }

  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit >= pairs.length) {
    return { pairs, limited: false };
  }

  return {
    pairs: pairs.slice(0, limit),
    limited: true,
    warning: `Visual audit limited to ${limit} of ${pairs.length} paired targets by UI_DIFF_MAX_AUDIT_PAIRS.`
  };
}

function makeVisionCaller(
  entry: ModelEntry,
  openRouterApiKey: string,
  nvidiaApiKey: string,
  nvidiaBaseUrl: string
) {
  if (entry.provider === "nvidia") {
    return makeNvidiaVisionCaller(nvidiaApiKey, entry.model, nvidiaBaseUrl);
  }
  return makeOpenRouterVisionCaller(openRouterApiKey, entry.model);
}

export async function runUiDiff(input: RunInput, opts?: { probeOverride?: ProbeOverride }): Promise<RunOutput> {
  const runId = `run-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const warnings: string[] = [];
  const mode: VisionMode = resolveMode(input.mode);

  const projectRoot = input.projectRoot ?? process.cwd();
  const expectedAbs = resolveInputImagePath(input.expectedImagePath, projectRoot);
  const actualAbs = resolveInputImagePath(input.actualImagePath, projectRoot);
  const runDir = await createRunDirectory(projectRoot, runId);
  const artifactRoot = path.join(runDir, "artifacts");

  const normalizedExpPath = path.join(runDir, "expected-normalized.png");
  const normalizedActPath = path.join(runDir, "actual-normalized.png");

  const expectedImg = await loadNormalizedImage(expectedAbs, normalizedExpPath);
  const actualImg = await loadNormalizedImage(actualAbs, normalizedActPath, {
    width: expectedImg.width,
    height: expectedImg.height
  });

  const pixelDiff = computePixelDiff(normalizedExpPath, normalizedActPath);
  const pixelDiffPngPath = path.join(runDir, "pixel-diff.png");
  await sharp(Buffer.from(pixelDiff.diffBuffer), {
    raw: { width: pixelDiff.width, height: pixelDiff.height, channels: 4 }
  }).png().toFile(pixelDiffPngPath);

  const pixelDiffMaskPath = path.join(runDir, "pixel-diff-mask.png");
  await sharp(Buffer.from(pixelDiff.diffMask.buffer, pixelDiff.diffMask.byteOffset, pixelDiff.diffMask.byteLength), {
    raw: { width: pixelDiff.width, height: pixelDiff.height, channels: 1 }
  }).png().toFile(pixelDiffMaskPath);

  const directionalOverlayPath = path.join(runDir, "directional-diff-overlay.png");
  await createDirectionalDiffOverlay(
    { data: expectedImg.rgba, width: expectedImg.width, height: expectedImg.height },
    { data: actualImg.rgba, width: actualImg.width, height: actualImg.height },
    pixelDiff.diffMask,
    expectedImg.width,
    expectedImg.height,
    directionalOverlayPath
  );
  const edgeMask = extractEdgeMask(expectedImg.rgba, expectedImg.width, expectedImg.height);

  let status: RunStatus = "complete";
  let visualClassificationStatus: VisualClassificationStatus = "not_run";
  let locatorCoverageStatus: LocatorCoverageStatus = "not_run";
  let auditScope: AuditScope | undefined = undefined;
  const allDiffs: DiffRecord[] = [];

  const openRouterApiKey = process.env["OPENROUTER_API_KEY"] ?? "";
  const nvidiaApiKey = process.env["NVIDIA_API_KEY"] ?? "";
  const nvidiaBaseUrl = process.env["NVIDIA_VLM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1";
  const locatorUrl = process.env["LOCATEANYTHING_SIDECAR_URL"] ?? "http://127.0.0.1:39731";
  const locatorTimeoutMs = Number.parseInt(process.env["LOCATEANYTHING_TIMEOUT_MS"] ?? "300000", 10);
  const locatorQueries = [
    { id: "text_labels", prompt: "Detect all visible text labels in box format." },
    { id: "buttons", prompt: "Locate all buttons and tappable controls in box format." },
    { id: "cards_panels_containers", prompt: "Locate all cards, panels, and rounded containers in box format." },
    { id: "icons", prompt: "Locate all icons and navigation icons in box format." },
    { id: "charts_indicators", prompt: "Locate all charts, rings, progress indicators, and bars in box format." },
    { id: "tab_bar_nav_elements", prompt: "Locate all tab bar and navigation elements in box format." },
    { id: "list_items", prompt: "Locate all list rows and repeated item containers in box format." },
    { id: "image_thumbnails_avatars", prompt: "Locate all image thumbnails and avatars in box format." }
  ];

  const expectedElements: ReturnType<typeof buildElementMap> = [];
  const actualElements: ReturnType<typeof buildElementMap> = [];
  let locatorFailed = false;

  // Free quota preflight: estimate calls and check sufficiency before spending quota.
  // Only applies when an OpenRouter key is configured — without a key, the probe will
  // mark all OpenRouter routes not_checked and model selection will fall back or skip.
  if ((mode === "free" || mode === "free_openrouter") && openRouterApiKey) {
    const openRouterRouteCount = CANONICAL_MODEL_RANKING
      .flatMap(c => c.eligibleFreeProviderRoutes)
      .filter(r => r.provider === "openrouter").length;
    const budget = estimateFreeRunBudget({
      modelCount: openRouterRouteCount,
      pairCount: 20, // conservative upper bound before pairs are known
      criteriaPerPair: 3,
      recoveryRegionCount: 5,
      reviewerPolicy: "every_diff"
    });
    const keyInfo = await lookupOpenRouterQuota(openRouterApiKey);
    const quotaCheck = checkFreeQuotaSufficiency(budget, keyInfo);
    if (!quotaCheck.available) {
      status = "insufficient_free_quota";
      visualClassificationStatus = "incomplete";
      warnings.push(
        `Insufficient free quota: ${quotaCheck.detail} (estimated ${quotaCheck.estimatedCalls} calls, ` +
        `${quotaCheck.limitRemaining ?? "unknown"} remaining)`
      );
    }
  }

  if (mode !== "deterministic_only" && status !== "insufficient_free_quota") {
    try {
      const expResp = await locateUiElements({
        endpoint: locatorUrl,
        request: {
          imagePath: normalizedExpPath,
          queries: locatorQueries,
          generationMode: "hybrid",
          maxBoxesPerQuery: 200
        },
        timeoutMs: locatorTimeoutMs
      });
      const actResp = await locateUiElements({
        endpoint: locatorUrl,
        request: {
          imagePath: normalizedActPath,
          queries: locatorQueries,
          generationMode: "hybrid",
          maxBoxesPerQuery: 200
        },
        timeoutMs: locatorTimeoutMs
      });
      expectedElements.push(...buildElementMap(expResp.elements, { width: expectedImg.width, height: expectedImg.height }));
      actualElements.push(...buildElementMap(actResp.elements, { width: actualImg.width, height: actualImg.height }));
      locatorCoverageStatus = computeLocatorCoverageStatus(
        [...expectedElements, ...actualElements],
        locatorQueries.length,
        false
      );
    } catch (err) {
      locatorFailed = true;
      locatorCoverageStatus = "failed";
      status = "model_unavailable";
      visualClassificationStatus = "incomplete";
      if (err instanceof LocatorUnavailableError) {
        warnings.push(`Locator unavailable: ${err.message}. Skipping element discovery.`);
      } else {
        warnings.push(`Locator error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const pairs = pairElements(expectedElements, actualElements);

  const modelHealth: UiDiffReport["modelHealth"] = [];

  if (mode !== "deterministic_only" && status !== "insufficient_free_quota") {
    const probe = opts?.probeOverride ?? probeRequiredModels;
    const probeEntries: ModelEntry[] = CANONICAL_MODEL_RANKING.flatMap(c =>
      c.eligibleFreeProviderRoutes.map(r => ({
        role: c.role,
        provider: r.provider,
        model: r.model,
        costClass: c.costClass,
        probeTtlMs: 15 * 60 * 1000,
        required: false
      }))
    );

    const probeResults = await probe(probeEntries, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);
    for (const p of probeResults) {
      modelHealth.push({
        role: p.role,
        provider: p.provider,
        model: p.model,
        status: p.status,
        checkedAt: p.checkedAt ?? new Date().toISOString(),
        ...(p.detail !== undefined ? { detail: p.detail } : {})
      });
    }

    const auditorEntry = selectModelForMode("auditor", mode, probeResults, process.env);
    const reviewerEntry = selectModelForMode("reviewer", mode, probeResults, process.env);

    if (!auditorEntry || !reviewerEntry) {
      if (!locatorFailed) {
        status = "model_unavailable";
        visualClassificationStatus = "incomplete";
        warnings.push(`No model available for mode "${mode}". Set NVIDIA_API_KEY or OPENROUTER_API_KEY with passing probes.`);
      }
    } else {
      {
        const auditorCaller = makeVisionCaller(auditorEntry, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);
        const reviewerCaller = makeVisionCaller(reviewerEntry, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);

        visualClassificationStatus = "incomplete";
        const auditedDiffs: DiffRecord[] = [];
        const auditSelection = selectAuditPairsForRun(pairs, process.env);
        if (auditSelection.warning) {
          warnings.push(auditSelection.warning);
        }

        const auditTotal = auditSelection.pairs.length;
        for (let auditIdx = 0; auditIdx < auditSelection.pairs.length; auditIdx++) {
          const pair = auditSelection.pairs[auditIdx]!;
          const expEl = expectedElements.find(e => e.id === pair.expectedId);
          const actEl = actualElements.find(e => e.id === pair.actualId);
          const refEl = expEl ?? actEl;
          if (!refEl) continue;

          const colorEvidence = (expEl || actEl) ? computeColorEvidence(
            expectedImg.rgba,
            actualImg.rgba,
            expectedImg.width,
            refEl.box,
            refEl.type
          ) : null;
          const colorDelta = colorEvidence?.hasDiff ?? false;
          const colorMeasurements = colorEvidence ? [
            { name: "color_oklab_distance", value: colorEvidence.oklabDistance },
            { name: "color_threshold", value: colorEvidence.threshold },
            { name: "color_expected_avg", value: `rgb(${colorEvidence.expectedAvg.r},${colorEvidence.expectedAvg.g},${colorEvidence.expectedAvg.b})` },
            { name: "color_actual_avg", value: `rgb(${colorEvidence.actualAvg.r},${colorEvidence.actualAvg.g},${colorEvidence.actualAvg.b})` },
            { name: "color_expected_alpha", value: colorEvidence.expectedAvg.a },
            { name: "color_actual_alpha", value: colorEvidence.actualAvg.a },
            { name: "color_dominant_expected_palette", value: JSON.stringify(colorEvidence.dominantExpected) },
            { name: "color_dominant_actual_palette", value: JSON.stringify(colorEvidence.dominantActual) }
            ] : [];

          const boxDeltaPx = expEl && actEl
            ? Math.abs(expEl.box.x - actEl.box.x) + Math.abs(expEl.box.y - actEl.box.y)
            : 0;

          const ctx: AuditContext = {
            expectedImagePath: normalizedExpPath,
            actualImagePath: normalizedActPath,
            expectedElements,
            actualElements,
            artifactDir: artifactRoot,
            auditorCaller,
            reviewerCaller,
            expectedRgba: { data: expectedImg.rgba, width: expectedImg.width, height: expectedImg.height },
            actualRgba: { data: actualImg.rgba, width: actualImg.width, height: actualImg.height },
            measurements: colorMeasurements,
            triggerCtx: {
              pairingStatus: pair.status,
              boxDeltaPx,
              textDelta: (expEl?.text ?? "") !== (actEl?.text ?? ""),
              colorDelta,
              edgeMismatch: edgeMask.components.length > 0,
              overlapDetected: false,
              stateWordsDiffer: false,
              elementType: refEl.type,
              measurements: []
            },
            auditIndex: auditIdx + 1,
            auditTotal,
            elementSlug: makeElementSlug(refEl.label)
          };

          const { accepted } = await auditElementPair(pair, ctx);
          auditedDiffs.push(...accepted);
        }

        auditScope = {
          auditedPairs: auditTotal,
          totalPairs: pairs.length,
          auditLimited: auditSelection.limited,
          ...(auditSelection.warning ? { limitReason: auditSelection.warning } : {})
        };

        const merged = reviewAndMergeFindings(auditedDiffs);
        allDiffs.push(...merged);

        // Target recovery: classify uncovered changed-pixel regions
        const significantComponents = pixelDiff.components.filter(c => c.pixelCount >= 50);
        const uncoveredComponents = findUncoveredComponents(significantComponents, merged, 50);
        if (uncoveredComponents.length > 0) {
          const { recovered, unclassifiedCount } = await runTargetRecovery(uncoveredComponents, {
            expectedRgba: { data: expectedImg.rgba, width: expectedImg.width, height: expectedImg.height },
            actualRgba: { data: actualImg.rgba, width: actualImg.width, height: actualImg.height },
            pixelDiffMask: pixelDiff.diffMask,
            directionalOverlayPath,
            artifactDir: artifactRoot,
            recoveryCaller: auditorCaller,
            reviewerCaller
          });
          allDiffs.push(...recovered);
          if (unclassifiedCount > 0) {
            visualClassificationStatus = "incomplete";
          } else if (!locatorFailed && !auditSelection.limited) {
            visualClassificationStatus = "complete";
          }
        } else if (!locatorFailed && !auditSelection.limited) {
          visualClassificationStatus = "complete";
        }
      }
    }
  }

  const finalDiffs = assignDiffComponentsToRecords(
    pixelDiff.components.filter(c => c.pixelCount >= 50),
    allDiffs,
    50,
    pixelDiffPngPath
  );

  const runArtifacts: UiArtifact[] = [
    { role: "expected_normalized", path: normalizedExpPath },
    { role: "actual_normalized", path: normalizedActPath },
    { role: "pixel_diff", path: pixelDiffPngPath },
    { role: "pixel_diff_mask", path: pixelDiffMaskPath },
    { role: "directional_overlay", path: directionalOverlayPath },
  ];

  const locatorMetadata = locatorCoverageStatus !== "not_run"
    ? computeLocatorMetadata([...expectedElements, ...actualElements], locatorQueries.length)
    : undefined;

  const report: UiDiffReport = {
    schemaVersion: "0.1",
    runId,
    createdAt: new Date().toISOString(),
    status,
    visualClassificationStatus,
    locatorCoverageStatus,
    ...(locatorMetadata !== undefined ? { locatorMetadata } : {}),
    ...(auditScope !== undefined ? { auditScope } : {}),
    expectedImagePath: expectedAbs,
    actualImagePath: actualAbs,
    artifactRoot,
    elements: { expected: expectedElements, actual: actualElements },
    pairs,
    diffs: finalDiffs,
    modelHealth,
    runArtifacts,
    warnings
  };

  return writeUiDiffReport(report);
}
