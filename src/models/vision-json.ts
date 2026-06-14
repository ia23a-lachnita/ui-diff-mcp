export type VisionMode = "free" | "free_openrouter" | "free_nvidia" | "paid" | "deterministic_only";

export interface VisionJsonRequest {
  prompt: string;
  images: string[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
  timeoutMs: number;
}

export interface VisionJsonResponse {
  parsed: unknown;
  rawContent: string;
  model: string;
  provider: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = [{ type: "text", text: req.prompt }];

    for (const imgData of req.images) {
      const url = imgData.startsWith("data:") ? imgData : `data:image/png;base64,${imgData}`;
      content.push({ type: "image_url", image_url: { url } });
    }

    const body = {
      model,
      messages: [{ role: "user" as const, content }],
      response_format: {
        type: "json_schema",
        json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema }
      }
    };

    let response: Response;
    try {
      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
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
      choices?: Array<{ message?: { content?: string } }>;
    };

    const rawContent = completion.choices?.[0]?.message?.content ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      throw new Error(`OpenRouter response content is not valid JSON: ${rawContent.slice(0, 200)}`);
    }

    return {
      parsed,
      rawContent,
      model: completion.model ?? model,
      provider: "openrouter",
      ...(completion.usage !== undefined ? { usage: completion.usage } : {})
    };
  };
}

const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

export function makeNvidiaVisionCaller(apiKey: string, model: string, baseUrl?: string): VisionJsonCaller {
  const endpoint = (baseUrl ?? NVIDIA_DEFAULT_BASE_URL).replace(/\/$/, "");
  return async (req) => {
    const content: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = [{ type: "text", text: req.prompt }];

    for (const imgData of req.images) {
      const url = imgData.startsWith("data:") ? imgData : `data:image/png;base64,${imgData}`;
      content.push({ type: "image_url", image_url: { url } });
    }

    const body = {
      model,
      messages: [{ role: "user" as const, content }],
      response_format: {
        type: "json_schema",
        json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema }
      }
    };

    let response: Response;
    try {
      response = await fetch(`${endpoint}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
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

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error("NVIDIA returned non-JSON response");
    }

    const completion = json as {
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: Array<{ message?: { content?: string } }>;
    };

    const rawContent = completion.choices?.[0]?.message?.content ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      throw new Error(`NVIDIA response content is not valid JSON: ${rawContent.slice(0, 200)}`);
    }

    return {
      parsed,
      rawContent,
      model: completion.model ?? model,
      provider: "nvidia",
      ...(completion.usage !== undefined ? { usage: completion.usage } : {})
    };
  };
}
