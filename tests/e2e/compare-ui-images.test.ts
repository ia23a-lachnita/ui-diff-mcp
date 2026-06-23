import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUiDiff } from "../../src/pipeline/run-ui-diff.js";
import { writeTwoButtonFixture, writeSolidPng } from "../../src/testing/fixture-images.js";
import { startMockSidecar } from "../fixtures/mock-sidecar.js";
import { makeMockFetch } from "../fixtures/mock-models.js";
import type { MockSidecar } from "../fixtures/mock-sidecar.js";

let tmpDir: string;
let sidecar: MockSidecar;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-e2e-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (sidecar) await sidecar.stop();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runUiDiff end-to-end (deterministic_only mode)", () => {
  it("returns complete status, writes report.json, and reports diffs", async () => {
    const { expected, actual } = await writeTwoButtonFixture(
      tmpDir, "expected.png", "actual.png"
    );

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only"
    });

    expect(result.status).toBe("complete");
    expect(result.runId).toBeTruthy();
    expect(result.reportPath).toContain("report.json");
    expect(result.artifactRoot).toBeTruthy();
    expect(result.summary).toBeTruthy();

    const reportRaw = await fs.readFile(result.reportPath, "utf8");
    const report = JSON.parse(reportRaw) as {
      schemaVersion: string;
      runId: string;
      status: string;
      visualClassificationStatus: string;
      unresolvedRegions: Array<{ artifactPaths: unknown[] }>;
    };
    expect(report.schemaVersion).toBe("0.1");
    expect(report.runId).toBe(result.runId);
    expect(report.visualClassificationStatus).toBe("not_run");
    expect(report.unresolvedRegions.length).toBeGreaterThan(0);
    expect(report.unresolvedRegions.every(region => region.artifactPaths.length === 4)).toBe(true);
  });

  it("normalized images are written as artifacts", async () => {
    const { expected, actual } = await writeTwoButtonFixture(
      tmpDir, "e.png", "a.png"
    );

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only"
    });

    const runDir = path.dirname(path.dirname(result.reportPath));
    const expectedNorm = path.join(runDir, "expected-normalized.png");
    const actualNorm = path.join(runDir, "actual-normalized.png");

    await expect(fs.access(expectedNorm)).resolves.toBeUndefined();
    await expect(fs.access(actualNorm)).resolves.toBeUndefined();

    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as {
      runArtifacts: Array<{ role: string; path: string }>;
    };
    const comparisonArtifact = report.runArtifacts.find(artifact => artifact.role === "actual_comparison_space");
    expect(comparisonArtifact?.path).toBe(path.join(runDir, "actual-comparison-space.png"));
    await expect(fs.access(comparisonArtifact!.path)).resolves.toBeUndefined();

    const index = JSON.parse(await fs.readFile(path.join(result.artifactRoot, "index.json"), "utf8")) as {
      runArtifacts: Array<{ role: string; path: string }>;
    };
    expect(index.runArtifacts).toContainEqual(comparisonArtifact);
  });

  it("resumes into the same artifact root without duplicating completed stage records", async () => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "resume-e.png", "resume-a.png");
    const first = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      runId: "run-resume-e2e"
    });
    const checkpoint = JSON.parse(await fs.readFile(first.reportPath, "utf8")) as Record<string, unknown>;
    checkpoint["status"] = "interrupted";
    checkpoint["isCheckpoint"] = true;
    await fs.writeFile(first.reportPath, JSON.stringify(checkpoint), "utf8");

    const resumed = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      resumeRunId: "run-resume-e2e"
    });
    const report = JSON.parse(await fs.readFile(resumed.reportPath, "utf8")) as { runId: string; stages: Array<{ name: string }> };
    expect(resumed.runId).toBe("run-resume-e2e");
    expect(resumed.artifactRoot).toBe(first.artifactRoot);
    expect(new Set(report.stages.map(stage => stage.name)).size).toBe(report.stages.length);
  });
});

