import { afterEach, describe, expect, it, vi } from "vitest";
import { makeOpenCodeVisionCaller } from "../../src/models/opencode-client.js";
import { ProviderJsonParseError } from "../../src/models/vision-json.js";

const schema = {
  name: "color_result",
  schema: {
    type: "object",
    properties: { color: { type: "string" } },
    required: ["color"],
    additionalProperties: false
  }
};

function completion(content: string, overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    model: "xiaomi/mimo-v2.5-20260422",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 5 },
    ...overrides
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("makeOpenCodeVisionCaller", () => {
  it("uses the public free route and sends prompt before ordered images", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('{"color":"blue"}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeOpenCodeVisionCaller()( {
      prompt: "Identify the color.",
      images: ["first-base64", "data:image/png;base64,second-base64"],
      jsonSchema: schema,
      timeoutMs: 1000
    });

    expect(result).toMatchObject({
      parsed: { color: "blue" },
      model: "xiaomi/mimo-v2.5-20260422",
      provider: "opencode",
      finishReason: "stop",
      usage: { prompt_tokens: 20, completion_tokens: 5 }
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer public");
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
      response_format: { type: string; json_schema: { name: string; strict: boolean } };
    };
    expect(body.model).toBe("mimo-v2.5-free");
    expect(body.messages[0]?.content.map(part => part.type)).toEqual(["text", "image_url", "image_url"]);
    expect(body.messages[0]?.content[1]?.image_url?.url).toBe("data:image/png;base64,first-base64");
    expect(body.messages[0]?.content[2]?.image_url?.url).toBe("data:image/png;base64,second-base64");
    expect(body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "color_result", strict: true } });
  });

  it("honors custom credentials/base URL and parser-only mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('{"color":"green"}'));
    vi.stubGlobal("fetch", fetchMock);

    await makeOpenCodeVisionCaller("oc-key", "custom-model", "https://zen.example/v1/")({
      prompt: "Identify.",
      images: [],
      jsonSchema: schema,
      jsonMode: "parser_only",
      timeoutMs: 1000
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://zen.example/v1/chat/completions");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer oc-key");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body["model"]).toBe("custom-model");
    expect(body).not.toHaveProperty("response_format");
  });

  it("surfaces bounded HTTP diagnostics without credentials or response bodies in the error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited detail", { status: 429 })));

    await expect(makeOpenCodeVisionCaller("secret-key")({
      prompt: "Identify.",
      images: [],
      jsonSchema: schema,
      timeoutMs: 1000
    })).rejects.toThrow("OpenCode HTTP 429: rate limited detail");
  });

  it("does not retry empty provider content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion(""));
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeOpenCodeVisionCaller()({
      prompt: "Identify.",
      images: [],
      jsonSchema: schema,
      timeoutMs: 1000
    })).rejects.toBeInstanceOf(ProviderJsonParseError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries one schema-invalid response with the compact instruction", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion('{"wrong":"field"}'))
      .mockResolvedValueOnce(completion('{"color":"red"}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeOpenCodeVisionCaller()({
      prompt: "Identify.",
      images: [],
      jsonSchema: schema,
      timeoutMs: 1000
    });

    expect(result.parsed).toEqual({ color: "red" });
    expect(result.retryDecision).toBe("same_route_compact_retry");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as {
      messages: Array<{ content: Array<{ text?: string }> }>;
    };
    expect(retryBody.messages[0]?.content[0]?.text).toContain("smallest valid JSON object");
  });
});
