// tests/integration/benchmark-script.integration.test.ts

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from 'node:url';
import { runBenchmark } from "../../scripts/benchmark-free-models.js"; // Import runBenchmark

// Mock the probes module
const mockProbes = vi.hoisted(() => ({
  probeRequiredModels: vi.fn(),
}));
vi.mock("../../src/models/probes.js", () => mockProbes);

// Mock the model-registry to control CANONICAL_MODEL_RANKING
const mockModelRegistry = vi.hoisted(() => ({
  CANONICAL_MODEL_RANKING: [
    {
      role: "auditor",
      provider: "opencode",
      model: "mimo-v2.5-free",
      costClass: "free",
      eligibleFreeProviderRoutes: [{ provider: "opencode", model: "mimo-v2.5-free" }],
      defaultFreeModeHandling: "test",
    },
    {
      role: "auditor",
      provider: "openrouter",
      model: "openrouter-test-model",
      costClass: "free",
      eligibleFreeProviderRoutes: [{ provider: "openrouter", model: "openrouter-test-model:free" }],
      defaultFreeModeHandling: "test",
    },
    {
      role: "reviewer",
      provider: "nvidia",
      model: "nvidia-test-model",
      costClass: "free",
      eligibleFreeProviderRoutes: [{ provider: "nvidia", model: "nvidia-test-model" }],
      defaultFreeModeHandling: "test",
    },
  ],
}));
vi.mock("../../src/models/model-registry.js", () => mockModelRegistry);

// Mock fs to capture write operations
const mockFsPromises = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original, // Include all original named exports if any
    default: mockFsPromises, // Explicitly set the default export to our mockFsPromises
  };
});

// Mock process.env
const originalEnv = process.env;
let consoleOutput: string[] = [];
const mockedConsoleLog = (output: string) => consoleOutput.push(output);
const mockedConsoleError = (output: string) => consoleOutput.push(output); // Capture errors too

describe("benchmark-free-models.ts", () => {
  const OUTPUT_DIR = ".ui-diff/generated";
  const OUTPUT_FILE = path.join(OUTPUT_DIR, "model-benchmark.json");

  beforeAll(() => {
    vi.stubGlobal('console', { log: mockedConsoleLog, error: mockedConsoleError }); // Use mockedConsoleError for error
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    consoleOutput = [];
    // Explicitly clear relevant environment variables for each test
    process.env = { ...originalEnv, OPENROUTER_API_KEY: undefined, NVIDIA_API_KEY: undefined, NVIDIA_VLM_BASE_URL: undefined };
  });

  afterEach(() => { // Keep afterEach for process.env cleanup if needed per test
    process.env = originalEnv;
  });

  it("benchmarks public OpenCode and records legacy routes not_checked when no API keys are set", async () => {
    process.env.OPENROUTER_API_KEY = undefined;
    process.env.NVIDIA_API_KEY = undefined;
    mockProbes.probeRequiredModels.mockResolvedValue([{
      role: "auditor", provider: "opencode", model: "mimo-v2.5-free", status: "pass",
      ttftMs: 80, schemaValid: true, contentAccurate: true
    }]);

    await runBenchmark();

    const writtenContent = JSON.parse(mockFsPromises.writeFile.mock.calls[0]![1] as string);
    expect(writtenContent.results).toHaveLength(3);
    expect(writtenContent.results[0]).toMatchObject({ provider: "opencode", probeStatus: "pass" });
    expect(writtenContent.results[1]).toMatchObject({ provider: "openrouter", probeStatus: "not_checked" });
    expect(writtenContent.results[2]).toMatchObject({ provider: "nvidia", probeStatus: "not_checked" });
  });

  it("runs benchmark and writes results to file", async () => {
    process.env.OPENROUTER_API_KEY = "dummy-openrouter-key";
    process.env.NVIDIA_API_KEY = "dummy-nvidia-key";

    mockProbes.probeRequiredModels.mockImplementation((entries: Array<{ provider: string; role: string; model: string }>) => {
      const entry = entries[0]!;
      return Promise.resolve([entry.provider === "opencode"
        ? { ...entry, status: "pass", ttftMs: 80, schemaValid: true, contentAccurate: true }
        : entry.provider === "openrouter"
          ? { ...entry, status: "pass", ttftMs: 100, schemaValid: true, contentAccurate: true }
          : { ...entry, status: "fail", ttftMs: 200, detail: "Some error", schemaValid: false, contentAccurate: false }]);
    });

    await runBenchmark(); // Call the exported function

    expect(mockFsPromises.mkdir).toHaveBeenCalledWith(OUTPUT_DIR, { recursive: true });
    expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
      OUTPUT_FILE,
      expect.stringContaining(`"benchmarkedAt":`)
    );

    const writtenContent = JSON.parse(mockFsPromises.writeFile.mock.calls[0]![1] as string);
    expect(writtenContent.results).toHaveLength(3);

    expect(writtenContent.results[0]).toEqual(
      expect.objectContaining({ provider: "opencode", model: "mimo-v2.5-free", probeStatus: "pass", ttftMs: 80 })
    );
    expect(writtenContent.results[1]).toEqual(
      expect.objectContaining({
        role: "auditor",
        provider: "openrouter",
        model: "openrouter-test-model:free",
        probeStatus: "pass",
        ttftMs: 100,
        schemaValid: true,
        contentAccurate: true,
      })
    );
    expect(writtenContent.results[2]).toEqual(
      expect.objectContaining({
        role: "reviewer",
        provider: "nvidia",
        model: "nvidia-test-model",
        probeStatus: "fail",
        ttftMs: 200,
        detail: "Some error",
        schemaValid: false,
        contentAccurate: false,
      })
    );

    expect(consoleOutput).toContain("✓ [opencode] mimo-v2.5-free (80ms)");
    expect(consoleOutput).toContain("✓ [openrouter] openrouter-test-model:free (100ms)");
    expect(consoleOutput).toContain("✗ [nvidia] nvidia-test-model (200ms)");
    expect(consoleOutput.some(line => line.includes("2/3 routes passed probes."))).toBe(true);
  });

  it("handles mixed API key presence", async () => {
    process.env.OPENROUTER_API_KEY = "dummy-openrouter-key";
    // NVIDIA_API_KEY is not set

    mockProbes.probeRequiredModels.mockImplementation((entries: Array<{ provider: string; role: string; model: string }>) => {
      const entry = entries[0]!;
      return Promise.resolve([{ ...entry, status: "pass", ttftMs: entry.provider === "opencode" ? 80 : 100, schemaValid: true, contentAccurate: true }]);
    });

    await runBenchmark(); // Call the exported function

    const writtenContent = JSON.parse(mockFsPromises.writeFile.mock.calls[0]![1] as string);
    expect(writtenContent.results).toHaveLength(3);

    expect(writtenContent.results[0].probeStatus).toBe("pass");
    expect(writtenContent.results[1].probeStatus).toBe("pass");
    expect(writtenContent.results[2].probeStatus).toBe("not_checked");
    expect(writtenContent.results[2].detail).toBe("No NVIDIA_API_KEY");
  });
});
