const NVIDIA_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

interface NvidiaCallRequest {
  apiKey: string;
  model: string;
  prompt: string;
  images: string[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
  timeoutMs: number;
}

interface NvidiaCallResponse {
  parsed: unknown;
  rawContent: string;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export async function callNvidiaVisionJson(
  req: NvidiaCallRequest
): Promise<NvidiaCallResponse> {
  const baseUrl = (process.env["NVIDIA_VLM_BASE_URL"] ?? NVIDIA_DEFAULT_BASE_URL).replace(/\/$/, "");
  const apiKey = process.env["NVIDIA_API_KEY"] ?? req.apiKey;

  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY must be set for NVIDIA adapter");
  }

  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [{ type: "text", text: req.prompt }];

  for (const imgData of req.images) {
    const url = imgData.startsWith("data:") ? imgData : `data:image/png;base64,${imgData}`;
    content.push({ type: "image_url", image_url: { url } });
  }

  const body = {
    model: req.model,
    messages: [{ role: "user" as const, content }],
    response_format: {
      type: "json_object"
    }
  };

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
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
    model: completion.model ?? req.model,
    ...(completion.usage !== undefined ? { usage: completion.usage } : {})
  };
}
