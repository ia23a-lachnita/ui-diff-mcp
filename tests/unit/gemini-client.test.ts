import { afterEach, describe, expect, it, vi } from "vitest";
import { makeGeminiVisionCaller } from "../../src/models/gemini-client.js";

const schema = {
  name: "color_result",
  schema: {
    type: "object",
    properties: { color: { type: "string" } },
    required: ["color"],
    additionalProperties: false
  }
};

function completion(content: string): Response {
  return new Response(JSON.stringify({
    candidates: [{
      content: { parts: [{ text: content }], role: "model" },
      finishReason: "STOP"
    }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 21, thoughtsTokenCount: 5 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("makeGeminiVisionCaller", () => {
  it("sends text before ordered inline image parts and validates JSON locally", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('{"color":"blue"}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeGeminiVisionCaller("g-key", "gemini-3.5-flash")({
      prompt: "Identify the color.",
      images: ["first-base64", "data:image/png;base64,second-base64"],
      jsonSchema: schema,
      timeoutMs: 1000
    });

    expect(result).toMatchObject({
      parsed: { color: "blue" },
      model: "gemini-3.5-flash",
      provider: "gemini",
      finishReason: "STOP",
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 21, reasoning_tokens: 5 }
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=g-key");
    const body = JSON.parse(String(init.body)) as {
      contents: Array<{ parts: Array<{ text?: string; inline_data?: { data: string } }> }>;
      generationConfig: { response_mime_type?: string; response_schema?: unknown };
    };
    expect(body.contents[0]?.parts.map(part => part.text !== undefined ? "text" : "inline_data")).toEqual(["text", "inline_data", "inline_data"]);
    expect(body.contents[0]?.parts[1]?.inline_data?.data).toBe("first-base64");
    expect(body.contents[0]?.parts[2]?.inline_data?.data).toBe("second-base64");
    expect(body.generationConfig.response_mime_type).toBe("application/json");
    expect(body.generationConfig.response_schema).toEqual({
      type: "object",
      properties: { color: { type: "string" } },
      required: ["color"]
    });
  });

  it("surfaces HTTP errors without leaking the API key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("quota exceeded detail", { status: 429 })));

    await expect(makeGeminiVisionCaller("secret-key", "gemini-3.1-pro-preview")({
      prompt: "Identify.",
      images: [],
      jsonSchema: schema,
      timeoutMs: 1000
    })).rejects.toThrow("Gemini HTTP 429: quota exceeded detail");
  });

  it("extracts totalTokenCount and thoughtsTokenCount from usageMetadata and maps them correctly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: '{"color":"green"}' }] },
        finishReason: "MAX_TOKENS"
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 15,
        totalTokenCount: 25,
        thoughtsTokenCount: 5
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeGeminiVisionCaller("g-key", "gemini-3.5-flash")({
      prompt: "Identify the color.",
      images: [],
      jsonSchema: schema,
      timeoutMs: 1000
    });

    expect(result).toMatchObject({
      parsed: { color: "green" },
      usage: {
        prompt_tokens: 10,
        completion_tokens: 15,
        total_tokens: 25,
        reasoning_tokens: 5
      },
      finishReason: "MAX_TOKENS"
    });
  });
});
