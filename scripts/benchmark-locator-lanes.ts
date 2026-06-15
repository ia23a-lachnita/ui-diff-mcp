import fs from "node:fs/promises";
import path from "node:path";
import { locateUiElements } from "../src/locator/locateanything-client.js";
import { buildElementMap } from "../src/locator/element-map.js";
import { computeImageLocatorCoverage } from "../src/locator/coverage.js";

const expectedImagePath = process.env["UI_DIFF_LIVE_EXPECTED_IMAGE"];
const actualImagePath = process.env["UI_DIFF_LIVE_ACTUAL_IMAGE"];
const sidecarUrl = process.env["LOCATEANYTHING_SIDECAR_URL"] ?? "http://127.0.0.1:39731";

if (!expectedImagePath || !actualImagePath) {
  throw new Error("UI_DIFF_LIVE_EXPECTED_IMAGE and UI_DIFF_LIVE_ACTUAL_IMAGE are required");
}

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

console.log(`Benchmarking locator lanes against sidecar at ${sidecarUrl}`);
console.log(`Expected: ${expectedImagePath}`);
console.log(`Actual:   ${actualImagePath}`);

const startMs = Date.now();

const [expResp, actResp] = await Promise.all([
  locateUiElements({ endpoint: sidecarUrl, request: { imagePath: expectedImagePath, queries: locatorQueries, generationMode: "hybrid", maxBoxesPerQuery: 200 }, timeoutMs: 600000, maxDimension: 1200 }),
  locateUiElements({ endpoint: sidecarUrl, request: { imagePath: actualImagePath, queries: locatorQueries, generationMode: "hybrid", maxBoxesPerQuery: 200 }, timeoutMs: 600000, maxDimension: 1200 })
]);

const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);

const expElements = buildElementMap(expResp.elements, { width: expResp.image.width, height: expResp.image.height });
const actElements = buildElementMap(actResp.elements, { width: actResp.image.width, height: actResp.image.height });

const expCoverage = computeImageLocatorCoverage({ elements: expElements, promptCount: locatorQueries.length, imageSize: { width: expResp.image.width, height: expResp.image.height } });
const actCoverage = computeImageLocatorCoverage({ elements: actElements, promptCount: locatorQueries.length, imageSize: { width: actResp.image.width, height: actResp.image.height } });

const expLanes = expResp.metadata?.lanes ?? {};
const actLanes = actResp.metadata?.lanes ?? {};
const allLaneKeys = [...new Set([...Object.keys(expLanes), ...Object.keys(actLanes)])].sort();

const laneTable = allLaneKeys.map(lane => {
  const e = expLanes[lane] ?? { status: "not_configured", count: 0 };
  const a = actLanes[lane] ?? { status: "not_configured", count: 0 };
  return `| ${lane} | ${e.status} | ${e.count} | ${a.status} | ${a.count} |`;
}).join("\n");

const markdown = `# Locator Lane Benchmark

**Generated:** ${new Date().toISOString()}
**Elapsed:** ${elapsedSec}s
**Sidecar:** ${sidecarUrl}

## Lane Results

| Lane | Expected Status | Expected Count | Actual Status | Actual Count |
|------|----------------|----------------|--------------|-------------|
${laneTable}

## Per-Image Coverage

| Image | Status | Useful Elements | Query Coverage Ratio | Reasons |
|-------|--------|----------------|---------------------|---------|
| expected | ${expCoverage.status} | ${expCoverage.usefulElementCount} | ${expCoverage.queryCoverageRatio.toFixed(2)} | ${expCoverage.reasons.join(", ") || "none"} |
| actual | ${actCoverage.status} | ${actCoverage.usefulElementCount} | ${actCoverage.queryCoverageRatio.toFixed(2)} | ${actCoverage.reasons.join(", ") || "none"} |

## Default Parser Policy

Default enabled lanes:

1. \`cv_components\`
2. \`ocr_text\` when an OCR engine is installed
3. \`locateanything\`
4. \`omniparser\` only when explicitly enabled and license accepted
5. \`yolo_ui\` only when a local model path is configured

Release selection rule: Calorix bounded and full live gates must pass with this policy before tagging.
`;

const outPath = path.resolve("docs/research/locator-lane-benchmark.md");
await fs.writeFile(outPath, markdown, "utf8");
console.log(`\nBenchmark written to ${outPath}`);
console.log(`Expected coverage: ${expCoverage.status} (${expCoverage.usefulElementCount} useful elements)`);
console.log(`Actual coverage:   ${actCoverage.status} (${actCoverage.usefulElementCount} useful elements)`);
