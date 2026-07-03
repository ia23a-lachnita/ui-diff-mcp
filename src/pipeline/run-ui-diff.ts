import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { resolveInputImagePath, createRunDirectory } from "../security/paths.js";
import { loadNormalizedImage } from "../images/normalize.js";
import { createImagePairTransform } from "../images/coordinates.js";
import { computeViewportCompatibility } from "../images/viewport.js";
import { buildRegionLedger, applyFindingCoverage, applyRecoveryOutcomes, unresolvedRegionsFromLedger, type RegionLedger } from "../report/region-ledger.js";
import { consolidateFindings } from "../report/finding-consolidation.js";
import { applyResidualFragmentDecisions, classifyResidualFragments } from "../report/residual-fragments.js";
import { writeRegionContextOverlays } from "../report/context-overlays.js";
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
import { makeFallbackVisionCaller, RouteExhaustedError } from "../models/fallback-caller.js";
import { probeRequiredModels, type ProbeResult } from "../models/probes.js";
import { estimateFreeRunBudget, lookupOpenRouterQuota, checkFreeQuotaSufficiency } from "../models/free-quota.js";
import { makeOpenRouterVisionCaller, makeNvidiaVisionCaller, type VisionMode } from "../models/vision-json.js";
import { makeOpenCodeVisionCaller } from "../models/opencode-client.js";
import { makeGeminiVisionCaller } from "../models/gemini-client.js";
import { makeMistralVisionCaller } from "../models/mistral-client.js";
import { resolveVisionProviderConfig, type VisionProviderConfig } from "../models/provider-config.js";
import { auditElementPair, makeElementSlug, type AuditContext } from "../audit/audit-target.js";
import { filterAcceptedDiffs, reviewAndMergeFindings } from "../audit/review-findings.js";
import { prepareRecoveryRegionArtifacts, runTargetRecovery } from "../recovery/target-recovery.js";
import { writeRunDebugArtifacts, summarizeAuditPairOutcomes, type AuditPairOutcome, type RunDebugTrace } from "../debug/run-debug.js";
import { ProviderTraceWriter, writeProviderTrace } from "../debug/provider-trace.js";
import { buildUsageSummary } from "../debug/usage-summary.js";
import { buildDeterministicDiffs } from "../diff/deterministic-diffs.js";
import { runProjectedPreAudit } from "../diff/projected-preaudit.js";
import { writeUiDiffReport, writeReportCheckpoint } from "../report/report-writer.js";
import { hydrateReportParts } from "../report/report-parts.js";
import type { UiDiffReport, RunStatus, VisualClassificationStatus, LocatorCoverageStatus, DiffRecord, ElementPair, UiArtifact, AuditScope, ModelSelection, RecoverySummary, RecoveryCursor, StageStatus, LocatorLaneMetadata, RunDebugSummary, ProjectedPreAuditSummary, DiffScope, UsageSummary } from "../schemas/core.js";
import { computeColorEvidence } from "../signals/color.js";
import { createRunId } from "./run-store.js";
import { UiDiffReportSchema } from "../schemas/core.js";
import { auditTraceHasFailure, deriveAuditStageOutcome, deriveRecoveryStageOutcome } from "./stages.js";
import type { StageOutcome } from "../schemas/core.js";

export interface RunInput {
  expectedImagePath: string;
  actualImagePath: string;
  projectRoot?: string;
  runLabel?: string;
  mode?: string;
  diffScope?: DiffScope;
  runId?: string;
  resumeRunId?: string;
  onCheckpoint?: (progress: { stage: string; checkpointPath: string; heartbeatAt: string }) => Promise<void>;
}

export interface RunOutput {
  runId: string;
  status: string;
  diffCount: number;
  unresolvedRegionCount: number;
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
  usageSummary?: UsageSummary;
}

type ProbeOverride = (entries: ModelEntry[], config: VisionProviderConfig) => Promise<ProbeResult[]>;

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
  config: VisionProviderConfig
) {
  switch (entry.provider) {
    case "opencode":
      return makeOpenCodeVisionCaller(config.openCodeApiKey, entry.model, config.openCodeBaseUrl);
    case "nvidia":
      return makeNvidiaVisionCaller(config.nvidiaApiKey, entry.model, config.nvidiaBaseUrl);
    case "openrouter":
      return makeOpenRouterVisionCaller(config.openRouterApiKey, entry.model);
    case "gemini":
      return makeGeminiVisionCaller(config.geminiApiKey, entry.model, config.geminiBaseUrl);
    case "mistral":
      return makeMistralVisionCaller(config.mistralApiKey, entry.model, config.mistralBaseUrl);
  }
}

