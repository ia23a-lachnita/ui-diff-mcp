import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { locateUiElements } from "../../src/locator/locateanything-client.js";
import { writeTwoButtonFixture } from "../../src/testing/fixture-images.js";

const liveEnabled = process.env["RUN_UI_DIFF_LIVE"] === "1";

let tmpDir = "";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-live-locator-"));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe.skipIf(!liveEnabled)("live LocateAnything sidecar", () => {
  test("returns valid in-bounds UI element boxes for a generated fixture", async () => {
    const endpoint = process.env["LOCATEANYTHING_SIDECAR_URL"];
    expect(endpoint, "LOCATEANYTHING_SIDECAR_URL must be set when RUN_UI_DIFF_LIVE=1").toBeTruthy();

    const { expected } = await writeTwoButtonFixture(tmpDir, "expected.png", "actual.png");
    const response = await locateUiElements({
      endpoint: endpoint!,
      request: {
        imagePath: expected,
        queries: [
          {
            id: "ui_elements",
            prompt: "Detect all text and visible mobile UI elements in box format."
          }
        ],
        generationMode: "hybrid",
        maxBoxesPerQuery: 50
      },
      timeoutMs: 300000
    });

    expect(response.model).toContain("LocateAnything");
    expect(response.image.width).toBe(200);
    expect(response.image.height).toBe(400);
    expect(response.elements.length).toBeGreaterThan(0);
    for (const element of response.elements) {
      expect(element.box.x).toBeGreaterThanOrEqual(0);
      expect(element.box.y).toBeGreaterThanOrEqual(0);
      expect(element.box.x + element.box.width).toBeLessThanOrEqual(response.image.width);
      expect(element.box.y + element.box.height).toBeLessThanOrEqual(response.image.height);
      expect(element.rawBox1000).toHaveLength(4);
    }
  }, 360000);
});