describe("runUiDiff with mock sidecar and models (full mode)", () => {
  it("routes free_opencode semantic calls through Zen and records exact model selections", async () => {
    const expected = await writeSolidPng(tmpDir, "opencode-e.png", 200, 400, 200, 200, 200);
    const actual = await writeSolidPng(tmpDir, "opencode-a.png", 200, 400, 200, 200, 200);
    sidecar = await startMockSidecar({ imageWidth: 200, imageHeight: 400 });

    const baseFetch = makeMockFetch([], { sidecarImageWidth: 200, sidecarImageHeight: 400 });
    const callBaseFetch = baseFetch as unknown as (url: unknown, init?: RequestInit) => Promise<unknown>;
    const mockFetch = vi.fn().mockImplementation((url: unknown, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("opencode.ai/zen/v1/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as {
          response_format?: { json_schema?: { name?: string } };
        };
        const schemaName = body.response_format?.json_schema?.name ?? "";
        const content = schemaName.startsWith("audit_")
          ? '{"hasDiff":false}'
          : schemaName === "review_decision"
            ? '{"decision":"accepted","reason":"supported"}'
            : '{"classified":false}';
        return Promise.resolve(new Response(JSON.stringify({
          model: "xiaomi/mimo-v2.5-20260422",
          choices: [{ message: { content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20 }
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return callBaseFetch(url, init);
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecar.url);

    const probeOverride = async () => [
      { role: "auditor", provider: "opencode", model: "mimo-v2.5-free", status: "pass" as const, checkedAt: new Date().toISOString(), schemaValid: true, contentAccurate: true, maxImagesSupported: 5 },
      { role: "reviewer", provider: "opencode", model: "mimo-v2.5-free", status: "pass" as const, checkedAt: new Date().toISOString(), schemaValid: true, contentAccurate: true, maxImagesSupported: 5 },
      { role: "target_recovery", provider: "opencode", model: "mimo-v2.5-free", status: "pass" as const, checkedAt: new Date().toISOString(), schemaValid: true, contentAccurate: true, maxImagesSupported: 5 }
    ];

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "free_opencode"
    }, { probeOverride });

    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as {
      modelSelection?: Record<string, { provider: string; model: string }>;
      runArtifacts: Array<{ role: string; path: string }>;
    };
    expect(report.modelSelection?.["auditor"]).toMatchObject({ provider: "opencode", model: "mimo-v2.5-free" });
    expect(report.modelSelection?.["reviewer"]).toMatchObject({ provider: "opencode", model: "mimo-v2.5-free" });
    expect(report.modelSelection?.["targetRecovery"]).toMatchObject({ provider: "opencode", model: "mimo-v2.5-free" });
    expect(mockFetch.mock.calls.some(([url]) => typeof url === "string" && url.includes("opencode.ai/zen/v1/chat/completions"))).toBe(true);
    const providerTracePath = report.runArtifacts.find(artifact => artifact.role === "provider_trace")?.path;
    expect(providerTracePath).toBeTruthy();
    const providerTrace = JSON.parse(await fs.readFile(providerTracePath!, "utf8")) as Array<{ provider: string; event: string }>;
    expect(providerTrace.some(event => event.provider === "opencode" && event.event === "call_success")).toBe(true);
  });

  it("discovers elements, pairs them, and runs audit pipeline", async () => {
    const { expected, actual } = await writeTwoButtonFixture(
      tmpDir, "e.png", "a.png"
    );

    sidecar = await startMockSidecar({ imageWidth: 200, imageHeight: 400 });

    const mockFetch = makeMockFetch([
      {
        criterion: "geometry",
        hasDiff: true,
        severity: "medium",
        title: "Button shifted",
        evidence: ["actual y=70px, expected y=50px"],
        reviewerDecision: "accepted"
      }
    ], { sidecarImageWidth: 200, sidecarImageHeight: 400 });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecar.url);
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-e2e");

    const probeOverride = async () => [
      { role: "auditor", provider: "openrouter", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", status: "pass" as const, checkedAt: new Date().toISOString(), schemaValid: true, contentAccurate: true, maxImagesSupported: 5 },
      { role: "reviewer", provider: "openrouter", model: "nex-agi/nex-n2-pro:free", status: "pass" as const, checkedAt: new Date().toISOString(), schemaValid: true, contentAccurate: true, maxImagesSupported: 5 }
    ];

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "full"
    }, { probeOverride });

    expect(result.runId).toBeTruthy();
    expect(result.status).toBe("complete");

    const reportRaw = await fs.readFile(result.reportPath, "utf8");
    const report = JSON.parse(reportRaw) as {
      diffs: { criterion: string }[];
      unresolvedRegions: unknown[];
      elements: { expected: unknown[]; actual: unknown[] };
      visualClassificationStatus: string;
      debugSummary?: unknown;
      runArtifacts: { role: string; path: string }[];
    };
    expect(Array.isArray(report.diffs)).toBe(true);
    expect(report.diffs.every(diff => diff.criterion !== "unclassified_visual_change")).toBe(true);
    expect(Array.isArray(report.unresolvedRegions)).toBe(true);
    expect(Array.isArray(report.elements.expected)).toBe(true);
    // Recovery may leave some pixel-diff regions unclassified when the VLM mock returns
    // classified:false; the important check is that the VLM stage ran (not "not_run").
    expect(report.visualClassificationStatus).not.toBe("not_run");

    // Debug artifacts must be present
    expect(report.debugSummary).toBeDefined();
    expect(report.runArtifacts.some((a: { role: string }) => a.role === "audit_trace")).toBe(true);
    expect(report.runArtifacts.some((a: { role: string }) => a.role === "coverage_trace")).toBe(true);
    expect(report.runArtifacts.some((a: { role: string }) => a.role === "recovery_trace")).toBe(true);
    expect(report.runArtifacts.some((a: { role: string }) => a.role === "debug_summary")).toBe(true);

    const sidecarCalls = mockFetch.mock.calls.filter(([url]) =>
      typeof url === "string" && url.includes("/v1/locate-ui-elements")
    );
    expect(sidecarCalls).toHaveLength(1);
    const firstSidecarBody = JSON.parse(String(sidecarCalls[0]?.[1]?.body)) as { queries: unknown[] };
    expect(firstSidecarBody.queries).toHaveLength(8);
  });

  it("returns model_unavailable when required models are not_checked", async () => {
    const { expected, actual } = await writeTwoButtonFixture(
      tmpDir, "e.png", "a.png"
    );

    const probeOverride = async () => [
      { role: "auditor", provider: "openrouter", model: "qwen/qwen3-vl-30b-a3b-instruct", status: "not_checked" as const, checkedAt: new Date().toISOString(), detail: "No API key provided" },
      { role: "reviewer", provider: "openrouter", model: "google/gemini-2.5-flash-lite", status: "not_checked" as const, checkedAt: new Date().toISOString(), detail: "No API key provided" }
    ];

    const mockFetch = makeMockFetch([]);
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", "http://127.0.0.1:9999");

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "full"
    }, { probeOverride });

    expect(result.status).toBe("model_unavailable");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("No visual model passed the required image/schema probes")
      ])
    );
  });

  it("keeps visualClassificationStatus incomplete when locator fails even if models pass", async () => {
    const { expected, actual } = await writeTwoButtonFixture(
      tmpDir, "e.png", "a.png"
    );

    const probeOverride = async () => [
      { role: "auditor", provider: "openrouter", model: "qwen/qwen3-vl-30b-a3b-instruct", status: "pass" as const, checkedAt: new Date().toISOString() },
      { role: "reviewer", provider: "openrouter", model: "google/gemini-2.5-flash-lite", status: "pass" as const, checkedAt: new Date().toISOString() }
    ];

    // No fetch mock — locator points at a dead port so sidecar call fails
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", "http://127.0.0.1:9999");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "full"
    }, { probeOverride });

    expect(result.status).toBe("model_unavailable");
    const reportRaw = await import("node:fs/promises").then(fs => fs.readFile(result.reportPath, "utf8"));
    const report = JSON.parse(reportRaw) as { visualClassificationStatus: string };
    expect(report.visualClassificationStatus).toBe("incomplete");
  });
});

