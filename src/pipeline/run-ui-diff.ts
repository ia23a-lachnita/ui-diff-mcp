import crypto from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { resolveInputImagePath, createRunDirectory } from "../security/paths.js";
import { loadNormalizedImage } from "../images/normalize.js";
import { writeOverlay } from "../images/artifacts.js";
import { computePixelDiff } from "../signals/pixel-diff.js";
import { extractEdgeMask } from "../signals/edge.js";
import { locateUiElements, LocatorUnavailableError } from "../locator/locateanything-client.js";
import { buildElementMap } from "../locator/element-map.js";
import { pairElements } from "../pairing/pair-elements.js";
import { selectModelForMode, resolveMode } from "../models/model-registry.js";
import { probeRequiredModels, type ProbeResult } from "../models/probes.js";
import { makeOpenRouterVisionCaller, makeNvidiaVisionCaller, type VisionMode } from "../models/vision-json.js";
import { auditElementPair, type AuditContext } from "../audit/audit-target.js";
import { reviewAndMergeFindings } from "../audit/review-findings.js";
import { assignDiffComponentsToRecords } from "../report/coverage.js";
import { writeUiDiffReport } from "../report/report-writer.js";
import type { UiDiffReport, RunStatus, VisualClassificationStatus, DiffRecord, ElementPair } from "../schemas/core.js";
import { sampleColorStats } from "../signals/color.js";
import type { ModelEntry } from "../models/model-registry.js";

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
  runArtifacts: string[];
  summary: string;
  warnings: string[];
}

type ProbeOverride = (entries: ModelEntry[], apiKey: string) => Promise<ProbeResult[]>;

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
  const overlayPath = path.join(runDir, "diff-overlay.png");
  await writeOverlay(normalizedExpPath, pixelDiffPngPath, overlayPath);
  const edgeMask = extractEdgeMask(expectedImg.rgba, expectedImg.width, expectedImg.height);

  let status: RunStatus = "complete";
  let visualClassificationStatus: VisualClassificationStatus = "not_run";
  const allDiffs: DiffRecord[] = [];

  const openRouterApiKey = process.env["OPENROUTER_API_KEY"] ?? "";
  const nvidiaApiKey = process.env["NVIDIA_API_KEY"] ?? "";
  const nvidiaBaseUrl = process.env["NVIDIA_VLM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1";
  const locatorUrl = process.env["LOCATEANYTHING_SIDECAR_URL"] ?? "http://127.0.0.1:39731";
  const locatorTimeoutMs = Number.parseInt(process.env["LOCATEANYTHING_TIMEOUT_MS"] ?? "300000", 10);
  const locatorQueries = [
    {
      id: "ui_elements",
      prompt: "Detect all text and visible mobile UI elements in box format."
    }
  ];

  const expectedElements: ReturnType<typeof buildElementMap> = [];
  const actualElements: ReturnType<typeof buildElementMap> = [];
  let locatorFailed = false;

  if (mode !== "deterministic_only") {
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
    } catch (err) {
      locatorFailed = true;
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

  if (mode !== "deterministic_only") {
    const auditorEntry = selectModelForMode("auditor", mode);
    const reviewerEntry = selectModelForMode("reviewer", mode);

    if (!auditorEntry || !reviewerEntry) {
      if (!locatorFailed) {
        status = "model_unavailable";
        visualClassificationStatus = "incomplete";
        warnings.push(`No model available for mode "${mode}". Set NVIDIA_API_KEY or use a mode with OpenRouter free models.`);
      }
    } else {
      const probe = opts?.probeOverride ?? probeRequiredModels;
      const probeEntries = [auditorEntry, reviewerEntry];
      const probeResults = await probe(probeEntries, openRouterApiKey);
      for (const p of probeResults) {
        modelHealth.push({
          role: p.role,
          provider: p.provider,
          model: p.model,
          status: p.status,
          checkedAt: p.checkedAt,
          ...(p.detail !== undefined ? { detail: p.detail } : {})
        });
      }

      const requiredFailed = modelHealth.filter(
        m => (m.status === "fail" || m.status === "not_checked") && (m.role === "free_auditor" || m.role === "auditor" || m.role === "free_reviewer" || m.role === "reviewer")
      );
      if (requiredFailed.length > 0) {
        if (!locatorFailed) {
          status = "model_unavailable";
          visualClassificationStatus = "incomplete";
          warnings.push(`Required models unavailable: ${requiredFailed.map(m => m.model).join(", ")}`);
        }
      } else {
        const auditorCaller = makeVisionCaller(auditorEntry, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);
        const reviewerCaller = makeVisionCaller(reviewerEntry, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);

        visualClassificationStatus = "incomplete";
        const auditedDiffs: DiffRecord[] = [];
        const auditSelection = selectAuditPairsForRun(pairs, process.env);
        if (auditSelection.warning) {
          warnings.push(auditSelection.warning);
        }

        for (const pair of auditSelection.pairs) {
          const expEl = expectedElements.find(e => e.id === pair.expectedId);
          const actEl = actualElements.find(e => e.id === pair.actualId);
          const refEl = expEl ?? actEl;
          if (!refEl) continue;

          const expStats = expEl
            ? sampleColorStats(expectedImg.rgba, expectedImg.width, expEl.box)
            : null;
          const actStats = actEl
            ? sampleColorStats(actualImg.rgba, actualImg.width, actEl.box)
            : null;

          const colorDelta = expStats && actStats
            ? Math.abs(expStats.avgR - actStats.avgR) +
              Math.abs(expStats.avgG - actStats.avgG) +
              Math.abs(expStats.avgB - actStats.avgB) > 30
            : false;

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
            imageWidth: expectedImg.width,
            imageHeight: expectedImg.height,
            measurements: [],
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
            }
          };

          const { accepted } = await auditElementPair(pair, ctx);
          auditedDiffs.push(...accepted);
        }

        const merged = reviewAndMergeFindings(auditedDiffs);
        allDiffs.push(...merged);
        if (!locatorFailed && !auditSelection.limited) {
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

  const report: UiDiffReport = {
    schemaVersion: "0.1",
    runId,
    createdAt: new Date().toISOString(),
    status,
    visualClassificationStatus,
    expectedImagePath: expectedAbs,
    actualImagePath: actualAbs,
    artifactRoot,
    elements: { expected: expectedElements, actual: actualElements },
    pairs,
    diffs: finalDiffs,
    modelHealth,
    runArtifacts: [pixelDiffPngPath, overlayPath],
    warnings
  };

  return writeUiDiffReport(report);
}