export async function runUiDiff(input: RunInput, opts?: { probeOverride?: ProbeOverride }): Promise<RunOutput> {
  const runId = input.runId ?? input.resumeRunId ?? createRunId();
  const warnings: string[] = [];
  const mode: VisionMode = resolveMode(input.mode);

  const projectRoot = input.projectRoot ?? process.cwd();
  const expectedAbs = resolveInputImagePath(input.expectedImagePath, projectRoot);
  const actualAbs = resolveInputImagePath(input.actualImagePath, projectRoot);
  const runDir = await createRunDirectory(projectRoot, runId);
  const artifactRoot = path.join(runDir, "artifacts");
  let resumedReport: UiDiffReport | undefined;
  if (input.resumeRunId) {
    const reportPath = path.join(artifactRoot, "report.json");
    try {
      const parsed = UiDiffReportSchema.parse(JSON.parse(await fs.readFile(reportPath, "utf8")));
      resumedReport = UiDiffReportSchema.parse(await hydrateReportParts(parsed, reportPath));
    } catch {
      resumedReport = undefined;
    }
  }

  const normalizedExpPath = path.join(runDir, "expected-normalized.png");
  const normalizedActPath = path.join(runDir, "actual-normalized.png");

  const expectedImg = await loadNormalizedImage(expectedAbs, normalizedExpPath);
  const actualImg = await loadNormalizedImage(actualAbs, normalizedActPath);

  const imagePairTransform = createImagePairTransform(
    { width: expectedImg.width, height: expectedImg.height },
    { width: actualImg.width, height: actualImg.height }
  );

  // Resize actual to expected dimensions for pixel diff and overlay only.
  // Source images (actualImg) are kept at their native resolution for crops.
  const actualComparisonPath = path.join(runDir, "actual-comparison-space.png");
  await sharp(normalizedActPath)
    .resize(expectedImg.width, expectedImg.height, { fit: "fill" })
    .toFile(actualComparisonPath);
  const { data: actualComparisonRgba } = await sharp(actualComparisonPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const viewportCompatibility = computeViewportCompatibility(expectedImg.metadata, actualImg.metadata);
  if (viewportCompatibility.status === "mismatch") {
    warnings.push(`[viewport-mismatch] ${viewportCompatibility.reasons.join("; ")}`);
  }

  const pixelDiff = computePixelDiff(normalizedExpPath, actualComparisonPath);
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
    { data: actualComparisonRgba, width: expectedImg.width, height: expectedImg.height },
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
  let recoveryCursor: RecoveryCursor | undefined = undefined;
  let regionLedger: RegionLedger | undefined;
  const debugTrace: RunDebugTrace = { audit: [], coverage: [], recovery: [] };
  const providerTrace = new ProviderTraceWriter();
  const allDiffs: DiffRecord[] = [];
  const stages: StageStatus[] = resumedReport?.stages ? [...resumedReport.stages] : [];
  const createdAt = new Date().toISOString();
  const runArtifacts: UiArtifact[] = [
    { role: "expected_normalized", path: normalizedExpPath },
    { role: "actual_normalized", path: normalizedActPath },
    { role: "actual_comparison_space", path: actualComparisonPath },
    { role: "pixel_diff", path: pixelDiffPngPath },
    { role: "pixel_diff_mask", path: pixelDiffMaskPath },
    { role: "directional_overlay", path: directionalOverlayPath }
  ];

  function applyResidualSuppression(ledger: RegionLedger): void {
    const decisions = classifyResidualFragments(ledger.regions, allDiffs, {
      maxDistancePx: 24,
      maxResidualPixels: 120,
      maxThinSidePx: 4,
      minAreaMultiplier: 8
    });
    applyResidualFragmentDecisions(ledger, decisions);
  }

  async function refreshProviderTraceArtifact(): Promise<void> {
    const artifact = await writeProviderTrace(artifactRoot, providerTrace);
    const existingIndex = runArtifacts.findIndex(a => a.role === "provider_trace");
    if (existingIndex >= 0) runArtifacts[existingIndex] = artifact;
    else runArtifacts.push(artifact);
  }

  function upsertStage(
    stageName: string,
    stageStatus: StageStatus["status"],
    outcome: StageOutcome,
    detail?: string
  ): void {
    const stageRecord: StageStatus = {
      name: stageName,
      status: stageStatus,
      outcome,
      completedAt: new Date().toISOString(),
      ...(detail !== undefined ? { detail } : {})
    };
    const existingStageIndex = stages.findIndex(stage => stage.name === stageName);
    if (existingStageIndex >= 0) stages[existingStageIndex] = stageRecord;
    else stages.push(stageRecord);
  }

  async function checkpoint(
    stageName: string,
    stageStatus: StageStatus["status"],
    outcome: StageOutcome,
    detail: string | undefined,
    currentPairs: ElementPair[],
    currentModelHealth: UiDiffReport["modelHealth"]
  ): Promise<void> {
    upsertStage(stageName, stageStatus, outcome, detail);
    await refreshProviderTraceArtifact();
    const checkpointPath = await writeReportCheckpoint({
      schemaVersion: "0.1",
      runId,
      createdAt,
      status: "running",
      isCheckpoint: true,
      heartbeatAt: new Date().toISOString(),
      progress: { stage: stageName },
      visualClassificationStatus,
      locatorCoverageStatus,
      ...(input.diffScope !== undefined ? { diffScope: input.diffScope } : {}),
      ...(auditScope !== undefined ? { auditScope } : {}),
      ...(modelSelection !== undefined ? { modelSelection } : {}),
      ...(recoverySummary !== undefined ? { recoverySummary } : {}),
      ...(recoveryCursor !== undefined ? { recoveryCursor } : {}),
      imageNormalization: { expected: expectedImg.metadata, actual: actualImg.metadata },
      viewportCompatibilityStatus: viewportCompatibility.status,
      viewportCompatibilityReasons: viewportCompatibility.reasons,
      expectedImagePath: expectedAbs,
      actualImagePath: actualAbs,
      artifactRoot,
      elements: { expected: expectedElements, actual: actualElements },
      pairs: currentPairs,
      diffs: allDiffs,
      unresolvedRegions: [],
      modelHealth: currentModelHealth,
      runArtifacts,
      usageSummary: buildUsageSummary(providerTrace.getEvents()),
      warnings,
      stages: [...stages]
    });
    if (input.onCheckpoint) {
      await input.onCheckpoint({ stage: stageName, checkpointPath, heartbeatAt: new Date().toISOString() });
    }
  }

  const providerConfig = resolveVisionProviderConfig(process.env);
  const { openRouterApiKey } = providerConfig;
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

  const deterministicLocatorEnabled = process.env["UI_DIFF_DETERMINISTIC_LOCATOR"] === "1";
  if ((mode !== "deterministic_only" || deterministicLocatorEnabled) && status !== "insufficient_free_quota") {
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
        actualElements.push(...projectElementsToActual(expectedElements, imagePairTransform));
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
    minMovePx: 4,
    transform: imagePairTransform
  });
  allDiffs.push(...deterministicDiffs);

  let projectedPreAuditSummary: ProjectedPreAuditSummary | undefined;
  const projectedPreAuditResult = await runProjectedPreAudit({
    pairs,
    expectedElements,
    actualElements,
    expectedRgba: { data: expectedImg.rgba, width: expectedImg.width, height: expectedImg.height },
    actualRgba: { data: actualImg.rgba, width: actualImg.width, height: actualImg.height },
    artifactDir: artifactRoot
  });
  allDiffs.push(...projectedPreAuditResult.diffs);
  projectedPreAuditSummary = projectedPreAuditResult.summary;

  // VLM-eligible pairs are those not already resolved deterministically by pre-audit.
  const vlmCandidatePairs = pairs.filter(p => !projectedPreAuditResult.skipVlmPairIds.has(p.id));

  const modelHealth: UiDiffReport["modelHealth"] = [];
  const locatorStageOutcome: StageOutcome = locatorFailed || locatorCoverageStatus === "failed"
    ? "unavailable"
    : locatorCoverageStatus === "weak"
      ? "incomplete"
      : "success";
  await checkpoint(
    "locator_pairing_deterministic",
    "complete",
    locatorStageOutcome,
    locatorStageOutcome === "success" ? undefined : locatorCoverageStatus,
    pairs,
    modelHealth
  );

  if (mode !== "deterministic_only" && status !== "insufficient_free_quota") {
    const probe = opts?.probeOverride ?? probeRequiredModels;
    const probeEntries: ModelEntry[] = CANONICAL_MODEL_RANKING.flatMap(c => {
      const supportsRecovery = c.role !== "target_recovery" &&
        c.capabilities?.allowedRoles.includes("target_recovery") === true;
      const freeEntries = c.eligibleFreeProviderRoutes.map(r => ({
        role: c.role,
        provider: r.provider,
        model: r.model,
        costClass: c.costClass,
        probeTtlMs: 15 * 60 * 1000,
        required: false
      }));
      const freeRecoveryEntries: ModelEntry[] = supportsRecovery
        ? c.eligibleFreeProviderRoutes.map(r => ({
            role: "target_recovery" as const,
            provider: r.provider,
            model: r.model,
            costClass: c.costClass,
            probeTtlMs: 15 * 60 * 1000,
            required: false
          }))
        : [];
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
      const paidRecoveryEntries: ModelEntry[] = (supportsRecovery && mode === "paid" && paidModeEnabled && c.paidRoutes)
        ? c.paidRoutes.map(r => ({
            role: "target_recovery" as const,
            provider: r.provider,
            model: r.model,
            costClass: "paid" as const,
            probeTtlMs: 24 * 60 * 60 * 1000,
            required: false
          }))
        : [];
      return [...freeEntries, ...freeRecoveryEntries, ...paidEntries, ...paidRecoveryEntries];
    });

    const probeResults = await probe(probeEntries, providerConfig, providerTrace.sink);
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

    await checkpoint(
      "model_probe",
      "complete",
      auditorEntry && reviewerEntry ? "success" : "unavailable",
      !auditorEntry ? "auditor_unavailable" : !reviewerEntry ? "reviewer_unavailable" : undefined,
      pairs,
      modelHealth
    );

    if (!auditorEntry || !reviewerEntry) {
      if (!locatorFailed) {
        status = "model_unavailable";
        visualClassificationStatus = "incomplete";
        warnings.push(`No visual model passed the required image/schema probes for mode "${mode}". Inspect modelHealth and provider-trace.json.`);
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
        // Surface cross-provider fallback availability before any runtime route transition.
        for (const [role, primary, routes] of [
          ["auditor", auditorEntry, auditorCandidates],
          ["reviewer", reviewerEntry, reviewerCandidates],
          ["target_recovery", recoveryEntry, recoveryCandidates]
        ] as const) {
          if (
            primary !== undefined &&
            routes.some(r => r.provider !== primary.provider) &&
            (mode === "free")
          ) {
            const fallbackProviders = [...new Set(routes
              .filter(route => route.provider !== primary.provider)
              .map(route => route.provider))].join(", ");
            warnings.push(
              `${role} primary route is ${primary.provider}/${primary.model}; ` +
              `${fallbackProviders} fallback routes are available and activate only after a traced runtime failure.`
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
            caller: makeVisionCaller(e, providerConfig),
            provider: e.provider,
            model: e.model,
            phase: "audit" as const
          })),
          makeFallbackWarning("auditor"),
          providerTrace.sink
        );
        const reviewerCaller = makeFallbackVisionCaller(
          reviewerCandidates.map(e => ({
            caller: makeVisionCaller(e, providerConfig),
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
                caller: makeVisionCaller(e, providerConfig),
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
        const auditSelection = selectAuditPairsForRun(vlmCandidatePairs, process.env);
        if (auditSelection.warning) {
          warnings.push(auditSelection.warning);
        }

        const auditTotal = auditSelection.pairs.length;
        const auditOutcomes: AuditPairOutcome[] = [];
        let auditStoppedReason: "none" | "route_exhausted" = "none";
        let remainingAuditPairs = 0;
        for (let auditIdx = 0; auditIdx < auditSelection.pairs.length; auditIdx++) {
          const pair = auditSelection.pairs[auditIdx]!;
          const expEl = expectedElements.find(e => e.id === pair.expectedId);
          const actEl = actualElements.find(e => e.id === pair.actualId);
          const refEl = expEl ?? actEl;
          if (!refEl) {
            auditOutcomes.push({ pairId: pair.id, entered: false, providerCalled: false, validAuditor: false, reviewed: false, skippedNoTrigger: true, failed: false });
            continue;
          }

          const colorEvidence = (expEl || actEl) ? computeColorEvidence(
            expectedImg.rgba,
            actualImg.rgba,
            expectedImg.width,
            actualImg.width,
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

          let accepted: DiffRecord[];
          let trace: import("../schemas/core.js").AuditCriterionTrace[];
          try {
            ({ accepted, trace } = await auditElementPair(pair, ctx));
          } catch (err) {
            if (!(err instanceof RouteExhaustedError)) throw err;
            auditOutcomes.push({ pairId: pair.id, entered: true, providerCalled: true, validAuditor: false, reviewed: false, skippedNoTrigger: false, failed: true });
            auditStoppedReason = "route_exhausted";
            remainingAuditPairs = auditSelection.pairs.length - auditIdx - 1;
            visualClassificationStatus = "incomplete";
            warnings.push(`Audit routes exhausted at pair ${pair.id}; ${remainingAuditPairs} selected pairs remain unresolved.`);
            break;
          }
          debugTrace.audit.push(...trace);
          auditedDiffs.push(...accepted);
          const providerCalled = trace.some(t => t.status !== "criterion_not_triggered");
          const reviewed = trace.some(t => ["reviewer_accepted", "reviewer_rejected", "reviewer_needs_escalation"].includes(t.status));
          const validAuditor = trace.some(t => ["auditor_no_diff", "reviewer_accepted", "reviewer_rejected", "reviewer_needs_escalation"].includes(t.status));
          const failed = providerCalled && auditTraceHasFailure(trace);
          auditOutcomes.push({ pairId: pair.id, entered: true, providerCalled, validAuditor, reviewed, skippedNoTrigger: !providerCalled, failed });
        }

        auditScope = summarizeAuditPairOutcomes(auditOutcomes, {
          totalPairs: pairs.length,
          selectedPairs: auditTotal,
          auditLimited: auditSelection.limited,
          preAuditDeterministicPairs: projectedPreAuditResult.diffs.length,
          stoppedReason: auditStoppedReason,
          remainingPairs: remainingAuditPairs,
          ...(auditSelection.warning ? { limitReason: auditSelection.warning } : {})
        });

        const merged = reviewAndMergeFindings(auditedDiffs);
        allDiffs.push(...merged);
        const auditStageOutcome = deriveAuditStageOutcome(auditScope);
        await checkpoint("audit", "complete", auditStageOutcome.outcome, auditStageOutcome.detail, pairs, modelHealth);

        // Target recovery: classify uncovered changed-pixel regions
        const significantComponents = pixelDiff.components.filter(c => c.pixelCount >= 50);
        regionLedger = buildRegionLedger(significantComponents, allDiffs, {
          minPixelCount: 50,
          maxGapPx: 12,
          maxClusterAreaRatio: 0.5,
          imageWidth: expectedImg.width,
          imageHeight: expectedImg.height
        });
        applyResidualSuppression(regionLedger);
        debugTrace.coverage = regionLedger.coverageTrace;
        const uncoveredComponents = regionLedger.regions
          .filter(region => region.state === "unresolved")
          .map(region => ({ id: region.id, box: region.box, pixelCount: region.pixelCount }));
        const preClusterUncoveredComponents = regionLedger.coverageTrace.filter(decision => decision.status === "uncovered").length;
        const postClusterUncoveredComponents = uncoveredComponents.length;
        if (uncoveredComponents.length > 0 && !recoveryCaller) {
          const prepared = await prepareRecoveryRegionArtifacts(uncoveredComponents, {
            expectedRgba: { data: expectedImg.rgba, width: expectedImg.width, height: expectedImg.height },
            actualRgba: { data: actualImg.rgba, width: actualImg.width, height: actualImg.height },
            imagePairTransform,
            pixelDiffMask: pixelDiff.diffMask,
            directionalOverlayPath,
            artifactDir: artifactRoot
          });
          applyRecoveryOutcomes(regionLedger, prepared.map(entry => ({
            regionId: entry.regionId,
            state: "unresolved" as const,
            reason: "caller_unavailable",
            artifactPaths: entry.artifacts
          })));
          recoveryCursor = { nextRegionIndex: 0, remainingModelCalls: 0, remainingRegionIds: uncoveredComponents.map(component => component.id) };
          warnings.push("Target recovery skipped: no passing target_recovery route available for current mode. Uncovered pixel regions will not be classified.");
          visualClassificationStatus = "incomplete";
          recoverySummary = {
            totalUncoveredComponents: uncoveredComponents.length,
            eligibleComponents: uncoveredComponents.length,
            completedComponents: 0,
            remainingComponents: uncoveredComponents.length,
            batchCount: 0,
            attemptedComponents: 0,
            skippedComponents: uncoveredComponents.length,
            recoveredDiffs: 0,
            unclassifiedCount: uncoveredComponents.length,
            stoppedReason: "caller_unavailable",
            preClusterUncoveredComponents,
            postClusterUncoveredComponents,
            statusCounts: {}
          };
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
          const recoveryStageOutcome = deriveRecoveryStageOutcome(recoverySummary);
          await checkpoint("target_recovery", "complete", recoveryStageOutcome.outcome, recoveryStageOutcome.detail, pairs, modelHealth);
        } else if (uncoveredComponents.length > 0 && recoveryCaller) {
          await checkpoint(
            "target_recovery",
            "running",
            "incomplete",
            "classifying_uncovered_regions",
            pairs,
            modelHealth
          );
          const recoveryResult = await runTargetRecovery(uncoveredComponents, {
            expectedRgba: { data: expectedImg.rgba, width: expectedImg.width, height: expectedImg.height },
            actualRgba: { data: actualImg.rgba, width: actualImg.width, height: actualImg.height },
            imagePairTransform,
            pixelDiffMask: pixelDiff.diffMask,
            directionalOverlayPath,
            artifactDir: artifactRoot,
            recoveryCaller,
            reviewerCaller
          });
          debugTrace.recovery.push(...recoveryResult.trace);
          const activeRecovered = filterAcceptedDiffs(recoveryResult.recovered);
          allDiffs.push(...activeRecovered);
          applyFindingCoverage(regionLedger, activeRecovered);
          applyRecoveryOutcomes(regionLedger, recoveryResult.regionOutcomes);
          applyResidualSuppression(regionLedger);
          debugTrace.coverage = regionLedger.coverageTrace;
          recoveryCursor = recoveryResult.cursor;
          recoverySummary = {
            totalUncoveredComponents: uncoveredComponents.length,
            eligibleComponents: recoveryResult.eligibleComponents,
            completedComponents: recoveryResult.completedComponents,
            remainingComponents: recoveryResult.remainingComponents,
            batchCount: recoveryResult.batchCount,
            attemptedComponents: recoveryResult.attemptedComponents,
            skippedComponents: recoveryResult.skippedComponents,
            recoveredDiffs: activeRecovered.length,
            unclassifiedCount: recoveryResult.unclassifiedCount,
            stoppedReason: recoveryResult.stoppedReason,
            preClusterUncoveredComponents,
            postClusterUncoveredComponents,
            statusCounts: recoveryResult.statusCounts
          };
          if (recoveryResult.stoppedReason !== "none" || recoveryResult.unclassifiedCount > 0) {
            visualClassificationStatus = "incomplete";
          } else if (!locatorFailed && !auditSelection.limited) {
            visualClassificationStatus = "complete";
          }
          const recoveryStageOutcome = deriveRecoveryStageOutcome(recoverySummary);
          await checkpoint("target_recovery", "complete", recoveryStageOutcome.outcome, recoveryStageOutcome.detail, pairs, modelHealth);
        } else {
          if (!locatorFailed && !auditSelection.limited) {
            visualClassificationStatus = "complete";
          }
          await checkpoint("target_recovery", "skipped", "not_applicable", "no_uncovered_regions", pairs, modelHealth);
        }
      }
    }
  }

  for (const stageName of ["model_probe", "audit", "target_recovery"] as const) {
    if (stages.some(stage => stage.name === stageName)) continue;
    if (mode === "deterministic_only") {
      upsertStage(stageName, "skipped", "not_applicable", "deterministic_only");
    } else {
      const detail = status === "insufficient_free_quota"
        ? "insufficient_free_quota"
        : locatorFailed
          ? "locator_unavailable"
          : "required_provider_stage_not_run";
      upsertStage(stageName, "skipped", "unavailable", detail);
    }
  }

  const significantComponents = pixelDiff.components.filter(c => c.pixelCount >= 50);
  regionLedger ??= buildRegionLedger(significantComponents, allDiffs, {
    minPixelCount: 50,
    maxGapPx: 12,
    maxClusterAreaRatio: 0.5,
    imageWidth: expectedImg.width,
    imageHeight: expectedImg.height
  });
  const activeDiffs = filterAcceptedDiffs(allDiffs);
  applyFindingCoverage(regionLedger, activeDiffs);
  applyResidualSuppression(regionLedger);
  debugTrace.coverage = regionLedger.coverageTrace;
  const artifactlessRegions = regionLedger.regions.filter(region => region.state === "unresolved" && region.artifactPaths.length === 0);
  if (artifactlessRegions.length > 0) {
    const prepared = await prepareRecoveryRegionArtifacts(
      artifactlessRegions.map(region => ({ id: region.id, box: region.box, pixelCount: region.pixelCount })),
      {
        expectedRgba: { data: expectedImg.rgba, width: expectedImg.width, height: expectedImg.height },
        actualRgba: { data: actualImg.rgba, width: actualImg.width, height: actualImg.height },
        imagePairTransform,
        pixelDiffMask: pixelDiff.diffMask,
        directionalOverlayPath,
        artifactDir: artifactRoot
      }
    );
    applyRecoveryOutcomes(regionLedger, prepared.map(entry => ({
      regionId: entry.regionId,
      state: "unresolved" as const,
      reason: "not_classified",
      artifactPaths: entry.artifacts
    })));
  }
  const unresolvedReason = auditScope?.stoppedReason === "route_exhausted"
    ? "audit_route_exhausted" as const
    : recoverySummary?.stoppedReason === "caller_unavailable"
      ? "recovery_route_exhausted" as const
      : recoverySummary?.stoppedReason && recoverySummary.stoppedReason !== "none"
        ? "recovery_budget_exhausted" as const
        : "not_classified" as const;
  const finalDiffs = consolidateFindings(activeDiffs, [...expectedElements, ...actualElements], pairs);
  const unresolvedRegions = unresolvedRegionsFromLedger(regionLedger, unresolvedReason);

  const contextArtifacts = await writeRegionContextOverlays({
    actualComparisonPath,
    directionalOverlayPath,
    artifactDir: artifactRoot,
    diffs: finalDiffs,
    unresolvedRegions,
    elements: expectedElements,
    actualElements,
    imagePairTransform
  });
  runArtifacts.push(...contextArtifacts);

  // Write debug trace artifacts and attach summary to the report
  const debugArtifactsResult = await writeRunDebugArtifacts(artifactRoot, debugTrace);
  runArtifacts.push(...debugArtifactsResult.artifacts);

  // Write provider-trace artifact: metadata-only record of all probe, call, route-health,
  // and fallback events. No prompts, image data, API keys, or raw response bodies.
  await refreshProviderTraceArtifact();

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
    isCheckpoint: false,
    heartbeatAt: new Date().toISOString(),
    progress: { stage: "complete" },
    visualClassificationStatus,
    locatorCoverageStatus,
    ...(input.diffScope !== undefined ? { diffScope: input.diffScope } : {}),
    ...(locatorMetadata !== undefined ? { locatorMetadata } : {}),
    ...(auditScope !== undefined ? { auditScope } : {}),
    ...(modelSelection !== undefined ? { modelSelection } : {}),
    ...(recoverySummary !== undefined ? { recoverySummary } : {}),
    ...(recoveryCursor !== undefined ? { recoveryCursor } : {}),
    ...(projectedPreAuditSummary !== undefined ? { projectedPreAudit: projectedPreAuditSummary } : {}),
    providerDiagnosticsPresent: providerTrace.getEvents().some(e => e.diagnostic !== undefined),
    imageNormalization: { expected: expectedImg.metadata, actual: actualImg.metadata },
    comparisonSpace: {
      width: expectedImg.width,
      height: expectedImg.height,
      actualResizeMode: "fill" as const,
      sourceCropsPreserveOriginalPixels: true
    },
    viewportCompatibilityStatus: viewportCompatibility.status,
    viewportCompatibilityReasons: viewportCompatibility.reasons,
    expectedImagePath: expectedAbs,
    actualImagePath: actualAbs,
    artifactRoot,
    elements: { expected: expectedElements, actual: actualElements },
    pairs,
    diffs: finalDiffs,
    unresolvedRegions,
    modelHealth,
    runArtifacts,
    usageSummary: buildUsageSummary(providerTrace.getEvents()),
    warnings,
    stages,
    debugSummary: debugArtifactsResult.summary
  };

  return writeUiDiffReport(report);
}
