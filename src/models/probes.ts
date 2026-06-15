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
  maxImagesSupported?: number;
}

const PROBE_COLORS = [
  { r: 0, g: 0, b: 255 },    // blue — always first so hasBlueImage check passes
  { r: 255, g: 0, b: 0 },    // red
  { r: 0, g: 200, b: 0 },    // green
  { r: 255, g: 200, b: 0 },  // yellow
  { r: 128, g: 128, b: 128 } // gray
];

async function makeProbeImageSet(count: number): Promise<string[]> {
  const images: string[] = [];
  for (let i = 0; i < count; i++) {
    const color = PROBE_COLORS[i % PROBE_COLORS.length]!;
    const buf = await sharp({
      create: { width: 64, height: 64, channels: 3, background: color }
    }).png().toBuffer();
    images.push(`data:image/png;base64,${buf.toString("base64")}`);
  }
  return images;
}

const MULTI_IMAGE_PROBE_SCHEMA = {
  name: "multi_image_probe",
  schema: {
    type: "object",
    properties: {
      imageCount: { type: "integer" },
      hasBlueImage: { type: "boolean" }
    },
    required: ["imageCount", "hasBlueImage"],
    additionalProperties: false
  }
};

const MULTI_IMAGE_PROBE_PROMPT =
  "Count the total number of images provided. Also identify if any image has a predominantly blue background. " +
  "Return JSON with two fields: imageCount (integer count of images) and hasBlueImage (boolean, true if any image is predominantly blue).";

async function runRoleProbe(
  entry: ModelEntry,
  role: string,
  imageCount: number,
  openRouterApiKey?: string,
  nvidiaApiKey?: string,
  nvidiaBaseUrl?: string
): Promise<ProbeResult> {
  const key = entry.provider === "nvidia"
    ? (nvidiaApiKey ?? process.env["NVIDIA_API_KEY"] ?? "")
    : (openRouterApiKey ?? "");

  if (!key) {
    return {
      role,
      provider: entry.provider,
      model: entry.model,
      status: "not_checked",
      detail: entry.provider === "nvidia" ? "NVIDIA_API_KEY not set" : "No OpenRouter API key provided",
      schemaValid: null,
      contentAccurate: null
    };
  }

  const images = await makeProbeImageSet(imageCount);
  const caller = entry.provider === "nvidia"
    ? makeNvidiaVisionCaller(key, entry.model, nvidiaBaseUrl)
    : makeOpenRouterVisionCaller(key, entry.model);

  try {
    const result = await caller({
      prompt: MULTI_IMAGE_PROBE_PROMPT,
      images,
      jsonSchema: MULTI_IMAGE_PROBE_SCHEMA,
      timeoutMs: 30000
    });

    const parsed = result.parsed as { imageCount?: unknown; hasBlueImage?: unknown };
    const schemaValid = typeof parsed === "object" && parsed !== null &&
      "imageCount" in parsed && "hasBlueImage" in parsed;
    const contentAccurate = schemaValid &&
      typeof parsed.imageCount === "number" &&
      Math.round(parsed.imageCount) === imageCount &&
      parsed.hasBlueImage === true;

    if (schemaValid && contentAccurate) {
      return {
        role,
        provider: entry.provider,
        model: entry.model,
        status: "pass",
        jsonSchemaMode: "json_schema",
        ttftMs: result.ttftMs ?? null,
        schemaValid,
        contentAccurate,
        maxImagesSupported: imageCount,
        checkedAt: new Date().toISOString()
      };
    }

    return {
      role,
      provider: entry.provider,
      model: entry.model,
      status: "fail",
      detail: `Probe failed. schemaValid=${schemaValid}, contentAccurate=${contentAccurate}. Parsed: ${JSON.stringify(parsed).slice(0, 200)}`,
      jsonSchemaMode: "json_schema",
      ttftMs: result.ttftMs ?? null,
      schemaValid,
      contentAccurate,
      checkedAt: new Date().toISOString()
    };
  } catch (err) {
    return {
      role,
      provider: entry.provider,
      model: entry.model,
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
      ttftMs: null,
      schemaValid: false,
      contentAccurate: false,
      checkedAt: new Date().toISOString()
    };
  }
}

export async function probeAuditCapability(
  entry: ModelEntry,
  openRouterApiKey?: string,
  nvidiaApiKey?: string,
  nvidiaBaseUrl?: string
): Promise<ProbeResult> {
  // Audit sends 5 images: expected crop, actual crop, directional overlay, pixel mask, context crop
  return runRoleProbe(entry, "auditor", 5, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);
}

export async function probeReviewerCapability(
  entry: ModelEntry,
  openRouterApiKey?: string,
  nvidiaApiKey?: string,
  nvidiaBaseUrl?: string
): Promise<ProbeResult> {
  // Reviewer fixed 5-image max: expected crop, actual crop, directional overlay, pixel mask, context crop
  return runRoleProbe(entry, "reviewer", 5, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);
}

export async function probeRecoveryCapability(
  entry: ModelEntry,
  openRouterApiKey?: string,
  nvidiaApiKey?: string,
  nvidiaBaseUrl?: string
): Promise<ProbeResult> {
  // Recovery sends 4 images: expected crop, actual crop, overlay, mask
  return runRoleProbe(entry, "target_recovery", 4, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);
}

// Legacy single-probe functions kept for backward compatibility with direct callers
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
  return 'dominantColor' in p && 'hasRedRect' in p;
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

    const schemaValid = checkSchemaValidity(result.parsed);
    const contentAccurate = schemaValid && checkContentAccuracy(result.parsed);

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
      schemaValid: false,
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

    const schemaValid = checkSchemaValidity(result.parsed);
    const contentAccurate = schemaValid && checkContentAccuracy(result.parsed);

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
      schemaValid: false,
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
      if (e.role === "auditor" || e.role === "fast_auditor") {
        return probeAuditCapability(e, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);
      }
      if (e.role === "reviewer" || e.role === "escalation") {
        return probeReviewerCapability(e, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);
      }
      if (e.role === "target_recovery") {
        return probeRecoveryCapability(e, openRouterApiKey, nvidiaApiKey, nvidiaBaseUrl);
      }
      // fallback for unrecognized roles
      if (e.provider === "nvidia") return probeNvidiaModel(e, nvidiaApiKey, nvidiaBaseUrl);
      return probeOpenRouterModel(e, openRouterApiKey);
    })
  );
}
