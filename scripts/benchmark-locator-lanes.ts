import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { locateUiElements } from "../src/locator/locateanything-client.js";
import { buildElementMap } from "../src/locator/element-map.js";
import { computeImageLocatorCoverage } from "../src/locator/coverage.js";
import type { Box, LocatorLaneMetadata, UiElement } from "../src/schemas/core.js";

const DEFAULT_DIMENSIONS = [600, 900, 1200];

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

export interface BenchmarkElementSummary {
  id: string;
  label: string;
  type: UiElement["type"];
  queryId?: string;
  box: Box;
}

export interface BenchmarkImageResult {
  elapsedMs: number;
  imageWidth: number;
  imageHeight: number;
  usefulElementCount: number;
  queryCoverageRatio: number;
  queryCounts: Record<string, number>;
  laneMetadata: Record<string, LocatorLaneMetadata>;
  elements: BenchmarkElementSummary[];
}

export interface BenchmarkStabilitySummary {
  comparedTo?: number;
  expectedMissingLabels?: string[];
  actualMissingLabels?: string[];
  expectedExtraLabels?: string[];
  actualExtraLabels?: string[];
}

export type BenchmarkTrial =
  | {
    maxDimension: number;
    status: "complete";
    expected: BenchmarkImageResult;
    actual: BenchmarkImageResult;
    stability?: BenchmarkStabilitySummary;
  }
  | {
    maxDimension: number;
    status: "timeout" | "error";
    error: string;
  };

export interface LocatorBenchmarkReport {
  generatedAt: string;
  sidecarUrl: string;
  expectedImagePath: string;
  actualImagePath: string;
  conclusion: "needs_live_data" | "complete";
  trials: BenchmarkTrial[];
}

export function parseBenchmarkDimensions(value: string | undefined): number[] {
  const raw = value?.trim() ? value : DEFAULT_DIMENSIONS.join(",");
  const dims = raw.split(",")
    .map(part => Number.parseInt(part.trim(), 10))
    .filter(dim => Number.isFinite(dim) && dim >= 200 && dim <= 2400);
  return [...new Set(dims)].sort((a, b) => a - b);
}

function elementKey(element: BenchmarkElementSummary): string {
  return `${element.type}:${element.label}`;
}

function sortedDiff(left: string[], right: string[]): string[] {
  const leftSet = new Set(left);
  return right.filter(value => !leftSet.has(value)).sort();
}

export function summarizeLabelStability(
  trialLabels: { expected: string[]; actual: string[] },
  referenceLabels: { expected: string[]; actual: string[] }
): Required<Pick<BenchmarkStabilitySummary, "expectedMissingLabels" | "actualMissingLabels" | "expectedExtraLabels" | "actualExtraLabels">> {
  return {
    expectedMissingLabels: sortedDiff(trialLabels.expected, referenceLabels.expected),
    actualMissingLabels: sortedDiff(trialLabels.actual, referenceLabels.actual),
    expectedExtraLabels: sortedDiff(referenceLabels.expected, trialLabels.expected),
    actualExtraLabels: sortedDiff(referenceLabels.actual, trialLabels.actual)
  };
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`;
}

function count(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

export function buildLocatorBenchmarkMarkdown(report: LocatorBenchmarkReport): string {
  const rows = report.trials.map(trial => {
    if (trial.status !== "complete") {
      return `| ${trial.maxDimension} | ${trial.status} | - | - | - | - | ${trial.error.replaceAll("|", "\\|")} |`;
    }
    return `| ${trial.maxDimension} | complete | ${seconds(trial.expected.elapsedMs)} | ${seconds(trial.actual.elapsedMs)} | ${count(trial.expected.usefulElementCount)} | ${count(trial.actual.usefulElementCount)} | none |`;
  }).join("\n");

  const stabilityRows = report.trials
    .filter((trial): trial is Extract<BenchmarkTrial, { status: "complete" }> => trial.status === "complete" && trial.stability !== undefined)
    .map(trial => {
      const stability = trial.stability;
      return `| ${trial.maxDimension} | ${stability?.comparedTo ?? "-"} | ${(stability?.expectedMissingLabels ?? []).length} | ${(stability?.actualMissingLabels ?? []).length} | ${(stability?.expectedExtraLabels ?? []).length} | ${(stability?.actualExtraLabels ?? []).length} |`;
    })
    .join("\n");

  const detailSections = report.trials.map(trial => {
    if (trial.status !== "complete") {
      return `### ${trial.maxDimension}px\n\nStatus: \`${trial.status}\`\n\nError: ${trial.error}\n`;
    }
    return `### ${trial.maxDimension}px\n\n` +
      `| Image | Useful Elements | Query Coverage Ratio | Query Counts |\n` +
      `|-------|----------------|----------------------|--------------|\n` +
      `| expected | ${trial.expected.usefulElementCount} | ${trial.expected.queryCoverageRatio.toFixed(2)} | \`${JSON.stringify(trial.expected.queryCounts)}\` |\n` +
      `| actual | ${trial.actual.usefulElementCount} | ${trial.actual.queryCoverageRatio.toFixed(2)} | \`${JSON.stringify(trial.actual.queryCounts)}\` |\n`;
  }).join("\n");

  return `# Locator Lane Benchmark

**Generated:** ${report.generatedAt}
**Sidecar:** ${report.sidecarUrl}
**Expected:** ${report.expectedImagePath}
**Actual:** ${report.actualImagePath}
**Conclusion:** ${report.conclusion}

Trials are executed sequentially so local sidecar CPU/GPU contention does not distort elapsed times.

## Dimension Summary

| Max Dimension | Status | Expected Time | Actual Time | Expected Useful | Actual Useful | Error |
|---------------|--------|---------------|-------------|-----------------|---------------|-------|
${rows}

## Stability Compared To Largest Completed Dimension

| Max Dimension | Compared To | Expected Missing | Actual Missing | Expected Extra | Actual Extra |
|---------------|-------------|------------------|----------------|----------------|--------------|
${stabilityRows || "| - | - | - | - | - | - |"}

## Per-Dimension Details

${detailSections}

## Interpretation

\`600\` is a local timeout workaround, not a production-quality default. Prefer the highest dimension that fits the sidecar budget, and use this benchmark to decide whether the quality/runtime trade-off is acceptable on the current machine.
`;
}

