import type { ProviderFailureDiagnostic } from "../schemas/core.js";

export type VisionProvider = "openrouter" | "nvidia" | "opencode" | "gemini" | "mistral";
export type VisionMode =
  | "free"
  | "free_gemini"
  | "free_mistral"
  | "free_opencode"
  | "free_openrouter"
  | "free_nvidia"
  | "paid"
  | "deterministic_only";

export class ProviderJsonParseError extends Error {
  readonly diagnostic: ProviderFailureDiagnostic;

  constructor(provider: VisionProvider, diagnostic: ProviderFailureDiagnostic) {
    super(`${provider} structured response failed: ${diagnostic.kind}`);
    this.name = "ProviderJsonParseError";
    this.diagnostic = diagnostic;
  }
}

function buildContentDiagnostic(
  rawContent: string,
  streamCompleted: boolean,
  kind: ProviderFailureDiagnostic["kind"],
  finishReason?: string
): ProviderFailureDiagnostic {
  const trimmed = rawContent.trim();
  return {
    kind,
    rawContentLength: rawContent.length,
    firstChars: trimmed.slice(0, 300),
    lastChars: trimmed.slice(Math.max(0, trimmed.length - 300)),
    startsWithJson: trimmed.startsWith("{") || trimmed.startsWith("["),
    endsWithJson: trimmed.endsWith("}") || trimmed.endsWith("]"),
    streamCompleted,
    ...(finishReason !== undefined ? { finishReason } : {})
  };
}

// Some models (e.g. Gemma) wrap JSON in ```json ... ``` markdown code blocks.
// Strip the wrapper before parsing so those models don't fail schema probes.
function extractJsonFromMarkdown(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return m?.[1] !== undefined ? m[1].trim() : trimmed;
}

function schemaMatches(value: unknown, schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema["enum"]) && !(schema["enum"] as unknown[]).includes(value)) return false;
  const type = schema["type"];
  if (type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    const required = (schema["required"] ?? []) as string[];
    if (required.some(key => !(key in record))) return false;
    if (schema["additionalProperties"] === false && Object.keys(record).some(key => !(key in properties))) return false;
    return Object.entries(properties).every(([key, child]) => !(key in record) || schemaMatches(record[key], child));
  }
  if (type === "array") {
    if (!Array.isArray(value)) return false;
    const items = schema["items"] as Record<string, unknown> | undefined;
    return items === undefined || value.every(item => schemaMatches(item, items));
  }
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  return true;
}

export function parseVisionJsonContent(
  provider: VisionProvider,
  rawContent: string,
  schema: Record<string, unknown>,
  streamCompleted: boolean,
  finishReason?: string
): unknown {
  const normalized = extractJsonFromMarkdown(rawContent);
  if (normalized.length === 0) {
    throw new ProviderJsonParseError(provider, buildContentDiagnostic(rawContent, streamCompleted, "empty_content", finishReason));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    const startsWithJson = normalized.startsWith("{") || normalized.startsWith("[");
    const endsWithJson = normalized.endsWith("}") || normalized.endsWith("]");
    const stopReasonLower = finishReason?.toLowerCase();
    const providerStoppedAtLength =
      stopReasonLower === "length" ||
      stopReasonLower === "max_tokens" ||
      stopReasonLower === "max_output_tokens";
    throw new ProviderJsonParseError(
      provider,
      buildContentDiagnostic(rawContent, streamCompleted, startsWithJson && (!endsWithJson || providerStoppedAtLength) ? "truncated_json" : "invalid_json", finishReason)
    );
  }
  if (!schemaMatches(parsed, schema)) {
    throw new ProviderJsonParseError(provider, buildContentDiagnostic(rawContent, streamCompleted, "schema_invalid", finishReason));
  }
  return parsed;
}

export interface VisionJsonRequest {
  prompt: string;
  images: string[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
  timeoutMs: number;
  jsonMode?: "json_schema" | "json_object" | "parser_only";
  maxOutputTokens?: number;
}

export interface VisionJsonResponse {
  parsed: unknown;
  rawContent: string;
  model: string;
  provider: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; reasoning_tokens?: number };
  ttftMs?: number | null;
  finishReason?: string;
  retryDecision?: "same_route_compact_retry";
}

