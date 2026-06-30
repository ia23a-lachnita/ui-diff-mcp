import {
  parseVisionJsonContent,
  withStructuredRetry,
  type VisionJsonCaller
} from "./vision-json.js";

const MISTRAL_DEFAULT_BASE_URL = "https://api.mistral.ai/v1";
const MISTRAL_DEFAULT_MODEL = "mistral-large-2512";

function toDataUrl(image: string): string {
  return image.startsWith("data:") ? image : `data:image/png;base64,${image}`;
}

function makeMistralSingleCaller(
  apiKey?: string,
  model = MISTRAL_DEFAULT_MODEL,
  baseUrl = MISTRAL_DEFAULT_BASE_URL
): VisionJsonCaller {
  const resolvedApiKey = apiKey?.trim() || process.env["MISTRAL_API_KEY"]?.trim() || "";
  const endpoint = baseUrl.replace(/\/$/, "");

  return async req => {
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: string }
    > = [{ type: "text", text: req.prompt }];

    for (const image of req.images) {
      content.push({ type: "image_url", image_url: toDataUrl(image) });
    }

    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content }],
      temperature: 0,
      max_tokens: req.maxOutputTokens ?? 2048
    };
    if (req.jsonMode !== "parser_only") {
      body["response_format"] = { type: "json_object" };
    }

    let response: Response;
    try {
      response = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${resolvedApiKey}`
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs)
      });
    } catch (error) {
      throw new Error(`Mistral request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Mistral HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error("Mistral returned a non-JSON response");
    }

    const completion = json as {
      model?: string;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const rawContent = completion.choices?.[0]?.message?.content ?? "";
    const finishReason = completion.choices?.[0]?.finish_reason;
    const parsed = parseVisionJsonContent("mistral", rawContent, req.jsonSchema.schema, true, finishReason);

    return {
      parsed,
      rawContent,
      model: completion.model ?? model,
      provider: "mistral",
      ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
      ttftMs: null,
      ...(finishReason !== undefined ? { finishReason } : {})
    };
  };
}

export function makeMistralVisionCaller(
  apiKey?: string,
  model = MISTRAL_DEFAULT_MODEL,
  baseUrl = MISTRAL_DEFAULT_BASE_URL
): VisionJsonCaller {
  return withStructuredRetry(makeMistralSingleCaller(apiKey, model, baseUrl));
}
