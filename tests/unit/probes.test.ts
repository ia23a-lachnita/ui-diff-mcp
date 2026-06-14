import { afterEach, describe, expect, it, vi } from "vitest";
import { probeOpenRouterModel, probeNvidiaModel, probeRequiredModels } from "../../src/models/probes.js";

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
  it("returns not_checked for all openrouter entries when no API key", async () => {
    const reviewer: import("../../src/models/model-registry.js").ModelEntry = {
      role: "reviewer",
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
      costClass: "paid",
      probeTtlMs: 60000,
      required: true
    };
    const results = await probeRequiredModels([AUDITOR, reviewer], "");
    expect(results).toHaveLength(2);
    expect(results.every(r => r.status === "not_checked")).toBe(true);
  });

  it("dispatches nvidia entries to probeNvidiaModel (no key returns not_checked)", async () => {
    const results = await probeRequiredModels([NVIDIA_ENTRY], "sk-test", "");
    expect(results[0]?.status).toBe("not_checked");
    expect(results[0]?.detail).toContain("NVIDIA_API_KEY");
  });
});
