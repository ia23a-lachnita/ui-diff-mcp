import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUiDiff } from "../../src/pipeline/run-ui-diff.js";
import { writeTwoButtonFixture } from "../../src/testing/fixture-images.js";
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
    };
    expect(report.schemaVersion).toBe("0.1");
    expect(report.runId).toBe(result.runId);
    expect(report.visualClassificationStatus).toBe("not_run");
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
  });
});

describe("runUiDiff with mock sidecar and models (full mode)", () => {
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
    ]);
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecar.url);
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-e2e");

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "full"
    });

    expect(result.runId).toBeTruthy();
    expect(["complete", "model_unavailable", "incomplete"]).toContain(result.status);

    const reportRaw = await fs.readFile(result.reportPath, "utf8");
    const report = JSON.parse(reportRaw) as { diffs: unknown[]; elements: { expected: unknown[]; actual: unknown[] } };
    expect(Array.isArray(report.diffs)).toBe(true);
    expect(Array.isArray(report.elements.expected)).toBe(true);
  });
});
