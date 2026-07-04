import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { Box, UiArtifact, UiElement } from "../schemas/core.js";

export interface LocatorOverlayInput {
  expectedImagePath: string;
  actualImagePath: string;
  artifactDir: string;
  expectedElements: UiElement[];
  actualElements: UiElement[];
  actualMode: "projected" | "independent";
}

interface OverlayEntry {
  overlayId: string;
  element: UiElement;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function clampBox(box: Box, width: number, height: number): Box {
  const x = Math.max(0, Math.min(Math.round(box.x), Math.max(0, width - 1)));
  const y = Math.max(0, Math.min(Math.round(box.y), Math.max(0, height - 1)));
  const right = Math.max(x + 1, Math.min(Math.round(box.x + box.width), width));
  const bottom = Math.max(y + 1, Math.min(Math.round(box.y + box.height), height));
  return { x, y, width: right - x, height: bottom - y };
}

function overlayStyle(width: number, height: number): {
  fontSize: number;
  labelHeight: number;
  strokeWidth: number;
} {
  const minSide = Math.min(width, height);
  const fontSize = Math.max(18, Math.round(minSide * 0.017));
  return {
    fontSize,
    labelHeight: Math.round(fontSize * 1.45),
    strokeWidth: Math.max(3, Math.round(minSide * 0.004))
  };
}

function colorForType(type: UiElement["type"]): { stroke: string; fill: string } {
  switch (type) {
    case "text":
      return { stroke: "#38bdf8", fill: "rgba(56,189,248,0.035)" };
    case "card":
    case "list_item":
      return { stroke: "#facc15", fill: "rgba(250,204,21,0.03)" };
    case "button":
    case "nav":
      return { stroke: "#34d399", fill: "rgba(52,211,153,0.035)" };
    case "icon":
      return { stroke: "#f472b6", fill: "rgba(244,114,182,0.04)" };
    case "chart":
      return { stroke: "#a78bfa", fill: "rgba(167,139,250,0.035)" };
    case "image":
      return { stroke: "#fb923c", fill: "rgba(251,146,60,0.035)" };
    case "unknown":
      return { stroke: "#e5e7eb", fill: "rgba(229,231,235,0.025)" };
  }
}

function shortLabel(entry: OverlayEntry): string {
  const label = entry.element.text || entry.element.label;
  return `${entry.overlayId} ${entry.element.type} ${label}`.slice(0, 46);
}

function svgForEntries(width: number, height: number, entries: OverlayEntry[]): Buffer {
  const style = overlayStyle(width, height);
  const rects = entries.map(entry => {
    const box = clampBox(entry.element.box, width, height);
    const colors = colorForType(entry.element.type);
    const label = escapeXml(shortLabel(entry));
    const estimatedLabelWidth = Math.max(80, label.length * style.fontSize * 0.58 + 12);
    const labelWidth = Math.min(width, estimatedLabelWidth);
    const labelX = Math.max(0, Math.min(box.x, width - labelWidth));
    const labelY = Math.max(style.labelHeight, box.y - 4);
    return `
      <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="${style.strokeWidth}" vector-effect="non-scaling-stroke"/>
      <rect x="${labelX}" y="${labelY - style.labelHeight}" width="${labelWidth}" height="${style.labelHeight}" fill="rgba(0,0,0,0.82)" rx="4"/>
      <text x="${labelX + 6}" y="${labelY - Math.round(style.fontSize * 0.32)}" fill="${colors.stroke}" font-family="Arial, sans-serif" font-size="${style.fontSize}" font-weight="700">${label}</text>`;
  }).join("\n");

  return Buffer.from(`
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      ${rects}
    </svg>
  `);
}

function entriesFor(prefix: "E" | "P" | "A", elements: UiElement[]): OverlayEntry[] {
  return elements.map((element, index) => ({
    overlayId: `${prefix}${String(index + 1).padStart(3, "0")}`,
    element
  }));
}

async function writeOverlay(baseImagePath: string, outPath: string, entries: OverlayEntry[]): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const metadata = await sharp(baseImagePath).metadata();
  const width = metadata.width ?? 1;
  const height = metadata.height ?? 1;
  await sharp(baseImagePath)
    .composite([{ input: svgForEntries(width, height, entries), blend: "over" }])
    .png()
    .toFile(outPath);
}

function legendEntries(entries: OverlayEntry[], source: "locator" | "projected" | "independent") {
  return entries.map(entry => ({
    overlayId: entry.overlayId,
    elementId: entry.element.id,
    label: entry.element.label,
    type: entry.element.type,
    queryId: entry.element.queryId,
    source,
    box: entry.element.box
  }));
}

export async function writeLocatorOverlays(input: LocatorOverlayInput): Promise<UiArtifact[]> {
  if (input.expectedElements.length === 0 && input.actualElements.length === 0) return [];

  const expectedEntries = entriesFor("E", input.expectedElements);
  const actualEntries = entriesFor(input.actualMode === "projected" ? "P" : "A", input.actualElements);
  const expectedOverlayPath = path.join(input.artifactDir, "locator-expected-overlay.png");
  const actualOverlayPath = path.join(
    input.artifactDir,
    input.actualMode === "projected" ? "locator-actual-projected-overlay.png" : "locator-actual-overlay.png"
  );
  const legendPath = path.join(input.artifactDir, "locator-overlay-legend.json");

  await writeOverlay(input.expectedImagePath, expectedOverlayPath, expectedEntries);
  await writeOverlay(input.actualImagePath, actualOverlayPath, actualEntries);
  await fs.writeFile(legendPath, `${JSON.stringify({
    expected: legendEntries(expectedEntries, "locator"),
    actual: legendEntries(actualEntries, input.actualMode)
  }, null, 2)}\n`, "utf8");

  return [
    { role: "locator_expected_overlay", path: expectedOverlayPath },
    { role: "locator_actual_overlay", path: actualOverlayPath },
    { role: "locator_overlay_legend", path: legendPath }
  ];
}