function labelList(result: BenchmarkImageResult): string[] {
  return result.elements.map(elementKey);
}

function addStability(trials: BenchmarkTrial[]): BenchmarkTrial[] {
  const completed = trials.filter((trial): trial is Extract<BenchmarkTrial, { status: "complete" }> => trial.status === "complete");
  const reference = completed.at(-1);
  if (!reference) return trials;
  const referenceLabels = { expected: labelList(reference.expected), actual: labelList(reference.actual) };
  return trials.map(trial => {
    if (trial.status !== "complete" || trial.maxDimension === reference.maxDimension) return trial;
    return {
      ...trial,
      stability: {
        comparedTo: reference.maxDimension,
        ...summarizeLabelStability(
          { expected: labelList(trial.expected), actual: labelList(trial.actual) },
          referenceLabels
        )
      }
    };
  });
}

async function runImageTrial(
  imagePath: string,
  sidecarUrl: string,
  timeoutMs: number,
  maxDimension: number
): Promise<BenchmarkImageResult> {
  const started = Date.now();
  const resp = await locateUiElements({
    endpoint: sidecarUrl,
    request: { imagePath, queries: locatorQueries, generationMode: "hybrid", maxBoxesPerQuery: 200 },
    timeoutMs,
    maxDimension
  });
  const elapsedMs = Date.now() - started;
  const elements = buildElementMap(resp.elements, { width: resp.image.width, height: resp.image.height });
  const coverage = computeImageLocatorCoverage({
    elements,
    promptCount: locatorQueries.length,
    imageSize: { width: resp.image.width, height: resp.image.height }
  });
  return {
    elapsedMs,
    imageWidth: resp.image.width,
    imageHeight: resp.image.height,
    usefulElementCount: coverage.usefulElementCount,
    queryCoverageRatio: coverage.queryCoverageRatio,
    queryCounts: coverage.queryCounts,
    laneMetadata: resp.metadata?.lanes ?? {},
    elements: elements.map(element => ({
      id: element.id,
      label: element.label,
      type: element.type,
      ...(element.queryId !== undefined ? { queryId: element.queryId } : {}),
      box: element.box
    }))
  };
}

async function runTrial(
  maxDimension: number,
  expectedImagePath: string,
  actualImagePath: string,
  sidecarUrl: string,
  timeoutMs: number
): Promise<BenchmarkTrial> {
  try {
    const expected = await runImageTrial(expectedImagePath, sidecarUrl, timeoutMs, maxDimension);
    const actual = await runImageTrial(actualImagePath, sidecarUrl, timeoutMs, maxDimension);
    return { maxDimension, status: "complete", expected, actual };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      maxDimension,
      status: /abort|timeout|timed out/i.test(error) ? "timeout" : "error",
      error
    };
  }
}

export async function main(): Promise<void> {
  const expectedImagePath = process.env["UI_DIFF_LIVE_EXPECTED_IMAGE"];
  const actualImagePath = process.env["UI_DIFF_LIVE_ACTUAL_IMAGE"];
  const sidecarUrl = process.env["LOCATEANYTHING_SIDECAR_URL"] ?? "http://127.0.0.1:39731";
  const timeoutMs = Number.parseInt(process.env["LOCATEANYTHING_TIMEOUT_MS"] ?? "600000", 10);
  const dimensions = parseBenchmarkDimensions(process.env["UI_DIFF_LOCATOR_BENCHMARK_DIMENSIONS"]);

  if (!expectedImagePath || !actualImagePath) {
    throw new Error("UI_DIFF_LIVE_EXPECTED_IMAGE and UI_DIFF_LIVE_ACTUAL_IMAGE are required");
  }

  console.log(`Benchmarking locator lanes against sidecar at ${sidecarUrl}`);
  console.log(`Expected: ${expectedImagePath}`);
  console.log(`Actual:   ${actualImagePath}`);
  console.log(`Dimensions: ${dimensions.join(", ")} (sequential)`);

  const trials: BenchmarkTrial[] = [];
  for (const maxDimension of dimensions) {
    console.log(`\nRunning ${maxDimension}px trial...`);
    const trial = await runTrial(maxDimension, expectedImagePath, actualImagePath, sidecarUrl, timeoutMs);
    trials.push(trial);
    console.log(`${maxDimension}px: ${trial.status}`);
  }

  const report: LocatorBenchmarkReport = {
    generatedAt: new Date().toISOString(),
    sidecarUrl,
    expectedImagePath,
    actualImagePath,
    conclusion: "needs_live_data",
    trials: addStability(trials)
  };

  const jsonPath = path.resolve("docs/research/locator-lane-benchmark.json");
  const mdPath = path.resolve("docs/research/locator-lane-benchmark.md");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(mdPath, buildLocatorBenchmarkMarkdown(report), "utf8");
  console.log(`\nBenchmark written to ${mdPath}`);
  console.log(`Structured data written to ${jsonPath}`);
}

const isDirect = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirect) {
  await main();
}
