import sharp from "sharp";
import { callOpenRouterVisionJson } from "./openrouter-client.js";
import type { ModelEntry } from "./model-registry.js";

export interface ProbeResult {
  role: string;
  provider: string;
  model: string;
  status: "pass" | "fail" | "not_checked";
  checkedAt: string;
  detail?: string;
}

async function makeBluePng64(): Promise<string> {
  const buf = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 255 } }
  }).png().toBuffer();
  return buf.toString("base64");
}

async function makeRedRectPng100(): Promise<string> {
  const bg = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 255, b: 255 } }
  }).png().toBuffer();
  const rect = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 255, g: 0, b: 0 } }
  }).png().toBuffer();
  const buf = await sharp(bg)
    .composite([{ input: rect, left: 30, top: 30 }])
    .png()
    .toBuffer();
  return buf.toString("base64");
}

export async function probeOpenRouterModel(entry: ModelEntry, apiKey: string): Promise<ProbeResult> {
  if (!apiKey) {
    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "not_checked",
      checkedAt: new Date().toISOString(),
      detail: "No API key provided"
    };
  }

  const blueBase64 = await makeBluePng64();
  const redBase64 = await makeRedRectPng100();

  const schema = {
    name: "probe_result",
    schema: {
      type: "object",
      properties: {
        dominantColor: { type: "string" },
        hasRedRect: { type: "boolean" }
      },
      required: ["dominantColor", "hasRedRect"],
      additionalProperties: false
    }
  };

  try {
    const result = await callOpenRouterVisionJson({
      apiKey,
      model: entry.model,
      prompt: "The first image is a solid color. The second image has a colored rectangle on a white background. Return JSON: dominantColor (color name of first image) and hasRedRect (true if second image has a red rectangle).",
      images: [`data:image/png;base64,${blueBase64}`, `data:image/png;base64,${redBase64}`],
      jsonSchema: schema,
      timeoutMs: 30000
    });

    const parsed = result.parsed as { dominantColor?: string; hasRedRect?: boolean };
    const colorOk = typeof parsed.dominantColor === "string" && /blue/i.test(parsed.dominantColor);
    const rectOk = parsed.hasRedRect === true;

    if (colorOk && rectOk) {
      return {
        role: entry.role,
        provider: entry.provider,
        model: entry.model,
        status: "pass",
        checkedAt: new Date().toISOString()
      };
    }

    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "fail",
      checkedAt: new Date().toISOString(),
      detail: `Unexpected probe result: ${JSON.stringify(parsed)}`
    };
  } catch (err) {
    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "fail",
      checkedAt: new Date().toISOString(),
      detail: err instanceof Error ? err.message : String(err)
    };
  }
}

export async function probeNvidiaModel(entry: ModelEntry): Promise<ProbeResult> {
  const baseUrl = process.env["NVIDIA_VLM_BASE_URL"];
  const apiKey = process.env["NVIDIA_API_KEY"];

  if (!baseUrl || !apiKey) {
    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "not_checked",
      checkedAt: new Date().toISOString(),
      detail: "NVIDIA_VLM_BASE_URL or NVIDIA_API_KEY not set"
    };
  }

  const { callNvidiaVisionJson } = await import("./nvidia-client.js");
  const blueBase64 = await makeBluePng64();

  try {
    const result = await callNvidiaVisionJson({
      apiKey,
      model: entry.model,
      prompt: "What is the dominant color? Return JSON: {\"dominantColor\":\"<color>\"}",
      images: [`data:image/png;base64,${blueBase64}`],
      jsonSchema: { name: "probe", schema: { type: "object", properties: { dominantColor: { type: "string" } }, required: ["dominantColor"], additionalProperties: false } },
      timeoutMs: 30000
    });

    const parsed = result.parsed as { dominantColor?: string };
    if (typeof parsed.dominantColor === "string" && /blue/i.test(parsed.dominantColor)) {
      return { role: entry.role, provider: entry.provider, model: entry.model, status: "pass", checkedAt: new Date().toISOString() };
    }
    return { role: entry.role, provider: entry.provider, model: entry.model, status: "fail", checkedAt: new Date().toISOString(), detail: `Unexpected: ${JSON.stringify(parsed)}` };
  } catch (err) {
    return { role: entry.role, provider: entry.provider, model: entry.model, status: "fail", checkedAt: new Date().toISOString(), detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function probeRequiredModels(
  entries: ModelEntry[],
  openRouterApiKey: string
): Promise<ProbeResult[]> {
  return Promise.all(
    entries.map(e => {
      if (e.provider === "nvidia") return probeNvidiaModel(e);
      return probeOpenRouterModel(e, openRouterApiKey);
    })
  );
}
