import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUiDiff } from "../../src/pipeline/run-ui-diff.js";
import { hydrateReportParts } from "../../src/report/report-parts.js";
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

/** Sidecar that returns different elements per request to produce missing/extra pairs. */
function startPresenceSidecar(): Promise<{ url: string; stop: () => Promise<void> }> {
  let requestCount = 0;
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ready: true, error: null }));
        return;
      }
      if (req.method === "POST" && req.url === "/v1/locate-ui-elements") {
        req.resume();
        req.on("end", () => {
          requestCount++;
          // First request: expected image — return Header + Button + MissingTarget
          // Second request: actual image — return Header + Button + ExtraTarget
          // This produces 2 matched pairs, 1 missing pair, 1 extra pair.
          const elements = requestCount <= 1
            ? [
                { queryId: "text", label: "Header", box: { x: 10, y: 10, width: 80, height: 20 }, rawBox1000: [50, 25, 400, 50], confidence: 0.95 },
                { queryId: "button", label: "Button", box: { x: 20, y: 60, width: 60, height: 20 }, rawBox1000: [100, 150, 300, 50], confidence: 0.91 },
                { queryId: "text", label: "MissingTarget", box: { x: 30, y: 100, width: 50, height: 15 }, rawBox1000: [150, 250, 250, 37], confidence: 0.88 }
              ]
            : [
                { queryId: "text", label: "Header", box: { x: 10, y: 10, width: 80, height: 20 }, rawBox1000: [50, 25, 400, 50], confidence: 0.95 },
                { queryId: "button", label: "Button", box: { x: 20, y: 60, width: 60, height: 20 }, rawBox1000: [100, 150, 300, 50], confidence: 0.91 },
                { queryId: "icon", label: "ExtraTarget", box: { x: 40, y: 120, width: 30, height: 30 }, rawBox1000: [200, 300, 150, 75], confidence: 0.87 }
              ];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            model: "test-locator",
            image: { width: 200, height: 400 },
            elements,
            warnings: []
          }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") { reject(new Error("bind")); return; }
      resolve({ url: `http://127.0.0.1:${addr.port}`, stop: () => new Promise(r => srv.close(() => r())) });
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

  it("missing/extra pairs are deterministic_presence, never enter audit trace, and accounting is exact", async () => {
    const expected = await writeSolidPng(tmpDir, "expected.png", 200, 400, 128, 128, 128);
    const actual = await writeSolidPng(tmpDir, "actual.png", 200, 400, 128, 128, 128);
    const presence = await startPresenceSidecar();
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", presence.url);
    vi.stubEnv("UI_DIFF_DUAL_LOCATOR", "1");
    vi.stubEnv("UI_DIFF_ALLOW_DUAL_LOCATOR", "1");
    vi.stubEnv("UI_DIFF_DUAL_LOCATOR_REASON", "presence pair regression");

    try {
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

      const rawReport = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
      const report = await hydrateReportParts(rawReport, result.reportPath) as {
        diffs: Array<{ classificationSource?: string; criterion: string; pairId?: string; title: string }>;
        pairs: Array<{ id: string; status: string }>;
        auditScope?: {
          totalPairs: number;
          selectedPairs: number;
          preAuditDeterministicPairs?: number;
          providerCalledPairs: number;
          failedPairs: number;
        };
        runArtifacts: Array<{ role: string; path: string }>;
      };

      // Verify pair composition: exactly 2 matched, 1 missing, 1 extra
      const matchedPairs = report.pairs.filter(p => p.status === "matched");
      const missingPairs = report.pairs.filter(p => p.status === "missing");
      const extraPairs = report.pairs.filter(p => p.status === "extra");
      expect(matchedPairs.length).toBe(2);
      expect(missingPairs.length).toBe(1);
      expect(extraPairs.length).toBe(1);

      // Build presencePairIds from missing/extra
      const presencePairIds = new Set([
        ...missingPairs.map(p => p.id),
        ...extraPairs.map(p => p.id)
      ]);

      // Verify exactly 2 deterministic_presence diffs and their pairIds match presencePairIds
      const presenceDiffs = report.diffs.filter(d => d.classificationSource === "deterministic_presence");
      expect(presenceDiffs.length).toBe(2);
      const presenceDiffPairIds = new Set(presenceDiffs.map(d => d.pairId));
      expect(presenceDiffPairIds).toEqual(presencePairIds);
      for (const diff of presenceDiffs) {
        expect(diff.criterion).toBe("presence");
      }

      // Read audit_trace and assert no trace entry pairId is in presencePairIds
      const auditTraceArtifact = report.runArtifacts.find(a => a.role === "audit_trace");
      expect(auditTraceArtifact).toBeDefined();
      const auditTrace = JSON.parse(await fs.readFile(auditTraceArtifact!.path, "utf8")) as Array<{ pairId: string }>;
      for (const entry of auditTrace) {
        expect(presencePairIds.has(entry.pairId)).toBe(false);
      }

      // Assert auditScope exact values and conservation
      const scope = report.auditScope!;
      expect(scope.totalPairs).toBe(4);
      expect(scope.selectedPairs).toBe(2);
      expect(scope.preAuditDeterministicPairs).toBeDefined();
      expect(scope.preAuditDeterministicPairs).toBe(2);
      expect(scope.providerCalledPairs).toBe(0);
      // Conservation: total == selected + preAuditDeterministic
      expect(scope.selectedPairs + scope.preAuditDeterministicPairs!).toBe(scope.totalPairs);
    } finally {
      await presence.stop();
    }
  });
});
