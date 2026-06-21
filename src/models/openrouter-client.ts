export interface VisionJsonRequest {
  apiKey: string;
  model: string;
  prompt: string;
  images: string[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
  timeoutMs: number;
}

export interface VisionJsonResponse {
  parsed: unknown;
  rawContent: string;
  model: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface OpenRouterMessage {
  role: "user" | "assistant" | "system";
  content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
}

export async function callOpenRouterVisionJson(
  req: VisionJsonRequest
): Promise<VisionJsonResponse> {
  const content: OpenRouterMessage["content"] = [
    { type: "text", text: req.prompt }
  ];

  for (const imgData of req.images) {
    const url = imgData.startsWith("data:") ? imgData : `data:image/png;base64,${imgData}`;
    content.push({ type: "image_url", image_url: { url } });
  }

  const body = {
    model: req.model,
    messages: [{ role: "user" as const, content }],
    max_tokens: 2048,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: req.jsonSchema.name,
        strict: true,
        schema: req.jsonSchema.schema
      }
    }
  };

  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${req.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(req.timeoutMs)
    });
  } catch (err) {
    throw new Error(`OpenRouter request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenRouter HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new Error("OpenRouter returned non-JSON response");
  }

  const completion = json as {
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  };

  const rawContent = completion.choices?.[0]?.message?.content ?? "";
  const parsed = parseVisionJsonContent("openrouter", rawContent, req.jsonSchema.schema, true, completion.choices?.[0]?.finish_reason);

  return {
    parsed,
    rawContent,
    model: completion.model ?? req.model,
    ...(completion.usage !== undefined ? { usage: completion.usage } : {})
  };
}
import { parseVisionJsonContent } from "./vision-json.js";
