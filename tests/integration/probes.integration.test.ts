import { describe, it, expect, vi, beforeEach } from "vitest";
import { probeOpenRouterModel, probeNvidiaModel } from "../../src/models/probes.js";
import type { VisionJsonResponse } from "../../src/models/vision-json.js";
import type { ModelEntry } from "../../src/models/model-registry.js";

// Mock the vision-json module
const mockVisionJson = vi.hoisted(() => {
  const mockOpenRouterCaller = vi.fn();
  const mockNvidiaCaller = vi.fn();
  return {
    makeOpenRouterVisionCaller: vi.fn(() => mockOpenRouterCaller),
    makeNvidiaVisionCaller: vi.fn(() => mockNvidiaCaller),
  };
});

vi.mock("../../src/models/vision-json.js", () => mockVisionJson);

describe("probeOpenRouterModel", () => {
  const mockModelEntry: ModelEntry = {
    role: "auditor",
    provider: "openrouter",
    model: "test-model",
    costClass: "free",
    probeTtlMs: 1000,
    required: true,
  };
  const mockApiKey = "test-key";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not_checked if no API key is provided", async () => {
    const result = await probeOpenRouterModel(mockModelEntry, "");
    expect(result.status).toBe("not_checked");
    expect(result.detail).toBe("No API key provided");
    expect(result.schemaValid).toBeNull();
    expect(result.contentAccurate).toBeNull();
  });

  it("returns pass for a successful probe with correct JSON and content", async () => {
    const mockResponse: VisionJsonResponse = {
      parsed: { dominantColor: "blue", hasRedRect: true },
      rawContent: '{"dominantColor":"blue","hasRedRect":true}',
      model: "test-model",
      provider: "openrouter",
      ttftMs: 150,
    };
    mockVisionJson.makeOpenRouterVisionCaller().mockResolvedValue(mockResponse);

    const result = await probeOpenRouterModel(mockModelEntry, mockApiKey);
    expect(result.status).toBe("pass");
    expect(result.ttftMs).toBe(150);
    expect(result.schemaValid).toBe(true);
    expect(result.contentAccurate).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it("returns fail if JSON schema is invalid (missing property)", async () => {
    const mockResponse: VisionJsonResponse = {
      parsed: { dominantColor: "blue" }, // Missing hasRedRect
      rawContent: '{"dominantColor":"blue"}',
      model: "test-model",
      provider: "openrouter",
      ttftMs: 160,
    };
    mockVisionJson.makeOpenRouterVisionCaller().mockResolvedValue(mockResponse);

    const result = await probeOpenRouterModel(mockModelEntry, mockApiKey);
    expect(result.status).toBe("fail");
    expect(result.ttftMs).toBe(160);
    expect(result.schemaValid).toBe(false);
    expect(result.contentAccurate).toBe(false);
    expect(result.detail).toContain("Schema valid: false");
  });

  it("returns fail if content is inaccurate but schema is valid", async () => {
    const mockResponse: VisionJsonResponse = {
      parsed: { dominantColor: "green", hasRedRect: false }, // Incorrect content
      rawContent: '{"dominantColor":"green","hasRedRect":false}',
      model: "test-model",
      provider: "openrouter",
      ttftMs: 170,
    };
    mockVisionJson.makeOpenRouterVisionCaller().mockResolvedValue(mockResponse);

    const result = await probeOpenRouterModel(mockModelEntry, mockApiKey);
    expect(result.status).toBe("fail");
    expect(result.ttftMs).toBe(170);
    expect(result.schemaValid).toBe(true);
    expect(result.contentAccurate).toBe(false);
    expect(result.detail).toContain("Content accurate: false");
  });

  it("returns fail for API call errors", async () => {
    mockVisionJson.makeOpenRouterVisionCaller().mockRejectedValue(new Error("Network error"));

    const result = await probeOpenRouterModel(mockModelEntry, mockApiKey);
    expect(result.status).toBe("fail");
    expect(result.ttftMs).toBeNull();
    expect(result.schemaValid).toBe(false);
    expect(result.contentAccurate).toBe(false);
    expect(result.detail).toContain("Network error");
  });
});

