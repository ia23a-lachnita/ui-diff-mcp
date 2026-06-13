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
import { getModelByRole, getRequiredModels } from "../models/model-registry.js";
import { probeRequiredModels } from "../models/probes.js";
import { auditElementPair, type AuditContext } from "../audit/audit-target.js";
import { reviewAndMergeFindings } from "../audit/review-findings.js";
import { assignDiffComponentsToRecords } from "../report/coverage.js";
import { writeUiDiffReport } from "../report/report-writer.js";
import type { UiDiffReport, RunStatus, VisualClassificationStatus, DiffRecord } from "../schemas/core.js";
import { sampleColorStats } from "../signals/color.js";

export interface RunInput {
  expectedImagePath: string;
  actualImagePath: string;
  projectRoot?: string;
  runLabel?: string;
  mode?: "full" | "deterministic_only" | "free_only";
}

export interface RunOutput {
  runId: string;
  status: string;
  diffCount: number;
  reportPath: string;
  artifactRoot: string;
  summary: string;
  warnings: string[];
}

export async function runUiDiff(input: RunInput): Promise<RunOutput> {
  const runId = `run-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const warnings: string[] = [];
  const mode = input.mode ?? "full";

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
  const locatorUrl = process.env["LOCATEANYTHING_SIDECAR_URL"] ?? "http://127.0.0.1:39731";

  const expectedElements: ReturnType<typeof buildElementMap> = [];
  const actualElements: ReturnType<typeof buildElementMap> = [];

  if (mode !== "deterministic_only") {
    try {
      const [expResp, actResp] = await Promise.all([
        locateUiElements({
          endpoint: locatorUrl,
          request: {
            imagePath: normalizedExpPath,
            queries: [
              { id: "text", prompt: "text labels and headings" },
              { id: "button", prompt: "buttons and interactive elements" },
              { id: "icon", prompt: "icons and images" },
              { id: "card", prompt: "cards and panels" },
              { id: "chart", prompt: "charts and graphs" }
            ],
            generationMode: "hybrid",
            maxBoxesPerQuery: 200
          },
          timeoutMs: 30000
        }),
        locateUiElements({
          endpoint: locatorUrl,
          request: {
            imagePath: normalizedActPath,
            queries: [
              { id: "text", prompt: "text labels and headings" },
              { id: "button", prompt: "buttons and interactive elements" },
              { id: "icon", prompt: "icons and images" },
              { id: "card", prompt: "cards and panels" },
              { id: "chart", prompt: "charts and graphs" }
            ],
            generationMode: "hybrid",
            maxBoxesPerQuery: 200
          },
          timeoutMs: 30000
        })
      ]);
      expectedElements.push(...buildElementMap(expResp.elements, { width: expectedImg.width, height: expectedImg.height }));
      actualElements.push(...buildElementMap(actResp.elements, { width: actualImg.width, height: actualImg.height }));
    } catch (err) {
      if (err instanceof LocatorUnavailableError) {
        warnings.push(`Locator unavailable: ${err.message}. Skipping element discovery.`);
      } else {
        warnings.push(`Locator error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const pairs = pairElements(expectedElements, actualElements);

  const modelHealth: UiDiffReport["modelHealth"] = [];

  if (mode === "full" || mode === "free_only") {
    const probeResults = await probeRequiredModels(getRequiredModels(), openRouterApiKey);
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
      m => (m.status === "fail" || m.status === "not_checked") && (m.role === "auditor" || m.role === "reviewer")
    );

    if (requiredFailed.length > 0) {
      status = "model_unavailable";
      visualClassificationStatus = "incomplete";
      warnings.push(`Required models unavailable: ${requiredFailed.map(m => m.model).join(", ")}`);
    } else {
      visualClassificationStatus = "incomplete";
      const auditorModel = getModelByRole("auditor")?.model ?? "qwen/qwen3-vl-30b-a3b-instruct";
      const reviewerModel = getModelByRole("reviewer")?.model ?? "google/gemini-2.5-flash-lite";

      const auditedDiffs: DiffRecord[] = [];

      for (const pair of pairs) {
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
          openRouterApiKey,
          auditorModel,
          reviewerModel,
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
      visualClassificationStatus = "complete";
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
    warnings
  };

  return writeUiDiffReport(report);
}
