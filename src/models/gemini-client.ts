import {
  parseVisionJsonContent,
  withStructuredRetry,
  type VisionJsonCaller
} from "./vision-json.js";

const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";

function stripDataUrl(image: string): string {
  const comma = image.indexOf(",");
  return image.startsWith("data:") && comma >= 0 ? image.slice(comma + 1) : image;
}

function normalizeModelPath(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function toGeminiResponseSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiResponseSchema);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "additionalProperties")
      .map(([key, child]) => [key, toGeminiResponseSchema(child)])
  );
}

function makeGeminiSingleCaller(
  apiKey?: string,
  model = GEMINI_DEFAULT_MODEL,
  baseUrl = GEMINI_DEFAULT_BASE_URL
): VisionJsonCaller {
  const resolvedApiKey = apiKey?.trim() || process.env["GEMINI_API_KEY"]?.trim() || "";
  const endpoint = baseUrl.replace(/\/$/, "");
  const modelPath = normalizeModelPath(model);

  return async req => {
    const parts: Array<
      | { text: string }
      | { inline_data: { mime_type: string; data: string } }
    > = [{ text: req.prompt }];

    for (const image of req.images) {
      parts.push({ inline_data: { mime_type: "image/png", data: stripDataUrl(image) } });
    }

    const body: Record<string, unknown> = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0,
        max_output_tokens: req.maxOutputTokens ?? 2048,
        response_mime_type: "application/json",
        ...(req.jsonMode === "parser_only" || req.jsonMode === "json_object"
          ? {}
          : { response_schema: toGeminiResponseSchema(req.jsonSchema.schema) })
      }
    };

    let response: Response;
    try {
      response = await fetch(`${endpoint}/${modelPath}:generateContent?key=${encodeURIComponent(resolvedApiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs)
      });
    } catch (error) {
      throw new Error(`Gemini request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Gemini HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error("Gemini returned a non-JSON response");
    }

    const completion = json as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const rawContent = completion.candidates?.[0]?.content?.parts?.map(part => part.text ?? "").join("") ?? "";
    const finishReason = completion.candidates?.[0]?.finishReason;
    const parsed = parseVisionJsonContent("gemini", rawContent, req.jsonSchema.schema, true, finishReason);
    const usage = completion.usageMetadata === undefined ? undefined : {
      ...(completion.usageMetadata.promptTokenCount !== undefined
        ? { prompt_tokens: completion.usageMetadata.promptTokenCount }
        : {}),
      ...(completion.usageMetadata.candidatesTokenCount !== undefined
        ? { completion_tokens: completion.usageMetadata.candidatesTokenCount }
        : {})
    };

    return {
      parsed,
      rawContent,
      model,
      provider: "gemini",
      ...(usage !== undefined ? { usage } : {}),
      ttftMs: null,
      ...(finishReason !== undefined ? { finishReason } : {})
    };
  };
}

export function makeGeminiVisionCaller(
  apiKey?: string,
  model = GEMINI_DEFAULT_MODEL,
  baseUrl = GEMINI_DEFAULT_BASE_URL
): VisionJsonCaller {
  return withStructuredRetry(makeGeminiSingleCaller(apiKey, model, baseUrl));
}
