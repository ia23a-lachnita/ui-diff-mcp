import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { makeGeminiVisionCaller } from "../../src/models/gemini-client.js";
import { probeRequiredModels } from "../../src/models/probes.js";
import { resolveVisionProviderConfig } from "../../src/models/provider-config.js";
import type { ModelEntry } from "../../src/models/model-registry.js";

const liveEnabled = process.env["RUN_GEMINI_LIVE"] === "1";
const config = resolveVisionProviderConfig(process.env);
const model = "gemini-3.5-flash";

async function blueImageDataUrl(): Promise<string> {
  const image = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 255 } }
  }).png().toBuffer();
  return `data:image/png;base64,${image.toString("base64")}`;
}

describe.skipIf(!liveEnabled)("Gemini direct visual route", () => {
  test("Gemini 3.5 Flash accepts a real image and returns locally validated structured JSON", async () => {
    expect(config.geminiApiKey, "GEMINI_API_KEY must be set when RUN_GEMINI_LIVE=1").toBeTruthy();
    const caller = makeGeminiVisionCaller(config.geminiApiKey, model, config.geminiBaseUrl);
    const startedAt = Date.now();
    const result = await caller({
      prompt: "Identify the single solid color in the image.",
      images: [await blueImageDataUrl()],
      jsonSchema: {
        name: "gemini_color_probe",
        schema: {
          type: "object",
          properties: { color: { type: "string", enum: ["red", "green", "blue"] } },
          required: ["color"],
          additionalProperties: false
        }
      },
      timeoutMs: 120_000,
      maxOutputTokens: 256
    });

    expect(result.parsed).toEqual({ color: "blue" });
    expect(result.provider).toBe("gemini");
    console.info(JSON.stringify({
      gate: "gemini-one-image",
      route: model,
      providerModel: result.model,
      durationMs: Date.now() - startedAt,
      finishReason: result.finishReason ?? null,
      usage: result.usage ?? null
    }));
  }, 180_000);

  test("one five-image Gemini call satisfies auditor, reviewer, and recovery probes", async () => {
    expect(config.geminiApiKey, "GEMINI_API_KEY must be set when RUN_GEMINI_LIVE=1").toBeTruthy();
    const entries: ModelEntry[] = [
      { role: "auditor", provider: "gemini", model, costClass: "free", probeTtlMs: 900_000, required: false },
      { role: "reviewer", provider: "gemini", model, costClass: "free", probeTtlMs: 900_000, required: false },
      { role: "target_recovery", provider: "gemini", model, costClass: "free", probeTtlMs: 900_000, required: false }
    ];
    const startedAt = Date.now();
    const results = await probeRequiredModels(entries, config);

    expect(results).toHaveLength(3);
    expect(results.every(result => result.status === "pass")).toBe(true);
    expect(results.every(result => result.schemaValid === true && result.contentAccurate === true)).toBe(true);
    expect(results.every(result => result.maxImagesSupported === 5)).toBe(true);
    console.info(JSON.stringify({
      gate: "gemini-role-probes",
      route: model,
      durationMs: Date.now() - startedAt,
      results: results.map(result => ({
        role: result.role,
        status: result.status,
        maxImagesSupported: result.maxImagesSupported,
        ttftMs: result.ttftMs ?? null
      }))
    }));
  }, 180_000);
});
