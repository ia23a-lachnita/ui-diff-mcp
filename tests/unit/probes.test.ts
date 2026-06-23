import { afterEach, describe, expect, it, vi } from "vitest";
import { probeOpenRouterModel, probeNvidiaModel, probeRequiredModels } from "../../src/models/probes.js";
import type { VisionProviderConfig } from "../../src/models/provider-config.js";

const AUDITOR: import("../../src/models/model-registry.js").ModelEntry = {
  role: "auditor",
  provider: "openrouter",
  model: "qwen/qwen3-vl-30b-a3b-instruct",
  costClass: "paid",
  probeTtlMs: 60000,
  required: true
};

const NVIDIA_ENTRY: import("../../src/models/model-registry.js").ModelEntry = {
  role: "auditor",
  provider: "nvidia",
  model: "nvidia/llama-3.2-90b-vision-instruct",
  costClass: "free",
  probeTtlMs: 60000,
  required: false
};

const PROVIDER_CONFIG: VisionProviderConfig = {
  openRouterApiKey: "sk-test",
  nvidiaApiKey: "nv-test",
  nvidiaBaseUrl: "https://nvidia.example/v1",
  openCodeApiKey: "public",
  openCodeBaseUrl: "https://opencode.ai/zen/v1"
};

function makeSseStream(contentJson: string, model = "qwen/test"): ReadableStream<Uint8Array> {
  const contentEscaped = JSON.stringify(contentJson); // wraps in quotes and escapes
  const chunk1 = `data: {"choices":[{"delta":{"content":${contentEscaped}}}],"model":"${model}"}\n\n`;
  const chunk2 = `data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n`;
  const chunk3 = `data: [DONE]\n\n`;
  const encoded = new TextEncoder().encode(chunk1 + chunk2 + chunk3);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    }
  });
}

function makeStreamFetch(contentJson: string): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    body: makeSseStream(contentJson)
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("probeOpenRouterModel", () => {
  it("returns not_checked when apiKey is empty", async () => {
    const result = await probeOpenRouterModel(AUDITOR, "");
    expect(result.status).toBe("not_checked");
    expect(result.role).toBe("auditor");
    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe(AUDITOR.model);
    expect(result.detail).toContain("No API key");
  });

  it("returns fail when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await probeOpenRouterModel(AUDITOR, "sk-test");
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("network down");
  });

  it("returns fail when model returns wrong probe result", async () => {
    vi.stubGlobal("fetch", makeStreamFetch('{"dominantColor":"red","hasRedRect":false}'));
    const result = await probeOpenRouterModel(AUDITOR, "sk-test");
    expect(result.status).toBe("fail");
  });

  it("returns pass when model correctly identifies blue and red rect", async () => {
    vi.stubGlobal("fetch", makeStreamFetch('{"dominantColor":"blue","hasRedRect":true}'));
    const result = await probeOpenRouterModel(AUDITOR, "sk-test");
    expect(result.status).toBe("pass");
  });
});

describe("probeNvidiaModel", () => {
  it("returns not_checked when no API key is provided", async () => {
    const result = await probeNvidiaModel(NVIDIA_ENTRY, "");
    expect(result.status).toBe("not_checked");
    expect(result.detail).toContain("NVIDIA_API_KEY");
  });

  it("returns not_checked when NVIDIA_API_KEY env var is missing and no arg given", async () => {
    vi.stubEnv("NVIDIA_API_KEY", "");
    const result = await probeNvidiaModel(NVIDIA_ENTRY);
    expect(result.status).toBe("not_checked");
  });
});

describe("probeRequiredModels", () => {
  it("probes one OpenCode route once at five images and projects the result to all visual roles", async () => {
    const entries: import("../../src/models/model-registry.js").ModelEntry[] = [
      { role: "auditor", provider: "opencode", model: "mimo-v2.5-free", costClass: "free", probeTtlMs: 60_000, required: false },
      { role: "reviewer", provider: "opencode", model: "mimo-v2.5-free", costClass: "free", probeTtlMs: 60_000, required: false },
      { role: "target_recovery", provider: "opencode", model: "mimo-v2.5-free", costClass: "free", probeTtlMs: 60_000, required: false }
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "xiaomi/mimo-v2.5-20260422",
      choices: [{ message: { content: '{"imageCount":5,"hasBlueImage":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20 }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const results = await probeRequiredModels(entries, PROVIDER_CONFIG);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.map(result => result.role).sort()).toEqual(["auditor", "reviewer", "target_recovery"]);
    expect(results.every(result => result.status === "pass")).toBe(true);
    expect(results.every(result => result.maxImagesSupported === 5)).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer public");
  });

  it("returns not_checked for all openrouter entries when no API key", async () => {
    const reviewer: import("../../src/models/model-registry.js").ModelEntry = {
      role: "reviewer",
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
      costClass: "paid",
      probeTtlMs: 60000,
      required: true
    };
    const results = await probeRequiredModels([AUDITOR, reviewer], { ...PROVIDER_CONFIG, openRouterApiKey: "" });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === "not_checked")).toBe(true);
  });

  it("dispatches nvidia entries to probeNvidiaModel (no key returns not_checked)", async () => {
    const results = await probeRequiredModels([NVIDIA_ENTRY], { ...PROVIDER_CONFIG, nvidiaApiKey: "" });
    expect(results[0]?.status).toBe("not_checked");
    expect(results[0]?.detail).toContain("NVIDIA_API_KEY");
  });
});