describe("runUiDiff auditScope.vlmAuditedPairs pipeline accounting", () => {
  it("populates vlmAuditedPairs and preAuditDeterministicPairs that account for all paired elements", async () => {
    // Both images are identical solid gray — detectProjectedCropMismatch finds no mismatches, so
    // all projected pairs pass pre-audit and reach the VLM auditor. This directly exercises the
    // accounting that sets report.auditScope.vlmAuditedPairs and preAuditDeterministicPairs.
    const expected = await writeSolidPng(tmpDir, "e.png", 200, 400, 200, 200, 200);
    const actual = await writeSolidPng(tmpDir, "a.png", 200, 400, 200, 200, 200);

    sidecar = await startMockSidecar({ imageWidth: 200, imageHeight: 400 });

    const mockFetch = makeMockFetch([
      { criterion: "geometry", hasDiff: true, severity: "medium", title: "Button shifted",
        evidence: ["visible shift"], reviewerDecision: "accepted" }
    ], { sidecarImageWidth: 200, sidecarImageHeight: 400 });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecar.url);
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-accounting");

    const probeOverride = async () => [
      { role: "auditor", provider: "openrouter", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        status: "pass" as const, checkedAt: new Date().toISOString(), schemaValid: true, contentAccurate: true, maxImagesSupported: 5 },
      { role: "reviewer", provider: "openrouter", model: "nex-agi/nex-n2-pro:free",
        status: "pass" as const, checkedAt: new Date().toISOString(), schemaValid: true, contentAccurate: true, maxImagesSupported: 5 }
    ];

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "full"
    }, { probeOverride });

    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as {
      auditScope?: {
        vlmAuditedPairs?: number;
        preAuditDeterministicPairs?: number;
        totalPairs: number;
      };
      projectedPreAudit?: {
        projectedPairsChecked: number;
        deterministicProjectedDiffs: number;
        sentToVlmPairs: number;
      };
    };

    const vlm = report.auditScope?.vlmAuditedPairs ?? 0;
    const preAudit = report.auditScope?.preAuditDeterministicPairs ?? 0;
    const total = report.auditScope?.totalPairs ?? 0;

    expect(vlm).toBeGreaterThan(0);
    expect(report.auditScope?.preAuditDeterministicPairs).toBeDefined();
    // Pre-audit + VLM must exhaust all paired candidates
    expect(vlm + preAudit).toBe(total);
    expect(report.projectedPreAudit).toBeDefined();
    // Identical-content crops produce 0 pre-audit mismatches; all pairs forwarded to VLM
    expect(report.projectedPreAudit?.deterministicProjectedDiffs).toBe(0);
    expect(report.projectedPreAudit?.sentToVlmPairs).toBe(total);
  });
});

describe("runUiDiff viewport mismatch detection", () => {
  it("reports mismatch status and warning when actual image has different aspect ratio", async () => {
    const { writeMismatchedDimensionFixture } = await import("../../src/testing/fixture-images.js");
    const { expected, actual } = await writeMismatchedDimensionFixture(
      tmpDir, "expected-dim.png", "actual-dim.png"
    );

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only"
    });

    expect(result.status).toBe("complete");
    const reportRaw = await fs.readFile(result.reportPath, "utf8");
    const report = JSON.parse(reportRaw) as {
      viewportCompatibilityStatus?: string;
      viewportCompatibilityReasons?: string[];
      warnings: string[];
    };
    expect(report.viewportCompatibilityStatus).toBe("mismatch");
    expect(report.warnings.some(w => w.includes("[viewport-mismatch]"))).toBe(true);
  });
});
