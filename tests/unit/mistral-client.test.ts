import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMistralVisionCaller } from "../../src/models/mistral-client.js";

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
    model: "mistral-large-2512",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 5 }
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("makeMistralVisionCaller", () => {
  it("uses Mistral's flat image_url string format and local JSON validation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('{"color":"blue"}'));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeMistralVisionCaller("m-key", "mistral-large-2512")({
      prompt: "Identify the color.",
      images: ["first-base64", "data:image/png;base64,second-base64"],
      jsonSchema: schema,
      timeoutMs: 1000
    });

    expect(result).toMatchObject({
      parsed: { color: "blue" },
      model: "mistral-large-2512",
      provider: "mistral",
      finishReason: "stop",
      usage: { prompt_tokens: 20, completion_tokens: 5 }
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer m-key");
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ content: Array<{ type: string; image_url?: string }> }>;
      response_format?: { type: string };
    };
    expect(body.messages[0]?.content.map(part => part.type)).toEqual(["text", "image_url", "image_url"]);
    expect(body.messages[0]?.content[1]?.image_url).toBe("data:image/png;base64,first-base64");
    expect(body.messages[0]?.content[2]?.image_url).toBe("data:image/png;base64,second-base64");
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("surfaces bounded HTTP diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("rate limited detail", { status: 429 })));

    await expect(makeMistralVisionCaller("secret-key")({
      prompt: "Identify.",
      images: [],
      jsonSchema: schema,
      timeoutMs: 1000
    })).rejects.toThrow("Mistral HTTP 429: rate limited detail");
  });
});
