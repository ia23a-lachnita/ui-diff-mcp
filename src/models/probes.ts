import sharp from "sharp";
import { makeOpenRouterVisionCaller, makeNvidiaVisionCaller } from "./vision-json.js";
import type { ModelEntry } from "./model-registry.js";

export interface ProbeResult {
  role: string;
  provider: string;
  model: string;
  status: "pass" | "fail" | "not_checked";
  checkedAt: string;
  detail?: string;
  jsonSchemaMode?: "json_schema" | "json_object" | "parser_only";
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

const PROBE_SCHEMA = {
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

const PROBE_PROMPT =
  "The first image is a solid color. The second image has a colored rectangle on a white background. " +
  "Return JSON: dominantColor (color name of first image) and hasRedRect (true if second image has a red rectangle).";

function isProbePass(parsed: unknown): boolean {
  const p = parsed as { dominantColor?: string; hasRedRect?: boolean };
  return typeof p.dominantColor === "string" && /blue/i.test(p.dominantColor) && p.hasRedRect === true;
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
  const caller = makeOpenRouterVisionCaller(apiKey, entry.model);

  try {
    const result = await caller({
      prompt: PROBE_PROMPT,
      images: [`data:image/png;base64,${blueBase64}`, `data:image/png;base64,${redBase64}`],
      jsonSchema: PROBE_SCHEMA,
      timeoutMs: 30000
    });

    if (isProbePass(result.parsed)) {
      return {
        role: entry.role,
        provider: entry.provider,
        model: entry.model,
        status: "pass",
        checkedAt: new Date().toISOString(),
        jsonSchemaMode: "json_schema"
      };
    }

    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "fail",
      checkedAt: new Date().toISOString(),
      detail: `Unexpected probe result: ${JSON.stringify(result.parsed)}`
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

export async function probeNvidiaModel(
  entry: ModelEntry,
  apiKey?: string,
  baseUrl?: string
): Promise<ProbeResult> {
  const key = apiKey ?? process.env["NVIDIA_API_KEY"] ?? "";
  if (!key) {
    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "not_checked",
      checkedAt: new Date().toISOString(),
      detail: "NVIDIA_API_KEY not set"
    };
  }

  const blueBase64 = await makeBluePng64();
  const redBase64 = await makeRedRectPng100();
  const caller = makeNvidiaVisionCaller(key, entry.model, baseUrl);

  try {
    const result = await caller({
      prompt: PROBE_PROMPT,
      images: [`data:image/png;base64,${blueBase64}`, `data:image/png;base64,${redBase64}`],
      jsonSchema: PROBE_SCHEMA,
      timeoutMs: 30000
    });

    if (isProbePass(result.parsed)) {
      return {
        role: entry.role,
        provider: entry.provider,
        model: entry.model,
        status: "pass",
        checkedAt: new Date().toISOString(),
        jsonSchemaMode: "json_schema"
      };
    }

    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "fail",
      checkedAt: new Date().toISOString(),
      detail: `Unexpected probe result: ${JSON.stringify(result.parsed)}`,
      jsonSchemaMode: "json_schema"
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

export async function probeRequiredModels(
  entries: ModelEntry[],
  openRouterApiKey: string,
  nvidiaApiKey?: string,
  nvidiaBaseUrl?: string
): Promise<ProbeResult[]> {
  return Promise.all(
    entries.map(e => {
      if (e.provider === "nvidia") return probeNvidiaModel(e, nvidiaApiKey, nvidiaBaseUrl);
      return probeOpenRouterModel(e, openRouterApiKey);
    })
  );
}
