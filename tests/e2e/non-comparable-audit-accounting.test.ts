import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUiDiff } from "../../src/pipeline/run-ui-diff.js";
import { writeSolidPng } from "../../src/testing/fixture-images.js";

let tmpDir: string;
let server: http.Server | undefined;

function startNonComparableSidecar(): Promise<string> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ready: true, error: null }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/locate-ui-elements") {
        req.resume();
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            model: "test-locator",
            image: { width: 1080, height: 2400 },
            elements: [{
              queryId: "text",
              label: "Margin-only target",
              box: { x: 0, y: 100, width: 2, height: 20 },
              rawBox1000: [0, 42, 2, 8],
              confidence: 0.9
            }],
            warnings: []
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") {
        reject(new Error("sidecar did not bind"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("runUiDiff non-comparable audit accounting", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-non-comparable-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("marks a selected non-comparable pair failed instead of an ordinary no-trigger skip", async () => {
    const expected = await writeSolidPng(tmpDir, "expected.png", 402, 874, 128, 128, 128);
    const actual = await writeSolidPng(tmpDir, "actual.png", 1080, 2400, 128, 128, 128);
    const sidecarUrl = await startNonComparableSidecar();
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecarUrl);

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "full"
    }, {
      probeOverride: async entries => entries.map(entry => ({
        role: entry.role,
        provider: entry.provider,
        model: entry.model,
        status: "pass" as const,
        checkedAt: new Date().toISOString(),
        schemaValid: true,
        contentAccurate: true,
        maxImagesSupported: 5
      }))
    });

    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as {
      visualClassificationStatus: string;
      auditScope?: { selectedPairs?: number; failedPairs?: number; providerCalledPairs?: number; skippedNoTriggeredPairs?: number };
      stages: Array<{ name: string; outcome: string }>;
      runArtifacts: Array<{ role: string; path: string }>;
    };
    const auditTraceArtifact = report.runArtifacts.find(artifact => artifact.role === "audit_trace");
    expect(auditTraceArtifact).toBeDefined();
    const auditTrace = JSON.parse(await fs.readFile(auditTraceArtifact!.path, "utf8")) as Array<{ status: string; skipReason?: string }>;

    expect(report.auditScope?.selectedPairs).toBeGreaterThan(0);
    expect(report.auditScope?.providerCalledPairs).toBe(0);
    expect(report.auditScope?.failedPairs).toBeGreaterThan(0);
    expect(report.auditScope?.skippedNoTriggeredPairs).toBe(0);
    expect(auditTrace).toContainEqual(expect.objectContaining({ status: "comparison_non_comparable", skipReason: "no_comparable_intersection" }));
    expect(report.stages.find(stage => stage.name === "audit")?.outcome).toBe("incomplete");
    expect(report.visualClassificationStatus).toBe("incomplete");
  });
});