describe("probeNvidiaModel", () => {
  const mockModelEntry: ModelEntry = {
    role: "auditor",
    provider: "nvidia",
    model: "nvidia-test-model",
    costClass: "free",
    probeTtlMs: 1000,
    required: true,
  };
  const mockApiKey = "nvidia-key";
  const mockBaseUrl = "http://localhost:8000";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not_checked if no API key is provided", async () => {
    const result = await probeNvidiaModel(mockModelEntry, "", mockBaseUrl);
    expect(result.status).toBe("not_checked");
    expect(result.detail).toBe("NVIDIA_API_KEY not set");
    expect(result.schemaValid).toBeNull();
    expect(result.contentAccurate).toBeNull();
  });

  it("returns pass for a successful probe with correct JSON and content", async () => {
    const mockResponse: VisionJsonResponse = {
      parsed: { dominantColor: "blue", hasRedRect: true },
      rawContent: '{"dominantColor":"blue","hasRedRect":true}',
      model: "nvidia-test-model",
      provider: "nvidia",
      ttftMs: 200,
    };
    mockVisionJson.makeNvidiaVisionCaller().mockResolvedValue(mockResponse);

    const result = await probeNvidiaModel(mockModelEntry, mockApiKey, mockBaseUrl);
    expect(result.status).toBe("pass");
    expect(result.ttftMs).toBe(200);
    expect(result.schemaValid).toBe(true);
    expect(result.contentAccurate).toBe(true);
    expect(result.detail).toBeUndefined();
  });

  it("returns fail if JSON schema is invalid (missing property)", async () => {
    const mockResponse: VisionJsonResponse = {
      parsed: { hasRedRect: true }, // Missing dominantColor
      rawContent: '{"hasRedRect":true}',
      model: "nvidia-test-model",
      provider: "nvidia",
      ttftMs: 210,
    };
    mockVisionJson.makeNvidiaVisionCaller().mockResolvedValue(mockResponse);

    const result = await probeNvidiaModel(mockModelEntry, mockApiKey, mockBaseUrl);
    expect(result.status).toBe("fail");
    expect(result.ttftMs).toBe(210);
    expect(result.schemaValid).toBe(false);
    expect(result.contentAccurate).toBe(false);
    expect(result.detail).toContain("Schema valid: false");
  });

  it("returns fail if content is inaccurate but schema is valid", async () => {
    const mockResponse: VisionJsonResponse = {
      parsed: { dominantColor: "red", hasRedRect: true }, // Incorrect content
      rawContent: '{"dominantColor":"red","hasRedRect":true}',
      model: "nvidia-test-model",
      provider: "nvidia",
      ttftMs: 220,
    };
    mockVisionJson.makeNvidiaVisionCaller().mockResolvedValue(mockResponse);

    const result = await probeNvidiaModel(mockModelEntry, mockApiKey, mockBaseUrl);
    expect(result.status).toBe("fail");
    expect(result.ttftMs).toBe(220);
    expect(result.schemaValid).toBe(true);
    expect(result.contentAccurate).toBe(false);
    expect(result.detail).toContain("Content accurate: false");
  });

  it("returns fail for API call errors", async () => {
    mockVisionJson.makeNvidiaVisionCaller().mockRejectedValue(new Error("NVIDIA API error"));

    const result = await probeNvidiaModel(mockModelEntry, mockApiKey, mockBaseUrl);
    expect(result.status).toBe("fail");
    expect(result.ttftMs).toBeNull();
    expect(result.schemaValid).toBe(false);
    expect(result.contentAccurate).toBe(false);
    expect(result.detail).toContain("NVIDIA API error");
  });
});
