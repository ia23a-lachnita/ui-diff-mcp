import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeLocatorOverlays } from "../../src/report/locator-overlays.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";
import type { UiElement } from "../../src/schemas/core.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-locator-overlays-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function element(id: string, label: string, box: UiElement["box"], type: UiElement["type"] = "text"): UiElement {
  return {
    id,
    label,
    type,
    queryId: "text_labels",
    box,
    normalizedBox: {
      x: box.x / 200,
      y: box.y / 400,
      width: box.width / 200,
      height: box.height / 400
    },
    confidence: 0.9,
    source: "locator",
    childIds: []
  };
}

async function nonBackgroundPixelCount(imagePath: string, bg: { r: number; g: number; b: number }): Promise<number> {
  const { data } = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let changed = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== bg.r || data[i + 1] !== bg.g || data[i + 2] !== bg.b) changed++;
  }
  return changed;
}

describe("writeLocatorOverlays", () => {
  it("writes expected and projected-actual overlays plus a consolidated legend", async () => {
    const expectedPath = await writeSolidPng(tmpDir, "expected.png", 200, 400, 20, 20, 20);
    const actualPath = await writeSolidPng(tmpDir, "actual.png", 200, 400, 20, 20, 20);

    const artifacts = await writeLocatorOverlays({
      expectedImagePath: expectedPath,
      actualImagePath: actualPath,
      artifactDir: tmpDir,
      expectedElements: [
        element("expected-1", "Today & kcal", { x: 20, y: 40, width: 80, height: 30 }),
        element("expected-2", "right edge label", { x: 170, y: 90, width: 25, height: 30 }, "icon")
      ],
      actualElements: [
        { ...element("actual-1", "Today & kcal", { x: 20, y: 40, width: 80, height: 30 }), source: "projected" },
        { ...element("actual-2", "right edge label", { x: 170, y: 90, width: 25, height: 30 }, "icon"), source: "projected" }
      ],
      actualMode: "projected"
    });

    expect(artifacts.map(artifact => artifact.role)).toEqual([
      "locator_expected_overlay",
      "locator_actual_overlay",
      "locator_overlay_legend"
    ]);

    for (const artifact of artifacts) {
      await expect(fs.access(artifact.path)).resolves.toBeUndefined();
    }

    const expectedChanged = await nonBackgroundPixelCount(artifacts[0]!.path, { r: 20, g: 20, b: 20 });
    const actualChanged = await nonBackgroundPixelCount(artifacts[1]!.path, { r: 20, g: 20, b: 20 });
    expect(expectedChanged).toBeGreaterThan(0);
    expect(actualChanged).toBeGreaterThan(0);

    const legend = JSON.parse(await fs.readFile(artifacts[2]!.path, "utf8")) as {
      expected: Array<{ overlayId: string; elementId: string; label: string }>;
      actual: Array<{ overlayId: string; elementId: string; source: string }>;
    };
    expect(legend.expected).toHaveLength(2);
    expect(legend.actual).toHaveLength(2);
    expect(legend.expected[0]).toMatchObject({ overlayId: "E001", elementId: "expected-1", label: "Today & kcal" });
    expect(legend.actual[0]).toMatchObject({ overlayId: "P001", elementId: "actual-1", source: "projected" });
  });
});
