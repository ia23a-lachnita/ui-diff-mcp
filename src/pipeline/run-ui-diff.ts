import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { resolveInputImagePath, createRunDirectory } from "../security/paths.js";
import { loadNormalizedImage } from "../images/normalize.js";
import { computeViewportCompatibility } from "../images/viewport.js";
import { clusterUncoveredComponents } from "../report/component-clustering.js";
import { writeOverlay, writeJsonArtifact } from "../images/artifacts.js";
import { computePixelDiff } from "../signals/pixel-diff.js";
import { extractEdgeMask } from "../signals/edge.js";
import { createDirectionalDiffOverlay, type Rgba } from "../images/directional-diff.js";
import { locateUiElements, LocatorUnavailableError } from "../locator/locateanything-client.js";
import { buildElementMap, computeLocatorMetadata, projectElementsToActual, mergeLocatorLanes } from "../locator/element-map.js";
import { computeImageLocatorCoverage, type ImageLocatorCoverage } from "../locator/coverage.js";
import { buildTargetMapJson } from "../locator/diagnostics.js";
import { pairElements } from "../pairing/pair-elements.js";
import { selectModelForMode, selectFallbackModelsForMode, resolveMode, CANONICAL_MODEL_RANKING, type ModelEntry } from "../models/model-registry.js";
import { makeFallbackVisionCaller } from "../models/fallback-caller.js";
import { probeRequiredModels, type ProbeResult } from "../models/probes.js";
import { estimateFreeRunBudget, lookupOpenRouterQuota, checkFreeQuotaSufficiency } from "../models/free-quota.js";
import { makeOpenRouterVisionCaller, makeNvidiaVisionCaller, type VisionMode } from "../models/vision-json.js";
import { auditElementPair, makeElementSlug, type AuditContext } from "../audit/audit-target.js";
import { reviewAndMergeFindings } from "../audit/review-findings.js";
import { assignDiffComponentsToRecords, traceCoverageDecisions } from "../report/coverage.js";
import { runTargetRecovery } from "../recovery/target-recovery.js";
import { writeRunDebugArtifacts, type RunDebugTrace } from "../debug/run-debug.js";
import { ProviderTraceWriter, writeProviderTrace } from "../debug/provider-trace.js";
import { buildDeterministicDiffs } from "../diff/deterministic-diffs.js";
import { writeUiDiffReport, writeReportCheckpoint } from "../report/report-writer.js";
import type { UiDiffReport, RunStatus, VisualClassificationStatus, LocatorCoverageStatus, DiffRecord, ElementPair, UiArtifact, AuditScope, ModelSelection, RecoverySummary, StageStatus, LocatorLaneMetadata, RunDebugSummary } from "../schemas/core.js";
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
  visualClassificationStatus: string;
  locatorCoverageStatus: string;
  auditLimited: boolean;
  auditScope?: AuditScope;
  recoverySummary?: RecoverySummary;
  debugSummary?: RunDebugSummary;
}

type ProbeOverride = (entries: ModelEntry[], openRouterApiKey: string, nvidiaApiKey?: string, nvidiaBaseUrl?: string) => Promise<ProbeResult[]>;