export type VisionJsonCaller = (req: VisionJsonRequest) => Promise<VisionJsonResponse>;

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

async function readStreamWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineMs: number,
  provider: VisionProvider
): Promise<StreamReadResult> {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  if (remainingMs === 0) {
    await reader.cancel("stream timeout").catch(() => undefined);
    throw new Error(`${provider} request failed: stream timeout`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<StreamReadResult>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${provider} request failed: stream timeout`));
        void reader.cancel("stream timeout").catch(() => undefined);
      }, remainingMs);
      reader.read().then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface SelectedVisionModel {
  provider: VisionProvider;
  model: string;
  costClass: "free" | "paid";
  callVisionJson: VisionJsonCaller;
}

function makeOpenRouterSingleCaller(apiKey: string, model: string): VisionJsonCaller {
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
      max_tokens: req.maxOutputTokens ?? 2048,
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
    const streamDeadlineMs = requestStartTime + req.timeoutMs;

    try {
      while (true) {
        const { value, done } = await readStreamWithDeadline(reader, streamDeadlineMs, "openrouter");
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
              if (message.choices?.[0]?.finish_reason) {
                completion.finishReason = message.choices[0].finish_reason;
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

    const parsed = parseVisionJsonContent("openrouter", fullContent, req.jsonSchema.schema, streamCompleted, completion.finishReason);

    return {
      parsed,
      rawContent: fullContent,
      model: completion.model ?? model,
      provider: "openrouter",
      ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
      ttftMs,
      ...(completion.finishReason !== undefined ? { finishReason: completion.finishReason } : {})
    };
  };
}

export function withStructuredRetry(single: VisionJsonCaller): VisionJsonCaller {
  return async req => {
    try {
      return await single(req);
    } catch (err) {
      if (!(err instanceof ProviderJsonParseError) || !["truncated_json", "schema_invalid"].includes(err.diagnostic.kind)) throw err;
      try {
        const retried = await single({
          ...req,
          prompt: `${req.prompt}\nReturn the smallest valid JSON object matching the schema. No prose.`,
          maxOutputTokens: Math.max(req.maxOutputTokens ?? 0, 4096)
        });
        return { ...retried, retryDecision: "same_route_compact_retry" };
      } catch (retryErr) {
        if (retryErr instanceof ProviderJsonParseError) retryErr.diagnostic.retryDecision = "same_route_retry_failed";
        throw retryErr;
      }
    }
  };
}

export function makeOpenRouterVisionCaller(apiKey: string, model: string): VisionJsonCaller {
  return withStructuredRetry(makeOpenRouterSingleCaller(apiKey, model));
}

const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

function makeNvidiaSingleCaller(apiKey: string, model: string, baseUrl?: string): VisionJsonCaller {
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
      max_tokens: req.maxOutputTokens ?? 2048,
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
    const streamDeadlineMs = requestStartTime + req.timeoutMs;

    try {
      while (true) {
        const { value, done } = await readStreamWithDeadline(reader, streamDeadlineMs, "nvidia");
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
              if (message.choices?.[0]?.finish_reason) {
                completion.finishReason = message.choices[0].finish_reason;
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

    const parsed = parseVisionJsonContent("nvidia", fullContent, req.jsonSchema.schema, streamCompleted, completion.finishReason);

    return {
      parsed,
      rawContent: fullContent,
      model: completion.model ?? model,
      provider: "nvidia",
      ...(completion.usage !== undefined ? { usage: completion.usage } : {}),
      ttftMs,
      ...(completion.finishReason !== undefined ? { finishReason: completion.finishReason } : {})
    };
  };
}

export function makeNvidiaVisionCaller(apiKey: string, model: string, baseUrl?: string): VisionJsonCaller {
  return withStructuredRetry(makeNvidiaSingleCaller(apiKey, model, baseUrl));
}
