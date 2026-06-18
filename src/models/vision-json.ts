import type { ProviderFailureDiagnostic } from "../schemas/core.js";

export type VisionMode = "free" | "free_openrouter" | "free_nvidia" | "paid" | "deterministic_only";

export class ProviderJsonParseError extends Error {
  readonly diagnostic: ProviderFailureDiagnostic;

  constructor(provider: "openrouter" | "nvidia", diagnostic: ProviderFailureDiagnostic) {
    super(`${provider} response content is not valid JSON`);
    this.name = "ProviderJsonParseError";
    this.diagnostic = diagnostic;
  }
}

function buildInvalidJsonDiagnostic(rawContent: string, streamCompleted: boolean): ProviderFailureDiagnostic {
  const trimmed = rawContent.trim();
  return {
    kind: "invalid_json",
    rawContentLength: rawContent.length,
    firstChars: trimmed.slice(0, 300),
    lastChars: trimmed.slice(Math.max(0, trimmed.length - 300)),
    startsWithJson: trimmed.startsWith("{") || trimmed.startsWith("["),
    endsWithJson: trimmed.endsWith("}") || trimmed.endsWith("]"),
    streamCompleted
  };
}

// Some models (e.g. Gemma) wrap JSON in ```json ... ``` markdown code blocks.
// Strip the wrapper before parsing so those models don't fail schema probes.
function extractJsonFromMarkdown(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return m?.[1] !== undefined ? m[1].trim() : trimmed;
}

export interface VisionJsonRequest {
  prompt: string;
  images: string[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
  timeoutMs: number;
  jsonMode?: "json_schema" | "json_object" | "parser_only";
}

export interface VisionJsonResponse {
  parsed: unknown;
  rawContent: string;
  model: string;
  provider: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  ttftMs?: number | null;
}

export type VisionJsonCaller = (req: VisionJsonRequest) => Promise<VisionJsonResponse>;

export interface SelectedVisionModel {
  provider: "openrouter" | "nvidia";
  model: string;
  costClass: "free" | "paid";
  callVisionJson: VisionJsonCaller;
}

export function makeOpenRouterVisionCaller(apiKey: string, model: string): VisionJsonCaller {
  return async (req) => {
    const requestStartTime = Date.now();
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = [{ type: "text", text: req.prompt }];

    for (const imgData of req.images) {
      const url = imgData.startsWith("data:") ? imgData : `data:image/png;base64,${imgData}`;
      content.push({ type: "image_url", image_url: { url } });
    }

    const jsonMode = req.jsonMode ?? "json_schema";
    const responseFormat = jsonMode === "parser_only" ? undefined
      : jsonMode === "json_object" ? { type: "json_object" as const }
      : { type: "json_schema" as const, json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } };

    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user" as const, content }],
      stream: true,
    };
    if (responseFormat !== undefined) {
      body["response_format"] = responseFormat;
    }

    let response: Response;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "HTTP-Referer": "https://ui-diff.gemini.run", // Optional: identify your application
          "X-Title": "UI Diff MCP Benchmark" // Optional: identify your application
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

    if (!response.body) {
      throw new Error("OpenRouter streaming response body is empty.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let fullContent = "";
    let ttftMs: number | null = null;
    let completion: any = {}; // To accumulate the full completion object
    let streamCompleted = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        // OpenRouter's streaming format is SSE (Server-Sent Events)
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.substring(5).trim();
            if (data === '[DONE]') {
              continue;
            }
            try {
              const message = JSON.parse(data);
              // Accumulate completion details
              if (message.choices?.[0]?.delta?.content) {
                const contentDelta = message.choices[0].delta.content;
                if (ttftMs === null && contentDelta.length > 0) {
                  ttftMs = Date.now() - requestStartTime;
                }
                fullContent += contentDelta;
              }
              // OpenRouter usually sends usage info in the last chunk before DONE, or in an intermediate chunk
              if (message.usage) {
                completion.usage = message.usage;
              }
              if (message.model && !completion.model) {
                completion.model = message.model;
              }

            } catch (parseError) {
              console.warn("Error parsing OpenRouter stream chunk:", parseError);
            }
          }
        }
      }
      streamCompleted = true;
    } finally {
      reader.releaseLock();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonFromMarkdown(fullContent));
    } catch {
      throw new ProviderJsonParseError("openrouter", buildInvalidJsonDiagnostic(fullContent, streamCompleted));
    }

    return {
      parsed,
      rawContent: fullContent,
      model: completion.model ?? model,
      provider: "openrouter",
      ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
      ttftMs
    };
  };
}

const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

export function makeNvidiaVisionCaller(apiKey: string, model: string, baseUrl?: string): VisionJsonCaller {
  const endpoint = (baseUrl ?? NVIDIA_DEFAULT_BASE_URL).replace(/\/$/, "");
  return async (req) => {
    const requestStartTime = Date.now();
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = [{ type: "text", text: req.prompt }];

    for (const imgData of req.images) {
      const url = imgData.startsWith("data:") ? imgData : `data:image/png;base64,${imgData}`;
      content.push({ type: "image_url", image_url: { url } });
    }

    const jsonMode = req.jsonMode ?? "json_schema";
    const responseFormat = jsonMode === "parser_only" ? undefined
      : jsonMode === "json_object" ? { type: "json_object" as const }
      : { type: "json_schema" as const, json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema } };

    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user" as const, content }],
      stream: true,
    };
    if (responseFormat !== undefined) {
      body["response_format"] = responseFormat;
    }

    let response: Response;
    try {
      response = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "HTTP-Referer": "https://ui-diff.gemini.run", // Optional: identify your application
          "X-Title": "UI Diff MCP Benchmark" // Optional: identify your application
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(req.timeoutMs)
      });
    } catch (err) {
      throw new Error(`NVIDIA request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`NVIDIA HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    if (!response.body) {
      throw new Error("NVIDIA streaming response body is empty.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let fullContent = "";
    let ttftMs: number | null = null;
    let completion: any = {}; // To accumulate the full completion object
    let streamCompleted = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        // NVIDIA's streaming format is also typically SSE
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data:')) {
            const data = line.substring(5).trim();
            if (data === '[DONE]') {
              continue;
            }
            try {
              const message = JSON.parse(data);
              // Accumulate completion details
              if (message.choices?.[0]?.delta?.content) {
                const contentDelta = message.choices[0].delta.content;
                if (ttftMs === null && contentDelta.length > 0) {
                  ttftMs = Date.now() - requestStartTime;
                }
                fullContent += contentDelta;
              }
              // NVIDIA also sends usage info
              if (message.usage) {
                completion.usage = message.usage;
              }
              if (message.model && !completion.model) {
                completion.model = message.model;
              }
            } catch (parseError) {
              console.warn("Error parsing NVIDIA stream chunk:", parseError);
            }
          }
        }
      }
      streamCompleted = true;
    } finally {
      reader.releaseLock();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJsonFromMarkdown(fullContent));
    } catch {
      throw new ProviderJsonParseError("nvidia", buildInvalidJsonDiagnostic(fullContent, streamCompleted));
    }

    return {
      parsed,
      rawContent: fullContent,
      model: completion.model ?? model,
      provider: "nvidia",
      ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
      ttftMs
    };
  };
}
