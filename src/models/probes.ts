import sharp from "sharp";
import { makeOpenRouterVisionCaller, makeNvidiaVisionCaller } from "./vision-json.js";
import type { ModelEntry } from "./model-registry.js";
export interface ProbeResult {
  role: string;
  provider: string;
  model: string;
  status: "pass" | "fail" | "not_checked";
  checkedAt?: string;
  detail?: string;
  jsonSchemaMode?: "json_schema" | "json_object" | "parser_only";
  ttftMs?: number | null;
  schemaValid?: boolean | null;
  contentAccurate?: boolean | null;
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

function checkContentAccuracy(parsed: unknown): boolean {
  const p = parsed as { dominantColor?: string; hasRedRect?: boolean };
  return typeof p.dominantColor === "string" && /blue/i.test(p.dominantColor) && p.hasRedRect === true;
}

function checkSchemaValidity(parsed: unknown): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const p = parsed as { dominantColor?: string; hasRedRect?: boolean };
  // Manually check for required properties for simplicity, could use a validator library for complex schemas
  return 'dominantColor' in p && 'hasRedRect' in p;
}

function evaluateProbeResult(parsed: unknown): { schemaValid: boolean; contentAccurate: boolean } {
  const schemaValid = checkSchemaValidity(parsed);
  // Only check content accuracy if the schema is at least valid enough to parse
  const contentAccurate = schemaValid && checkContentAccuracy(parsed);
  return { schemaValid, contentAccurate };
}

export async function probeOpenRouterModel(entry: ModelEntry, apiKey: string): Promise<ProbeResult> {
  if (!apiKey) {
    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "not_checked",
      detail: "No API key provided",
      schemaValid: null,
      contentAccurate: null
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

    const { schemaValid, contentAccurate } = evaluateProbeResult(result.parsed);

    if (schemaValid && contentAccurate) {
      return {
        role: entry.role,
        provider: entry.provider,
        model: entry.model,
        status: "pass",
        jsonSchemaMode: "json_schema",
        ttftMs: result.ttftMs ?? null,
        schemaValid,
        contentAccurate
      };
    }

    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "fail",
      detail: `Probe evaluation failed. Schema valid: ${schemaValid}, Content accurate: ${contentAccurate}. Parsed: ${JSON.stringify(result.parsed)}`,
      jsonSchemaMode: "json_schema",
      ttftMs: result.ttftMs ?? null,
      schemaValid,
      contentAccurate
    };
  } catch (err) {
    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      ttftMs: null,
      schemaValid: false, // Assume schema is not valid if error occurs before evaluation
      contentAccurate: false
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
      detail: "NVIDIA_API_KEY not set",
      schemaValid: null,
      contentAccurate: null
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

    const { schemaValid, contentAccurate } = evaluateProbeResult(result.parsed);

    if (schemaValid && contentAccurate) {
      return {
        role: entry.role,
        provider: entry.provider,
        model: entry.model,
        status: "pass",
        jsonSchemaMode: "json_schema",
        ttftMs: result.ttftMs ?? null,
        schemaValid,
        contentAccurate
      };
    }

    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "fail",
      detail: `Probe evaluation failed. Schema valid: ${schemaValid}, Content accurate: ${contentAccurate}. Parsed: ${JSON.stringify(result.parsed)}`,
      jsonSchemaMode: "json_schema",
      ttftMs: result.ttftMs ?? null,
      schemaValid,
      contentAccurate
    };
  } catch (err) {
    return {
      role: entry.role,
      provider: entry.provider,
      model: entry.model,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      ttftMs: null,
      schemaValid: false, // Assume schema is not valid if error occurs before evaluation
      contentAccurate: false
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