export function resolveDualLocatorMode(env: Record<string, string | undefined>): {
  enabled: boolean;
  warning?: string;
} {
  const requested = env["UI_DIFF_DUAL_LOCATOR"] === "1";
  if (!requested) return { enabled: false };
  const allowed = env["UI_DIFF_ALLOW_DUAL_LOCATOR"] === "1";
  const reason = env["UI_DIFF_DUAL_LOCATOR_REASON"];
  if (!allowed || !reason) {
    return {
      enabled: false,
      warning:
        "UI_DIFF_DUAL_LOCATOR=1 was set but dual-locator mode requires " +
        "UI_DIFF_ALLOW_DUAL_LOCATOR=1 and UI_DIFF_DUAL_LOCATOR_REASON. " +
        "Falling back to single-pass projection mode."
    };
  }
  return { enabled: true, warning: `Dual-locator diagnostic mode active. Reason: ${reason}` };
}

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

  const viewportCompatibility = computeViewportCompatibility(expectedImg.metadata, actualImg.metadata);
  if (viewportCompatibility.status === "mismatch") {
    warnings.push(`[viewport-mismatch] ${viewportCompatibility.reasons.join("; ")}`);
  }

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
  let locatorLanes: Record<string, LocatorLaneMetadata> | undefined;
  let auditScope: AuditScope | undefined = undefined;
  let modelSelection: ModelSelection | undefined = undefined;
  let recoverySummary: RecoverySummary | undefined = undefined;
  const debugTrace: RunDebugTrace = { audit: [], coverage: [], recovery: [] };
  const providerTrace = new ProviderTraceWriter();
  const allDiffs: DiffRecord[] = [];
  const stages: StageStatus[] = [];
  const createdAt = new Date().toISOString();
  const runArtifacts: UiArtifact[] = [
    { role: "expected_normalized", path: normalizedExpPath },
    { role: "actual_normalized", path: normalizedActPath },
    { role: "pixel_diff", path: pixelDiffPngPath },
    { role: "pixel_diff_mask", path: pixelDiffMaskPath },
    { role: "directional_overlay", path: directionalOverlayPath }
  ];

  async function checkpoint(
    stageName: string,
    stageStatus: StageStatus["status"],
    currentPairs: ElementPair[],
    currentModelHealth: UiDiffReport["modelHealth"]
  ): Promise<void> {
    stages.push({ name: stageName, status: stageStatus, completedAt: new Date().toISOString() });
    await writeReportCheckpoint({
      schemaVersion: "0.1",
      runId,
      createdAt,
      status: status === "complete" && stageStatus === "failed" ? "incomplete" : status,
      visualClassificationStatus,
      locatorCoverageStatus,
      ...(auditScope !== undefined ? { auditScope } : {}),
      ...(modelSelection !== undefined ? { modelSelection } : {}),
      ...(recoverySummary !== undefined ? { recoverySummary } : {}),
      imageNormalization: { expected: expectedImg.metadata, actual: actualImg.metadata },
      viewportCompatibilityStatus: viewportCompatibility.status,
      viewportCompatibilityReasons: viewportCompatibility.reasons,
      expectedImagePath: expectedAbs,
      actualImagePath: actualAbs,
      artifactRoot,
      elements: { expected: expectedElements, actual: actualElements },
      pairs: currentPairs,
      diffs: allDiffs,
      modelHealth: currentModelHealth,
      runArtifacts,
      warnings,
      stages: [...stages]
    });
  }

  const openRouterApiKey = process.env["OPENROUTER_API_KEY"] ?? "";
  const nvidiaApiKey = process.env["NVIDIA_API_KEY"] ?? "";
  const nvidiaBaseUrl = process.env["NVIDIA_VLM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1";
  const paidModeEnabled = process.env["UI_DIFF_ENABLE_PAID_MODE"] === "1";
  const locatorUrl = process.env["LOCATEANYTHING_SIDECAR_URL"] ?? "http://127.0.0.1:39731";
  const locatorTimeoutMs = Number.parseInt(process.env["LOCATEANYTHING_TIMEOUT_MS"] ?? "300000", 10);
  const locatorMaxDimensionRaw = process.env["LOCATEANYTHING_MAX_DIMENSION"];
  const locatorMaxDimension = locatorMaxDimensionRaw ? Number.parseInt(locatorMaxDimensionRaw, 10) : 1200;
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
  let expectedCoverage: ImageLocatorCoverage | undefined;
  let actualCoverage: ImageLocatorCoverage | undefined;

  if (mode === "paid" && !paidModeEnabled) {
    warnings.push("Paid mode requested but UI_DIFF_ENABLE_PAID_MODE=1 is not set; paid routes are disabled.");
  }

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
    providerTrace.emit({
      phase: "quota_preflight",
      event: "quota_result",
      role: "quota",
      provider: "openrouter",
      model: "openrouter-free-quota",
      modelFamilyKey: "openrouter-free-quota",
      status: quotaCheck.available ? "ok" : "error",
      reason: quotaCheck.available ? undefined : quotaCheck.detail?.slice(0, 500)
    });
    if (!quotaCheck.available) {
      status = "insufficient_free_quota";
      visualClassificationStatus = "incomplete";
      warnings.push(
        `Insufficient free quota: ${quotaCheck.detail} (estimated ${quotaCheck.estimatedCalls} calls, ` +
        `${quotaCheck.limitRemaining ?? "unknown"} remaining)`
      );
    }
  }

  const dualLocatorMode = resolveDualLocatorMode(process.env);
  if (dualLocatorMode.warning) warnings.push(dualLocatorMode.warning);
  const dualLocatorEnabled = dualLocatorMode.enabled;

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
        timeoutMs: locatorTimeoutMs,
        maxDimension: locatorMaxDimension
      });
      expectedElements.push(...buildElementMap(expResp.elements, { width: expectedImg.width, height: expectedImg.height }));
      locatorLanes = expResp.metadata?.lanes;

      if (dualLocatorEnabled) {
        // Dual-pass: independently locate elements in the actual image too.
        const actResp = await locateUiElements({
          endpoint: locatorUrl,
          request: {
            imagePath: normalizedActPath,
            queries: locatorQueries,
            generationMode: "hybrid",
            maxBoxesPerQuery: 200
          },
          timeoutMs: locatorTimeoutMs,
          maxDimension: locatorMaxDimension
        });
        actualElements.push(...buildElementMap(actResp.elements, { width: actualImg.width, height: actualImg.height }));
        // Merge actual-image lane results into locatorLanes (take worse status per lane, sum counts).
        if (actResp.metadata?.lanes) {
          locatorLanes = mergeLocatorLanes(locatorLanes ?? {}, actResp.metadata.lanes);
        }
      } else {
        // Single-pass default: project expected element boxes onto the actual image.
        // The auditor VLM compares crops at the same coordinates; recovery handles
        // elements that moved or appeared outside those locations.
        actualElements.push(...projectElementsToActual(expectedElements, {
          width: actualImg.width,
          height: actualImg.height
        }, {
          normalizedActualScaleX: actualImg.metadata.scaleX,
          normalizedActualScaleY: actualImg.metadata.scaleY
        }));
        warnings.push("Single-pass locator active (projection mode). Set UI_DIFF_DUAL_LOCATOR=1 + UI_DIFF_ALLOW_DUAL_LOCATOR=1 + UI_DIFF_DUAL_LOCATOR_REASON for diagnostic dual-pass mode.");
      }

      expectedCoverage = computeImageLocatorCoverage({
        elements: expectedElements,
        promptCount: locatorQueries.length,
        imageSize: { width: expectedImg.width, height: expectedImg.height }
      });

      if (dualLocatorEnabled) {
        actualCoverage = computeImageLocatorCoverage({
          elements: actualElements,
          promptCount: locatorQueries.length,
          imageSize: { width: actualImg.width, height: actualImg.height }
        });
        locatorCoverageStatus = expectedCoverage.status === "complete" && actualCoverage.status === "complete"
          ? "complete"
          : expectedCoverage.status === "failed" || actualCoverage.status === "failed"
            ? "failed"
            : "weak";
      } else {
        // Projected actual coverage is a synthetic placeholder — status driven by expected only.
        actualCoverage = {
          status: "projected",
          promptCount: locatorQueries.length,
          usefulElementCount: actualElements.length,
          queryCounts: {},
          queryCoverageRatio: 1,
          rejectedElementCount: 0,
          reasons: ["elements_projected_from_expected"]
        };
        locatorCoverageStatus = expectedCoverage.status;
      }

      await writeJsonArtifact(path.join(artifactRoot, "target-map-expected.json"), buildTargetMapJson({
        imageRole: "expected",
        coverage: expectedCoverage,
        elements: expectedElements
      }));
      await writeJsonArtifact(path.join(artifactRoot, "target-map-actual.json"), buildTargetMapJson({
        imageRole: "actual",
        coverage: actualCoverage,
        elements: actualElements,
        elementsSource: dualLocatorEnabled ? "independent" : "projected"
      }));
      runArtifacts.push(
        { role: "target_map_expected", path: path.join(artifactRoot, "target-map-expected.json") },
        { role: "target_map_actual", path: path.join(artifactRoot, "target-map-actual.json") }
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

  // Deterministic diffs: geometry and presence records derived directly from locator pairing.
  // These are accepted without VLM review. Union-box coverage prevents shifted elements from
  // appearing as unclassified pixel fragments, but unrelated changes that fall inside a union
  // box may be considered covered until shape-aware coverage is implemented (see checklist).
  const deterministicDiffs = buildDeterministicDiffs({
    pairs,
    expectedElements,
    actualElements,
    minMovePx: 4
  });
  allDiffs.push(...deterministicDiffs);

  const modelHealth: UiDiffReport["modelHealth"] = [];
  await checkpoint("locator_pairing_deterministic", "complete", pairs, modelHealth);

  if (mode !== "deterministic_only" && status !== "insufficient_free_quota") {
    const probe = opts?.probeOverride ?? probeRequiredModels;
    const probeEntries: ModelEntry[] = CANONICAL_MODEL_RANKING.flatMap(c => {
      const freeEntries = c.eligibleFreeProviderRoutes.map(r => ({
        role: c.role,
        provider: r.provider,
        model: r.model,
        costClass: c.costClass,
        probeTtlMs: 15 * 60 * 1000,
        required: false
      }));
      const paidEntries = (mode === "paid" && paidModeEnabled && c.paidRoutes)
        ? c.paidRoutes.map(r => ({
            role: c.role,
            provider: r.provider,
            model: r.model,
            costClass: "paid" as const,
            probeTtlMs: 24 * 60 * 60 * 1000,
            required: false
          }))
        : [];
      return [...freeEntries, ...paidEntries];
    });

    const probeResults = await probe(probeEntries, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl, providerTrace.sink);
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

    const auditorCandidates = selectFallbackModelsForMode("auditor", mode, probeResults, 3, process.env);
    const reviewerCandidates = selectFallbackModelsForMode("reviewer", mode, probeResults, 3, process.env);
    const auditorEntry = auditorCandidates[0];
    const reviewerEntry = reviewerCandidates[0];

    await checkpoint("model_probe", "complete", pairs, modelHealth);

    if (!auditorEntry || !reviewerEntry) {
      if (!locatorFailed) {
        status = "model_unavailable";
        visualClassificationStatus = "incomplete";
        warnings.push(`No model available for mode "${mode}". Set NVIDIA_API_KEY or OPENROUTER_API_KEY with passing probes.`);
        // Emit route_exhausted for the role(s) that had no passing candidates.
        // In free_nvidia mode this is explicit: no OpenRouter fallback is available.
        const exhaustedRole = !auditorEntry ? "auditor" as const : "reviewer" as const;
        providerTrace.emit({
          phase: "audit",
          event: "route_exhausted",
          role: exhaustedRole,
          provider: mode === "free_nvidia" ? "nvidia" : "any",
          model: "none",
          modelFamilyKey: "none",
          reason: `No passing probes for ${exhaustedRole} in mode "${mode}". ${mode === "free_nvidia" ? "No OpenRouter fallback in free_nvidia mode." : ""}`.trim(),
          status: "error"
        });
      }
    } else {
      {
        const recoveryCandidates = selectFallbackModelsForMode("target_recovery", mode, probeResults, 3, process.env);
        const recoveryEntry = recoveryCandidates[0];
        const toRouteEntry = (e: ModelEntry) => ({ model: e.model, provider: e.provider, costClass: e.costClass });
        modelSelection = {
          auditor: toRouteEntry(auditorEntry),
          reviewer: toRouteEntry(reviewerEntry),
          ...(recoveryEntry ? { targetRecovery: toRouteEntry(recoveryEntry) } : {}),
          auditorRoutes: auditorCandidates.map(toRouteEntry),
          reviewerRoutes: reviewerCandidates.map(toRouteEntry),
          ...(recoveryCandidates.length > 0 ? { targetRecoveryRoutes: recoveryCandidates.map(toRouteEntry) } : {})
        };
        // Warn when the primary is NVIDIA but OpenRouter fallbacks exist in free mode — the run may
        // silently switch providers mid-flight and that change should be observable in the report.
        for (const [role, primary, routes] of [
          ["auditor", auditorEntry, auditorCandidates],
          ["reviewer", reviewerEntry, reviewerCandidates],
          ["target_recovery", recoveryEntry, recoveryCandidates]
        ] as const) {
          if (
            primary?.provider === "nvidia" &&
            routes.some(r => r.provider === "openrouter") &&
            (mode === "free")
          ) {
            warnings.push(
              `${role} primary route is NVIDIA (${primary.model}); OpenRouter fallback routes are available ` +
              `and will activate automatically on NVIDIA rate-limit or malformed-JSON failures in free mode.`
            );
          }
        }
        const makeFallbackWarning = (role: string) => (ev: import("../models/fallback-caller.js").FallbackEvent) => {
          warnings.push(
            `[provider-fallback] ${role} switched from ${ev.fromProvider}/${ev.fromModel} ` +
            `to ${ev.toProvider}/${ev.toModel}: ${ev.reason.slice(0, 120)} (at ${ev.timestamp})`
          );
        };
        const auditorCaller = makeFallbackVisionCaller(
          auditorCandidates.map(e => ({
            caller: makeVisionCaller(e, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl),
            provider: e.provider,
            model: e.model,
            phase: "audit" as const
          })),
          makeFallbackWarning("auditor"),
          providerTrace.sink
        );
        const reviewerCaller = makeFallbackVisionCaller(
          reviewerCandidates.map(e => ({
            caller: makeVisionCaller(e, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl),
            provider: e.provider,
            model: e.model,
            phase: "reviewer" as const
          })),
          makeFallbackWarning("reviewer"),
          providerTrace.sink
        );
        const recoveryCaller = recoveryCandidates.length > 0
          ? makeFallbackVisionCaller(
              recoveryCandidates.map(e => ({
                caller: makeVisionCaller(e, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl),
                provider: e.provider,
                model: e.model,
                phase: "recovery" as const
              })),
              makeFallbackWarning("target_recovery"),
              providerTrace.sink
            )
          : undefined;

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
            expEl?.box ?? refEl.box,
            actEl?.box ?? refEl.box,
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

          const { accepted, trace } = await auditElementPair(pair, ctx);
          debugTrace.audit.push(...trace);
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
        await checkpoint("audit", "complete", pairs, modelHealth);

        // Target recovery: classify uncovered changed-pixel regions
        const significantComponents = pixelDiff.components.filter(c => c.pixelCount >= 50);
        debugTrace.coverage = traceCoverageDecisions(significantComponents, allDiffs, 50);
        const rawUncoveredComponents = significantComponents.filter((_, index) => debugTrace.coverage[index]?.status === "uncovered");
        const uncoveredComponents = rawUncoveredComponents.length > 0
          ? clusterUncoveredComponents(rawUncoveredComponents, { maxGapPx: 12, maxClusterAreaRatio: 0.5 })
          : rawUncoveredComponents;
        const preClusterUncoveredComponents = rawUncoveredComponents.length;
        const postClusterUncoveredComponents = uncoveredComponents.length;
        if (uncoveredComponents.length > 0 && !recoveryCaller) {
          warnings.push("Target recovery skipped: no passing target_recovery route available for current mode. Uncovered pixel regions will not be classified.");
          visualClassificationStatus = "incomplete";
          providerTrace.emit({
            phase: "recovery",
            event: "route_exhausted",
            role: "target_recovery",
            provider: "all",
            model: "none",
            modelFamilyKey: "none",
            status: "error",
            reason: "all target_recovery probes failed — no caller created"
          });
        } else if (uncoveredComponents.length > 0 && recoveryCaller) {
          const recoveryResult = await runTargetRecovery(uncoveredComponents, {
            expectedRgba: { data: expectedImg.rgba, width: expectedImg.width, height: expectedImg.height },
            actualRgba: { data: actualImg.rgba, width: actualImg.width, height: actualImg.height },
            pixelDiffMask: pixelDiff.diffMask,
            directionalOverlayPath,
            artifactDir: artifactRoot,
            recoveryCaller,
            reviewerCaller
          });
          debugTrace.recovery.push(...recoveryResult.trace);
          allDiffs.push(...recoveryResult.recovered);
          recoverySummary = {
            totalUncoveredComponents: uncoveredComponents.length,
            attemptedComponents: recoveryResult.attemptedComponents,
            skippedComponents: recoveryResult.skippedComponents,
            recoveredDiffs: recoveryResult.recovered.length,
            unclassifiedCount: recoveryResult.unclassifiedCount,
            stoppedReason: recoveryResult.stoppedReason,
            preClusterUncoveredComponents,
            postClusterUncoveredComponents
          };
          if (recoveryResult.stoppedReason !== "none" || recoveryResult.unclassifiedCount > 0) {
            visualClassificationStatus = "incomplete";
          } else if (!locatorFailed && !auditSelection.limited) {
            visualClassificationStatus = "complete";
          }
          await checkpoint("target_recovery", "complete", pairs, modelHealth);
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

  // Write debug trace artifacts and attach summary to the report
  const debugArtifactsResult = await writeRunDebugArtifacts(artifactRoot, debugTrace);
  runArtifacts.push(...debugArtifactsResult.artifacts);

  // Write provider-trace artifact: metadata-only record of all probe, call, route-health,
  // and fallback events. No prompts, image data, API keys, or raw response bodies.
  const providerTraceArtifact = await writeProviderTrace(artifactRoot, providerTrace);
  runArtifacts.push(providerTraceArtifact);

  const locatorMetadata = locatorCoverageStatus !== "not_run"
    ? {
        ...computeLocatorMetadata([...expectedElements, ...actualElements], locatorQueries.length),
        ...(expectedCoverage !== undefined ? { expected: expectedCoverage } : {}),
        ...(actualCoverage !== undefined ? { actual: actualCoverage } : {}),
        locatorActualMode: dualLocatorEnabled ? "independent" as const : "projected" as const,
        ...(locatorLanes !== undefined ? { lanes: locatorLanes } : {})
      }
    : undefined;

  const report: UiDiffReport = {
    schemaVersion: "0.1",
    runId,
    createdAt,
    status,
    visualClassificationStatus,
    locatorCoverageStatus,
    ...(locatorMetadata !== undefined ? { locatorMetadata } : {}),
    ...(auditScope !== undefined ? { auditScope } : {}),
    ...(modelSelection !== undefined ? { modelSelection } : {}),
    ...(recoverySummary !== undefined ? { recoverySummary } : {}),
    imageNormalization: { expected: expectedImg.metadata, actual: actualImg.metadata },
    viewportCompatibilityStatus: viewportCompatibility.status,
    viewportCompatibilityReasons: viewportCompatibility.reasons,
    expectedImagePath: expectedAbs,
    actualImagePath: actualAbs,
    artifactRoot,
    elements: { expected: expectedElements, actual: actualElements },
    pairs,
    diffs: finalDiffs,
    modelHealth,
    runArtifacts,
    warnings,
    stages,
    debugSummary: debugArtifactsResult.summary
  };

  return writeUiDiffReport(report);
}
