import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callOpenRouterVisionJson } from "../../src/models/openrouter-client.js";
import { callNvidiaVisionJson } from "../../src/models/nvidia-client.js";

const FAKE_API_KEY = "sk-test-key";
const FAKE_MODEL = "qwen/qwen3-vl-30b-a3b-instruct";

function makeFetchMock(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  });
}

describe("callOpenRouterVisionJson", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct request shape with image data URLs", async () => {
    const responseBody = {
      model: FAKE_MODEL,
      choices: [{ message: { content: JSON.stringify({ result: "ok" }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 }
    };
    const mockFetch = makeFetchMock(200, responseBody);
    vi.stubGlobal("fetch", mockFetch);

    await callOpenRouterVisionJson({
      apiKey: FAKE_API_KEY,
      model: FAKE_MODEL,
      prompt: "Describe the image",
      images: ["data:image/png;base64,abc123"],
      jsonSchema: { name: "test_schema", schema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } },
      timeoutMs: 5000
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as {
      model: string;
      messages: Array<{ role: string; content: unknown[] }>;
      response_format: { type: string; json_schema: { strict: boolean } };
    };

    expect(body.model).toBe(FAKE_MODEL);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);

    const content = body.messages[0]?.content ?? [];
    expect(content[0]).toMatchObject({ type: "text" });
    expect(content[1]).toMatchObject({ type: "image_url" });
  });

  it("text comes before images in message content", async () => {
    const mockFetch = makeFetchMock(200, {
      model: FAKE_MODEL,
      choices: [{ message: { content: '{"x":1}' } }]
    });
    vi.stubGlobal("fetch", mockFetch);

    await callOpenRouterVisionJson({
      apiKey: FAKE_API_KEY,
      model: FAKE_MODEL,
      prompt: "Analyze",
      images: ["data:image/png;base64,img1", "data:image/png;base64,img2"],
      jsonSchema: { name: "s", schema: { type: "object", properties: { x: { type: "number" } }, required: ["x"], additionalProperties: false } },
      timeoutMs: 5000
    });

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    const content = body.messages[0]?.content ?? [];
    expect(content[0]?.type).toBe("text");
    expect(content[1]?.type).toBe("image_url");
    expect(content[2]?.type).toBe("image_url");
  });

  it("throws on non-2xx HTTP status", async () => {
    vi.stubGlobal("fetch", makeFetchMock(429, { error: "rate limited" }));

    await expect(callOpenRouterVisionJson({
      apiKey: FAKE_API_KEY,
      model: FAKE_MODEL,
      prompt: "test",
      images: [],
      jsonSchema: { name: "s", schema: {} },
      timeoutMs: 5000
    })).rejects.toThrow("429");
  });

  it("throws on malformed JSON in response content", async () => {
    vi.stubGlobal("fetch", makeFetchMock(200, {
      model: FAKE_MODEL,
      choices: [{ message: { content: "not json at all" } }]
    }));

    await expect(callOpenRouterVisionJson({
      apiKey: FAKE_API_KEY,
      model: FAKE_MODEL,
      prompt: "test",
      images: [],
      jsonSchema: { name: "s", schema: {} },
      timeoutMs: 5000
    })).rejects.toThrow(/not valid JSON/);
  });

  it("prefixes non-data-url images with data:image/png;base64,", async () => {
    const mockFetch = makeFetchMock(200, {
      model: FAKE_MODEL,
      choices: [{ message: { content: '{"v":true}' } }]
    });
    vi.stubGlobal("fetch", mockFetch);

    await callOpenRouterVisionJson({
      apiKey: FAKE_API_KEY,
      model: FAKE_MODEL,
      prompt: "test",
      images: ["rawbase64string"],
      jsonSchema: { name: "s", schema: { type: "object", properties: { v: { type: "boolean" } }, required: ["v"], additionalProperties: false } },
      timeoutMs: 5000
    });

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imgContent = body.messages[0]?.content.find(c => c.type === "image_url");
    expect(imgContent?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });
});

describe("callNvidiaVisionJson", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NVIDIA_VLM_BASE_URL", "http://nvidia.test");
    vi.stubEnv("NVIDIA_API_KEY", "nvidia-test-key");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("sends request to NVIDIA base URL and parses JSON content", async () => {
    const mockFetch = makeFetchMock(200, {
      model: "nvidia/test-model",
      choices: [{ message: { content: '{"color":"blue"}' } }]
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await callNvidiaVisionJson({
      apiKey: "nvidia-test-key",
      model: "nvidia/test-model",
      prompt: "What color?",
      images: [],
      jsonSchema: { name: "s", schema: {} },
      timeoutMs: 5000
    });

    expect(result.parsed).toEqual({ color: "blue" });
    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toContain("http://nvidia.test");
  });

  it("sends jsonSchema in the response_format", async () => {
    const testSchema = {
      type: "object",
      properties: {
        item: { type: "string" },
        quantity: { type: "number" }
      },
      required: ["item"]
    };
    const mockFetch = makeFetchMock(200, {
      model: "nvidia/test-model",
      choices: [{ message: { content: '{"item":"apple", "quantity": 5}' } }]
    });
    vi.stubGlobal("fetch", mockFetch);

    await callNvidiaVisionJson({
      apiKey: "nvidia-test-key",
      model: "nvidia/test-model",
      prompt: "Order 5 apples.",
      images: [],
      jsonSchema: { name: "order_schema", schema: testSchema },
      timeoutMs: 5000
    });

    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(callArgs[1].body as string) as any;

    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "order_schema",
        strict: true,
        schema: testSchema
      }
    });
  });

  it("throws when NVIDIA env vars are missing", async () => {
    vi.stubEnv("NVIDIA_API_KEY", "");
    await expect(callNvidiaVisionJson({
      apiKey: "",
      model: "nvidia/test-model",
      prompt: "test",
      images: [],
      jsonSchema: { name: "s", schema: {} },
      timeoutMs: 5000
    })).rejects.toThrow(/NVIDIA_API_KEY/);
  });

  it("throws on HTTP 500 from NVIDIA endpoint", async () => {
    vi.stubGlobal("fetch", makeFetchMock(500, { error: "internal" }));

    await expect(callNvidiaVisionJson({
      apiKey: "nvidia-test-key",
      model: "nvidia/test-model",
      prompt: "test",
      images: [],
      jsonSchema: { name: "s", schema: {} },
      timeoutMs: 5000
    })).rejects.toThrow("500");
  });
});
