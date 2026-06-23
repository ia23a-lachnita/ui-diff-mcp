import {
  parseVisionJsonContent,
  withStructuredRetry,
  type VisionJsonCaller
} from "./vision-json.js";

const OPENCODE_DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";
const OPENCODE_DEFAULT_MODEL = "mimo-v2.5-free";

function makeOpenCodeSingleCaller(
  apiKey?: string,
  model = OPENCODE_DEFAULT_MODEL,
  baseUrl = OPENCODE_DEFAULT_BASE_URL
): VisionJsonCaller {
  const resolvedApiKey = apiKey?.trim() || process.env["OPENCODE_API_KEY"]?.trim() || "public";
  const endpoint = baseUrl.replace(/\/$/, "");

  return async req => {
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = [{ type: "text", text: req.prompt }];

    for (const image of req.images) {
      content.push({
        type: "image_url",
        image_url: { url: image.startsWith("data:") ? image : `data:image/png;base64,${image}` }
      });
    }

    const jsonMode = req.jsonMode ?? "json_schema";
    const responseFormat = jsonMode === "parser_only"
      ? undefined
      : jsonMode === "json_object"
        ? { type: "json_object" as const }
        : {
            type: "json_schema" as const,
            json_schema: {
              name: req.jsonSchema.name,
              strict: true,
              schema: req.jsonSchema.schema
            }
          };

    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content }],
      temperature: 0,
      stream: false,
      max_tokens: req.maxOutputTokens ?? 2048
    };
    if (responseFormat !== undefined) body["response_format"] = responseFormat;

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
      throw new Error(`OpenCode request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenCode HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error("OpenCode returned a non-JSON response");
    }

    const completion = json as {
      model?: string;
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const rawContent = completion.choices?.[0]?.message?.content ?? "";
    const finishReason = completion.choices?.[0]?.finish_reason;
    const parsed = parseVisionJsonContent(
      "opencode",
      rawContent,
      req.jsonSchema.schema,
      true,
      finishReason
    );

    return {
      parsed,
      rawContent,
      model: completion.model ?? model,
      provider: "opencode",
      ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
      ttftMs: null,
      ...(finishReason !== undefined ? { finishReason } : {})
    };
  };
}

export function makeOpenCodeVisionCaller(
  apiKey?: string,
  model = OPENCODE_DEFAULT_MODEL,
  baseUrl = OPENCODE_DEFAULT_BASE_URL
): VisionJsonCaller {
  return withStructuredRetry(makeOpenCodeSingleCaller(apiKey, model, baseUrl));
}
