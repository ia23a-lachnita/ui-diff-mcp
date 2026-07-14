import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUiDiff } from "../../src/pipeline/run-ui-diff.js";
import { hydrateReportParts } from "../../src/report/report-parts.js";
import { buildRuntimeModelUsageLedger } from "../../src/debug/provider-trace.js";
import { buildUsageSummaryFromLedger } from "../../src/debug/usage-summary.js";
import { writeTwoButtonFixture, writeSolidPng, writeRectPng } from "../../src/testing/fixture-images.js";
import { startMockSidecar } from "../fixtures/mock-sidecar.js";
import { makeMockFetch } from "../fixtures/mock-models.js";
import type { MockSidecar } from "../fixtures/mock-sidecar.js";

vi.mock("../../src/diff/projected-preaudit.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/diff/projected-preaudit.js")>();
  return { ...actual, runProjectedPreAudit: vi.fn(actual.runProjectedPreAudit) };
});

vi.mock("../../src/diff/deterministic-diffs.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/diff/deterministic-diffs.js")>();
  return { ...actual, buildDeterministicDiffs: vi.fn(actual.buildDeterministicDiffs) };
});

vi.mock("../../src/report/context-overlays.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../src/report/context-overlays.js")>();
  return { ...actual, buildFindingGroups: vi.fn(actual.buildFindingGroups) };
});

import { runProjectedPreAudit } from "../../src/diff/projected-preaudit.js";
import { buildDeterministicDiffs } from "../../src/diff/deterministic-diffs.js";
import { buildFindingGroups } from "../../src/report/context-overlays.js";

let tmpDir: string;
let sidecar: MockSidecar;

type FinalArtifactReport = {
  comparisonSpace: { width: number; height: number };
  diffs: Array<{ id: string; location: { x: number; y: number; width: number; height: number }; coordinateSpace?: string; repairLocality?: string }>;
  geometryDiagnostics?: { countsByReason: Record<string, number>; countsByProducer: Record<string, Record<string, number>>; references: unknown[] };
  inputProvenance?: { identity: { expected: { sha256: string }; actual: { sha256: string } } };
  runArtifacts: Array<{ role: string; path: string }>;
};

type FinalGroupLegend = {
  groups: Array<{
    id: string;
    box: { x: number; y: number; width: number; height: number };
    diffIds: string[];
    coordinateSpace?: string;
    zoomStatus: "valid" | "rejected" | "skipped";
    zoomArtifact?: string;
  }>;
};

type HierarchyLegend = {
  nodes: Array<{
    id: string;
    box: { x: number; y: number; width: number; height: number };
    coordinateSpace?: string;
  }>;
};

function makeProbeSseResponse(jsonContent: string, model: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode([
        `data: ${JSON.stringify({ model, choices: [{ delta: { content: jsonContent } }] })}`,
        "data: [DONE]",
        ""
      ].join("\n")));
      controller.close();
    }
  });
  return { ok: true, status: 200, body } as Response;
}

function probeImageCount(body: Record<string, unknown>): number {
  const geminiParts = (body.contents as Array<{ parts?: Array<Record<string, unknown>> }> | undefined)
    ?.flatMap(content => content.parts ?? []);
  if (geminiParts) {
    return geminiParts.filter(part => "inlineData" in part).length;
  }

  const content = ((body.messages as Array<{ content?: unknown }> | undefined)?.[0]?.content);
  return Array.isArray(content)
    ? content.filter(part => typeof part === "object" && part !== null && (part as { type?: string }).type === "image_url").length
    : 0;
}

function makeSuccessfulProbeFetch(
  fallback: (url: unknown, init?: RequestInit) => Promise<unknown>,
  providerRequests: string[]
): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: unknown, init?: RequestInit) => {
    if (typeof url !== "string") return fallback(url, init);

    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const imageCount = body === undefined ? 0 : probeImageCount(body);
    const probeResult = JSON.stringify({ imageCount, hasBlueImage: true });

    if (url.includes("gemini.test")) {
      providerRequests.push("gemini");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          candidates: [{ content: { parts: [{ text: probeResult }] }, finishReason: "STOP" }]
        })
      } as Response);
    }
    if (url.includes("mistral.test")) {
      providerRequests.push("mistral");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          choices: [{ message: { content: probeResult }, finish_reason: "stop" }]
        })
      } as Response);
    }
    if (url.includes("opencode.test")) {
      providerRequests.push("opencode");
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          choices: [{ message: { content: probeResult }, finish_reason: "stop" }]
        })
      } as Response);
    }
    if (url.includes("nvidia.test")) {
      providerRequests.push("nvidia");
      return Promise.resolve(makeProbeSseResponse(probeResult, "fake-nvidia"));
    }
    if (url.includes("openrouter.ai/api/v1/chat/completions")) {
      providerRequests.push("openrouter");
      return Promise.resolve(makeProbeSseResponse(probeResult, "fake-openrouter"));
    }

    return fallback(url, init);
  });
}

function expectCanonicalBox(
  box: { x: number; y: number; width: number; height: number },
  canvas: { width: number; height: number }
): void {
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.x + box.width).toBeLessThanOrEqual(canvas.width);
  expect(box.y + box.height).toBeLessThanOrEqual(canvas.height);
}

async function expectFinalArtifactManifest(report: FinalArtifactReport): Promise<void> {
  expect(report.inputProvenance?.identity.expected.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.inputProvenance?.identity.actual.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.geometryDiagnostics).toEqual(expect.objectContaining({
    countsByReason: expect.any(Object),
    countsByProducer: expect.any(Object),
    references: expect.any(Array)
  }));

  for (const diff of report.diffs) {
    expect(diff.coordinateSpace).toBe("comparison_expected_normalized");
    expect(diff.repairLocality).toBe("local");
    expectCanonicalBox(diff.location, report.comparisonSpace);
  }

  const groupLegendArtifact = report.runArtifacts.find(artifact => artifact.role === "final_diff_groups_legend");
  const hierarchyLegendArtifact = report.runArtifacts.find(artifact => artifact.role === "semantic_hierarchy_legend");
  expect(groupLegendArtifact).toBeDefined();
  expect(hierarchyLegendArtifact).toBeDefined();

  const groupLegend = JSON.parse(await fs.readFile(groupLegendArtifact!.path, "utf8")) as FinalGroupLegend;
  const hierarchyLegend = JSON.parse(await fs.readFile(hierarchyLegendArtifact!.path, "utf8")) as HierarchyLegend;
  const groupedDiffIds = groupLegend.groups.flatMap(group => group.diffIds).sort();
  expect(groupedDiffIds).toEqual(report.diffs.map(diff => diff.id).sort());

  const listedZoomArtifacts = new Set(report.runArtifacts
    .filter(artifact => artifact.role === "final_diff_zoom")
    .map(artifact => artifact.path));
  for (const group of groupLegend.groups) {
    expect(group.coordinateSpace).toBe("comparison_expected_normalized");
    expectCanonicalBox(group.box, report.comparisonSpace);
    if (group.zoomStatus === "valid") {
      expect(group.zoomArtifact).toBeDefined();
      expect(listedZoomArtifacts.has(group.zoomArtifact!)).toBe(true);
      const metadata = await sharp(group.zoomArtifact!).metadata();
      expect(metadata.width).toBeGreaterThanOrEqual(2);
      expect(metadata.height).toBeGreaterThanOrEqual(2);
    } else {
      expect(group.zoomArtifact).toBeUndefined();
    }
  }
  expect(listedZoomArtifacts).toEqual(new Set(groupLegend.groups
    .filter(group => group.zoomStatus === "valid")
    .map(group => group.zoomArtifact)));

  expect(hierarchyLegend.nodes.length).toBeGreaterThan(0);
  for (const node of hierarchyLegend.nodes) {
    expect(node.coordinateSpace).toBe("comparison_expected_normalized");
    expectCanonicalBox(node.box, report.comparisonSpace);
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-e2e-"));
});

afterEach(async () => {
  const actualDeterministic = await vi.importActual<typeof import("../../src/diff/deterministic-diffs.js")>("../../src/diff/deterministic-diffs.js");
  const actualContextOverlays = await vi.importActual<typeof import("../../src/report/context-overlays.js")>("../../src/report/context-overlays.js");
  vi.mocked(buildDeterministicDiffs).mockImplementation(actualDeterministic.buildDeterministicDiffs);
  vi.mocked(buildFindingGroups).mockImplementation(actualContextOverlays.buildFindingGroups);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (sidecar) await sidecar.stop();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runUiDiff end-to-end (deterministic_only mode)", () => {
  it.each([
    ["auto-captured actual", "auto_capture"],
    ["explicit actual override", "env_override"]
  ] as const)("persists computed identities and %s caller attestation in report.json", async (_label, actualSource) => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, `provenance-${actualSource}-e.png`, `provenance-${actualSource}-a.png`);
    const expectedHash = crypto.createHash("sha256").update(await fs.readFile(expected)).digest("hex");
    const actualHash = crypto.createHash("sha256").update(await fs.readFile(actual)).digest("hex");

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      inputProvenance: {
        acquisition: {
          expected: { source: "canonical_default", verification: "caller_attested" },
          actual: { source: actualSource, verification: "caller_attested" }
        }
      }
    });

    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as { inputProvenance?: unknown };
    expect(report.inputProvenance).toEqual({
      identity: {
        expected: { sha256: expectedHash },
        actual: { sha256: actualHash }
      },
      acquisition: {
        expected: { source: "canonical_default", verification: "caller_attested" },
        actual: { source: actualSource, verification: "caller_attested" }
      }
    });
  });

  it("verifies a canonical manifest entry against the computed expected bytes", async () => {
    const expected = path.join(tmpDir, "today--dark.png");
    await fs.copyFile("C:/Users/xursc/projects/calorix/docs/design-handoff/placeholder-app/reference-images/today--dark.png", expected);
    const actual = await writeSolidPng(tmpDir, "manifest-actual.png", 402, 874, 30, 40, 50);
    const manifestPath = path.join(tmpDir, "reference-images-manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({
      reference_images: [{
        filename: "today--dark.png",
        sha256: "73ba85f25489c8d45beab57dd1b317138870ce8360fe0f4399ab0737a5e505f1"
      }]
    }));

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      inputProvenance: {
        acquisition: {
          expected: { source: "canonical_default", verification: "caller_attested" },
          actual: { source: "auto_capture", verification: "caller_attested" }
        },
        expectedManifestPath: manifestPath
      }
    });
    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as { inputProvenance: { identity: { expected: { manifest?: unknown } } } };
    expect(report.inputProvenance.identity.expected.manifest).toEqual({
      path: manifestPath,
      entryFilename: "today--dark.png",
      entrySha256: "73ba85f25489c8d45beab57dd1b317138870ce8360fe0f4399ab0737a5e505f1",
      verification: "verified_against_expected_bytes"
    });
  });

  it("rejects a manifest entry whose declared hash disagrees with expected bytes", async () => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "manifest-mismatch-e.png", "manifest-mismatch-a.png");
    const manifestPath = path.join(tmpDir, "reference-images-manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify({
      reference_images: [{ filename: path.basename(expected), sha256: "0".repeat(64) }]
    }));

    await expect(runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      inputProvenance: { expectedManifestPath: manifestPath }
    })).rejects.toThrow(/manifest.*hash/i);
  });

  it("writes computed input provenance to every checkpoint", async () => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "checkpoint-provenance-e.png", "checkpoint-provenance-a.png");
    const expectedHash = crypto.createHash("sha256").update(await fs.readFile(expected)).digest("hex");
    const actualHash = crypto.createHash("sha256").update(await fs.readFile(actual)).digest("hex");
    const checkpointProvenance: unknown[] = [];

    await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      inputProvenance: {
        acquisition: {
          expected: { source: "canonical_default", verification: "caller_attested" },
          actual: { source: "auto_capture", verification: "caller_attested" }
        }
      },
      onCheckpoint: async ({ checkpointPath }) => {
        const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as { inputProvenance?: unknown };
        checkpointProvenance.push(checkpoint.inputProvenance);
      }
    });

    expect(checkpointProvenance.length).toBeGreaterThan(0);
    expect(checkpointProvenance).toContainEqual({
      identity: { expected: { sha256: expectedHash }, actual: { sha256: actualHash } },
      acquisition: {
        expected: { source: "canonical_default", verification: "caller_attested" },
        actual: { source: "auto_capture", verification: "caller_attested" }
      }
    });
  });

  it("preserves thin recovery evidence without reporting an artifact geometry rejection", async () => {
    const expected = await writeSolidPng(tmpDir, "rejected-evidence-expected.png", 200, 400, 255, 255, 255);
    const actualBase = await writeSolidPng(tmpDir, "rejected-evidence-actual-base.png", 200, 400, 255, 255, 255);
    const actual = path.join(tmpDir, "rejected-evidence-actual.png");
    await sharp(actualBase)
      .composite([{ input: { create: { width: 1, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }, left: 20, top: 20 }])
      .png()
      .toFile(actual);
    const checkpointDiagnostics: unknown[] = [];

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      onCheckpoint: async ({ checkpointPath }) => {
        const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as { geometryDiagnostics?: unknown };
        checkpointDiagnostics.push(checkpoint.geometryDiagnostics);
      }
    });

    expect(checkpointDiagnostics.length).toBeGreaterThan(0);
    expect(checkpointDiagnostics.every(diagnostics => diagnostics !== undefined)).toBe(true);
    const rawReport = JSON.parse(await fs.readFile(result.reportPath, "utf8"));
    const report = await hydrateReportParts(rawReport, result.reportPath);

    expect(report.geometryDiagnostics?.countsByProducer["recovery_artifact_backfill"]).toBeUndefined();
    const thinRegion = report.unresolvedRegions.find(region => region.location.width === 1 && region.location.height === 50);
    expect(thinRegion).toMatchObject({ reason: "not_classified", location: { x: 20, y: 20, width: 1, height: 50 } });
    expect(thinRegion?.artifactPaths.map(artifact => artifact.role).sort()).toEqual([
      "recovery_actual_crop",
      "recovery_directional_overlay",
      "recovery_expected_crop",
      "recovery_pixel_diff_mask"
    ]);
    for (const artifact of thinRegion!.artifactPaths) {
      await expect(sharp(artifact.path).metadata()).resolves.toMatchObject({ width: 2, height: 50 });
    }
  });

  it("accounts for rejected projected-group crops in checkpoints and the final report", async () => {
    const expected = await writeSolidPng(tmpDir, "rejected-group-expected.png", 200, 400, 255, 255, 255);
    const actual = await writeSolidPng(tmpDir, "rejected-group-actual.png", 200, 400, 255, 255, 255);
    const groupId = "displacement-rejected-group";
    vi.mocked(runProjectedPreAudit).mockResolvedValueOnce({
      diffs: [],
      skipVlmPairIds: new Set(),
      summary: {
        projectedPairsChecked: 0,
        deterministicProjectedDiffs: 0,
        sentToVlmPairs: 0,
        skippedFromVlmPairIds: [],
        uniqueDisplacements: 0,
        displacementGroups: 0,
        structuralMismatchGroups: 0,
        groupedPairs: 0
      },
      geometryRejections: [{
        producer: "projected_pre_audit",
        reason: "disjoint",
        reference: `finding-group:${groupId}`
      }]
    });
    const checkpointDiagnostics: Array<{ countsByReason: Record<string, number>; countsByProducer: Record<string, Record<string, number>>; references: Array<{ reference: string }> }> = [];

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      onCheckpoint: async ({ checkpointPath }) => {
        const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8")) as { geometryDiagnostics: typeof checkpointDiagnostics[number] };
        checkpointDiagnostics.push(checkpoint.geometryDiagnostics);
      }
    });

    expect(checkpointDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        countsByReason: expect.objectContaining({ disjoint: 1 }),
        countsByProducer: expect.objectContaining({ projected_pre_audit: expect.objectContaining({ disjoint: 1 }) }),
        references: expect.arrayContaining([expect.objectContaining({ reference: `finding-group:${groupId}` })])
      })
    ]));
    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as { geometryDiagnostics: typeof checkpointDiagnostics[number] };
    expect(report.geometryDiagnostics).toMatchObject({
      countsByReason: { disjoint: 1 },
      countsByProducer: { projected_pre_audit: { disjoint: 1 } },
      references: [{ producer: "projected_pre_audit", reason: "disjoint", reference: `finding-group:${groupId}` }]
    });
  });

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
    const rawReport = JSON.parse(reportRaw) as {
      schemaVersion: string;
      runId: string;
      status: string;
      visualClassificationStatus: string;
      runArtifacts: Array<{ role: string }>;
      stages: Array<{ name: string; status: string; outcome: string }>;
      unresolvedRegions: Array<{ artifactPaths: unknown[] }>;
    };
    const report = await hydrateReportParts(rawReport as Parameters<typeof hydrateReportParts>[0], result.reportPath) as typeof rawReport;
    expect(report.schemaVersion).toBe("0.1");
    expect(report.runId).toBe(result.runId);
    expect(report.visualClassificationStatus).toBe("not_run");
    expect(report.unresolvedRegions.length).toBeGreaterThan(0);
    expect(report.unresolvedRegions.every(region => region.artifactPaths.length === 4)).toBe(true);
    const artifactRoles = (report as unknown as { runArtifacts: Array<{ role: string }> }).runArtifacts.map(artifact => artifact.role);
    expect(artifactRoles).toEqual(expect.arrayContaining([
      "region_context_overlay",
      "unresolved_regions_overlay",
      "final_diff_regions_overlay"
    ]));
    const stageMap = Object.fromEntries((report as unknown as { stages: Array<{ name: string; status: string; outcome: string }> }).stages
      .map(stage => [stage.name, stage]));
    for (const name of ["model_probe", "audit", "target_recovery"]) {
      expect(stageMap[name]).toMatchObject({ status: "skipped", outcome: "not_applicable" });
    }
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
      inputProvenance: {
        acquisition: {
          expected: { source: "canonical_default", verification: "caller_attested" },
          actual: { source: "auto_capture", verification: "caller_attested" }
        }
      },
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
    expect((report as typeof report & { inputProvenance?: unknown }).inputProvenance).toEqual(checkpoint["inputProvenance"]);
  });

  it("reconciles only valid provider lifecycles across persisted, hydrated, and compact output", async () => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "resume-trace-e.png", "resume-trace-a.png");
    const first = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      runId: "run-resume-trace"
    });
    const checkpoint = JSON.parse(await fs.readFile(first.reportPath, "utf8")) as Record<string, unknown>;
    checkpoint["status"] = "interrupted";
    checkpoint["isCheckpoint"] = true;
    await fs.writeFile(first.reportPath, JSON.stringify(checkpoint), "utf8");
    await fs.writeFile(path.join(first.artifactRoot, "provider-trace.json"), JSON.stringify([
      {
        eventId: "persisted-audit-start",
        callId: "persisted-audit-call",
        phase: "audit",
        event: "call_start",
        role: "auditor",
        provider: "gemini",
        model: "gemini-3.5-flash",
        modelFamilyKey: "gemini-3.5-flash"
      },
      {
        eventId: "persisted-audit-success",
        callId: "persisted-audit-call",
        phase: "audit",
        event: "call_success",
        role: "auditor",
        provider: "gemini",
        model: "gemini-3.5-flash",
        modelFamilyKey: "gemini-3.5-flash",
        status: "ok",
        totalTokens: 20
      },
      {
        eventId: "orphan-success-with-tokens",
        callId: "orphan-call",
        phase: "audit",
        event: "call_success",
        role: "auditor",
        provider: "gemini",
        model: "gemini-3.5-flash",
        modelFamilyKey: "gemini-3.5-flash",
        status: "ok",
        totalTokens: 200
      },
      {
        eventId: "mismatched-route-start",
        callId: "mismatched-route-call",
        phase: "audit",
        event: "call_start",
        role: "auditor",
        provider: "gemini",
        model: "gemini-3.5-flash",
        modelFamilyKey: "gemini-3.5-flash"
      },
      {
        eventId: "mismatched-route-success-with-tokens",
        callId: "mismatched-route-call",
        phase: "audit",
        event: "call_success",
        role: "reviewer",
        provider: "gemini",
        model: "gemini-3.5-flash",
        modelFamilyKey: "gemini-3.5-flash",
        status: "ok",
        totalTokens: 300
      },
      {
        eventId: "mismatched-status-start",
        callId: "mismatched-status-call",
        phase: "audit",
        event: "call_start",
        role: "auditor",
        provider: "gemini",
        model: "gemini-3.5-flash",
        modelFamilyKey: "gemini-3.5-flash"
      },
      {
        eventId: "mismatched-status-success-with-tokens",
        callId: "mismatched-status-call",
        phase: "audit",
        event: "call_success",
        role: "auditor",
        provider: "gemini",
        model: "gemini-3.5-flash",
        modelFamilyKey: "gemini-3.5-flash",
        status: "error",
        totalTokens: 400
      }
    ]), "utf8");

    const resumed = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      resumeRunId: "run-resume-trace"
    });
    const rawReport = JSON.parse(await fs.readFile(resumed.reportPath, "utf8")) as {
      runtimeModelUsage?: Array<{ phase: string; role: string; provider: string; model: string; callStartCount: number; callSuccessCount: number; totalTokens?: number }>;
      runtimeModelUsageDiagnostics?: unknown;
      usageSummary?: { calls: number; totalTokens: number; successesWithUsage: number; successesMissingUsage: number; errorCalls: number };
      runArtifacts: Array<{ role: string; path: string }>;
    };
    const report = await hydrateReportParts(rawReport as Parameters<typeof hydrateReportParts>[0], resumed.reportPath) as typeof rawReport;
    const compact = resumed as typeof resumed & {
      runtimeModelUsage?: typeof report.runtimeModelUsage;
      runtimeModelUsageDiagnostics?: typeof report.runtimeModelUsageDiagnostics;
      usageSummary?: typeof report.usageSummary;
    };

    expect(report.runtimeModelUsage).toEqual([{
      phase: "audit", role: "auditor", provider: "gemini", model: "gemini-3.5-flash",
      callStartCount: 3, callSuccessCount: 1, callErrorCount: 0, fallbackCount: 0,
      incompleteStartedCallCount: 2, successesWithUsage: 1, successesMissingUsage: 0, totalTokens: 20
    }]);
    expect(report.runtimeModelUsageDiagnostics).toEqual({
      orphanTerminalCount: 1,
      legacyUnmatchedLifecycleEventCount: 0,
      duplicateCallStartCount: 0,
      fallbackWithoutCallStartCount: 0,
      terminalRouteMismatchCount: 1,
      terminalStatusMismatchCount: 1
    });
    expect(report.usageSummary).toMatchObject({
      calls: 1,
      totalTokens: 20,
      successesWithUsage: 1,
      successesMissingUsage: 0,
      errorCalls: 0
    });
    expect(compact.runtimeModelUsage).toEqual(report.runtimeModelUsage);
    expect(compact.runtimeModelUsageDiagnostics).toEqual(report.runtimeModelUsageDiagnostics);
    expect(compact.usageSummary).toEqual(report.usageSummary);

    const traceArtifact = report.runArtifacts.find(artifact => artifact.role === "provider_trace");
    expect(traceArtifact).toBeDefined();
    const persistedTrace = JSON.parse(await fs.readFile(traceArtifact!.path, "utf8"));
    const ledger = buildRuntimeModelUsageLedger(persistedTrace);
    expect(ledger.usage).toEqual(report.runtimeModelUsage);
    expect(ledger.diagnostics).toEqual(report.runtimeModelUsageDiagnostics);
    expect(buildUsageSummaryFromLedger(ledger)).toEqual(report.usageSummary);
  });

  it("removes only orphaned direct-child zoom files from a resumed artifact directory", async () => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "rejected-zoom-e.png", "rejected-zoom-a.png");
    vi.mocked(buildFindingGroups).mockImplementation(diffs => [
      {
        id: "forced-rejected-group",
        box: { x: 1000, y: 1000, width: 20, height: 20 },
        diffIds: [diffs[0]?.id ?? "forced-rejected-diff"],
        criteria: ["geometry"],
        severity: "medium",
        label: "G1",
        retainedFindingIds: [],
        suppressions: [],
        targetIds: [],
        evidenceArea: 400,
        coherentDisplacementKey: undefined
      },
      {
        id: "valid-zoom-group",
        box: { x: 20, y: 20, width: 20, height: 20 },
        diffIds: [diffs[0]?.id ?? "valid-zoom-diff"],
        criteria: ["geometry"],
        severity: "medium",
        label: "G2",
        retainedFindingIds: [],
        suppressions: [],
        targetIds: [],
        evidenceArea: 400,
        coherentDisplacementKey: undefined
      }
    ]);

    const first = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      runId: "run-rejected-zoom"
    });
    const checkpoint = JSON.parse(await fs.readFile(first.reportPath, "utf8")) as Record<string, unknown>;
    checkpoint["status"] = "interrupted";
    checkpoint["isCheckpoint"] = true;
    await fs.writeFile(first.reportPath, JSON.stringify(checkpoint), "utf8");

    const staleShortZoomPath = path.join(first.artifactRoot, "final-diff-zoom-1.png");
    const staleLongZoomPath = path.join(first.artifactRoot, "final-diff-zoom-1234.png");
    const sentinelPath = path.join(first.artifactRoot, "unrelated-sentinel.txt");
    const nestedArtifactPath = path.join(first.artifactRoot, "nested-artifacts", "final-diff-zoom-1234.png");
    await fs.writeFile(staleShortZoomPath, "stale short zoom artifact", "utf8");
    await fs.writeFile(staleLongZoomPath, "stale long zoom artifact", "utf8");
    await fs.writeFile(sentinelPath, "leave this direct child alone", "utf8");
    await fs.mkdir(path.dirname(nestedArtifactPath), { recursive: true });
    await fs.writeFile(nestedArtifactPath, "leave this nested artifact alone", "utf8");

    const resumed = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      resumeRunId: "run-rejected-zoom"
    });
    const report = JSON.parse(await fs.readFile(resumed.reportPath, "utf8")) as {
      runArtifacts: Array<{ role: string; path: string }>;
    };
    const legendArtifact = report.runArtifacts.find(artifact => artifact.role === "final_diff_groups_legend");
    expect(legendArtifact).toBeDefined();
    const legend = JSON.parse(await fs.readFile(legendArtifact!.path, "utf8")) as FinalGroupLegend;
    expect(legend.groups).toContainEqual(expect.objectContaining({
      id: "forced-rejected-group",
      zoomStatus: "rejected"
    }));
    const validZoomGroup = legend.groups.find(group => group.id === "valid-zoom-group");
    expect(validZoomGroup).toMatchObject({ zoomStatus: "valid" });
    await expect(fs.access(validZoomGroup!.zoomArtifact!)).resolves.toBeUndefined();

    await expect(fs.access(staleShortZoomPath)).rejects.toThrow();
    await expect(fs.access(staleLongZoomPath)).rejects.toThrow();
    await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("leave this direct child alone");
    await expect(fs.readFile(nestedArtifactPath, "utf8")).resolves.toBe("leave this nested artifact alone");
    const validZoomNames = new Set(legend.groups
      .filter(group => group.zoomStatus === "valid")
      .map(group => path.basename(group.zoomArtifact!)));
    const scopedZoomNames = (await fs.readdir(resumed.artifactRoot, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^final-diff-zoom-\d+\.png$/.test(entry.name))
      .map(entry => entry.name);
    expect(new Set(scopedZoomNames)).toEqual(validZoomNames);
  });

  it("rejects a malformed explicit resume report without overwriting its checkpoint", async () => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "resume-invalid-e.png", "resume-invalid-a.png");
    const first = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      runId: "run-resume-invalid"
    });
    const malformed = "{ not valid report JSON";
    await fs.writeFile(first.reportPath, malformed, "utf8");

    await expect(runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      resumeRunId: "run-resume-invalid"
    })).rejects.toThrow(/resume.*invalid|resume.*hydrate/i);
    await expect(fs.readFile(first.reportPath, "utf8")).resolves.toBe(malformed);
  });

  it("rejects a malformed explicit resumed provider trace without overwriting artifacts", async () => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "resume-trace-invalid-e.png", "resume-trace-invalid-a.png");
    const first = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      runId: "run-resume-trace-invalid"
    });
    const checkpoint = JSON.parse(await fs.readFile(first.reportPath, "utf8")) as Record<string, unknown>;
    checkpoint["status"] = "interrupted";
    checkpoint["isCheckpoint"] = true;
    await fs.writeFile(first.reportPath, JSON.stringify(checkpoint), "utf8");
    const tracePath = path.join(first.artifactRoot, "provider-trace.json");
    const malformedTrace = "{ not valid trace JSON";
    const reportBefore = await fs.readFile(first.reportPath, "utf8");
    await fs.writeFile(tracePath, malformedTrace, "utf8");

    await expect(runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      resumeRunId: "run-resume-trace-invalid"
    })).rejects.toThrow(/resume.*provider trace|resume.*invalid/i);
    await expect(fs.readFile(first.reportPath, "utf8")).resolves.toBe(reportBefore);
    await expect(fs.readFile(tracePath, "utf8")).resolves.toBe(malformedTrace);
  });

  it("allows an explicit resumed attestation replacement only for identical image identities", async () => {
    const { expected, actual } = await writeTwoButtonFixture(tmpDir, "resume-provenance-e.png", "resume-provenance-a.png");
    const first = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      inputProvenance: {
        acquisition: {
          expected: { source: "canonical_default", verification: "caller_attested" },
          actual: { source: "auto_capture", verification: "caller_attested" }
        }
      },
      runId: "run-resume-provenance"
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
      resumeRunId: "run-resume-provenance",
      inputProvenance: {
        acquisition: {
          expected: { source: "env_override", verification: "caller_attested" },
          actual: { source: "env_override", verification: "caller_attested" }
        }
      }
    });
    const report = JSON.parse(await fs.readFile(resumed.reportPath, "utf8")) as { inputProvenance: { acquisition: unknown } };
    expect(report.inputProvenance.acquisition).toEqual({
      expected: { source: "env_override", verification: "caller_attested" },
      actual: { source: "env_override", verification: "caller_attested" }
    });

    const changedActual = await writeSolidPng(tmpDir, "resume-provenance-changed-a.png", 360, 800, 1, 2, 3);
    await expect(runUiDiff({
      expectedImagePath: expected,
      actualImagePath: changedActual,
      projectRoot: tmpDir,
      mode: "deterministic_only",
      resumeRunId: "run-resume-provenance",
      inputProvenance: {
        acquisition: {
          expected: { source: "env_override", verification: "caller_attested" },
          actual: { source: "env_override", verification: "caller_attested" }
        }
      }
    })).rejects.toThrow(/resumed input image identities/i);
  });
});

describe("runUiDiff with mock sidecar and models (full mode)", () => {
  it("deduplicates exact logical probe tuples before persisting model health", async () => {
    const expected = await writeSolidPng(tmpDir, "dedupe-expected.png", 200, 400, 200, 200, 200);
    const actual = await writeSolidPng(tmpDir, "dedupe-actual.png", 200, 400, 200, 200, 200);
    sidecar = await startMockSidecar({ imageWidth: 200, imageHeight: 400 });
    vi.stubGlobal("fetch", makeMockFetch([], { sidecarImageWidth: 200, sidecarImageHeight: 400 }));
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecar.url);
    vi.mocked(runProjectedPreAudit).mockImplementationOnce(async ({ pairs }) => ({
      diffs: [],
      skipVlmPairIds: new Set(pairs.map(pair => pair.id)),
      summary: {
        projectedPairsChecked: pairs.length,
        deterministicProjectedDiffs: 0,
        sentToVlmPairs: 0,
        skippedFromVlmPairIds: pairs.map(pair => pair.id),
        uniqueDisplacements: 0,
        displacementGroups: 0,
        structuralMismatchGroups: 0,
        groupedPairs: 0
      },
      geometryRejections: []
    }));

    const receivedProbeEntries: Array<{ role: string; provider: string; model: string }> = [];
    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "free"
    }, {
      probeOverride: async entries => {
        receivedProbeEntries.push(...entries);
        return entries.map(entry => ({
          role: entry.role,
          provider: entry.provider,
          model: entry.model,
          status: "pass" as const,
          checkedAt: new Date().toISOString(),
          schemaValid: true,
          contentAccurate: true,
          maxImagesSupported: 5
        }));
      }
    });

    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as {
      modelHealth: Array<{ role: string; provider: string; model: string }>;
    };
    const tuple = (entry: { role: string; provider: string; model: string }) =>
      `${entry.role}:${entry.provider}:${entry.model}`;
    expect(new Set(receivedProbeEntries.map(tuple)).size).toBe(receivedProbeEntries.length);
    expect(new Set(report.modelHealth.map(tuple)).size).toBe(report.modelHealth.length);
  });

  it.each([
    ["free_nvidia", "nvidia"],
    ["free_openrouter", "openrouter"]
  ] as const)("does not let successful routes from another provider starve %s", async (mode, provider) => {
    const expected = await writeSolidPng(tmpDir, `${mode}-real-probe-expected.png`, 200, 400, 200, 200, 200);
    const actual = await writeSolidPng(tmpDir, `${mode}-real-probe-actual.png`, 200, 400, 200, 200, 200);
    sidecar = await startMockSidecar({ imageWidth: 200, imageHeight: 400 });
    const providerRequests: string[] = [];
    vi.stubGlobal("fetch", makeSuccessfulProbeFetch(
      makeMockFetch([], { sidecarImageWidth: 200, sidecarImageHeight: 400 }) as unknown as (url: unknown, init?: RequestInit) => Promise<unknown>,
      providerRequests
    ));
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecar.url);
    vi.stubEnv("GEMINI_API_KEY", "gemini-test-key");
    vi.stubEnv("GEMINI_BASE_URL", "https://gemini.test/v1beta");
    vi.stubEnv("MISTRAL_API_KEY", "mistral-test-key");
    vi.stubEnv("MISTRAL_BASE_URL", "https://mistral.test/v1");
    vi.stubEnv("OPENCODE_API_KEY", "opencode-test-key");
    vi.stubEnv("OPENCODE_ZEN_BASE_URL", "https://opencode.test/v1");
    vi.stubEnv("NVIDIA_API_KEY", "nvidia-test-key");
    vi.stubEnv("NVIDIA_VLM_BASE_URL", "https://nvidia.test/v1");
    vi.stubEnv("OPENROUTER_API_KEY", "openrouter-test-key");
    vi.mocked(runProjectedPreAudit).mockImplementationOnce(async ({ pairs }) => ({
      diffs: [],
      skipVlmPairIds: new Set(pairs.map(pair => pair.id)),
      summary: {
        projectedPairsChecked: pairs.length,
        deterministicProjectedDiffs: 0,
        sentToVlmPairs: 0,
        skippedFromVlmPairIds: pairs.map(pair => pair.id),
        uniqueDisplacements: 0,
        displacementGroups: 0,
        structuralMismatchGroups: 0,
        groupedPairs: 0
      },
      geometryRejections: []
    }));

    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode
    });

    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as {
      modelHealth: Array<{ provider: string; status: string }>;
      modelSelection?: Record<string, { provider: string }>;
    };
    expect(providerRequests).not.toHaveLength(0);
    expect(providerRequests.every(requestProvider => requestProvider === provider)).toBe(true);
    expect(report.modelHealth.every(entry => entry.provider === provider)).toBe(true);
    expect(report.modelSelection).toBeDefined();
    expect(report.modelSelection!.auditor?.provider).toBe(provider);
    expect(report.modelSelection!.reviewer?.provider).toBe(provider);
  });

  it.each([
    ["free_openrouter", "openrouter"],
    ["free_gemini", "gemini"],
    ["free_mistral", "mistral"],
    ["free_opencode", "opencode"],
    ["free_nvidia", "nvidia"]
  ] as const)("probes only %s routes and selects its passing auditor and reviewer", async (mode, provider) => {
    const expected = await writeSolidPng(tmpDir, `${mode}-expected.png`, 200, 400, 200, 200, 200);
    const actual = await writeSolidPng(tmpDir, `${mode}-actual.png`, 200, 400, 200, 200, 200);
    sidecar = await startMockSidecar({ imageWidth: 200, imageHeight: 400 });
    vi.stubGlobal("fetch", makeMockFetch([], { sidecarImageWidth: 200, sidecarImageHeight: 400 }));
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecar.url);
    vi.stubEnv("NVIDIA_API_KEY", "nvidia-test-key");
    vi.mocked(runProjectedPreAudit).mockImplementationOnce(async ({ pairs }) => ({
      diffs: [],
      skipVlmPairIds: new Set(pairs.map(pair => pair.id)),
      summary: {
        projectedPairsChecked: pairs.length,
        deterministicProjectedDiffs: 0,
        sentToVlmPairs: 0,
        skippedFromVlmPairIds: pairs.map(pair => pair.id),
        uniqueDisplacements: 0,
        displacementGroups: 0,
        structuralMismatchGroups: 0,
        groupedPairs: 0
      },
      geometryRejections: []
    }));

    const receivedProbeEntries: Array<{ role: string; provider: string; costClass: string }> = [];
    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode
    }, {
      probeOverride: async entries => {
        receivedProbeEntries.push(...entries);
        return entries.map(entry => ({
          role: entry.role,
          provider: entry.provider,
          model: entry.model,
          status: "pass" as const,
          checkedAt: new Date().toISOString(),
          schemaValid: true,
          contentAccurate: true,
          maxImagesSupported: 5
        }));
      }
    });

    expect(receivedProbeEntries.length).toBeGreaterThan(0);
    expect(receivedProbeEntries.every(entry => entry.provider === provider)).toBe(true);
    expect(receivedProbeEntries.every(entry => entry.costClass === "free")).toBe(true);
    expect([...new Set(receivedProbeEntries.map(entry => entry.role))]).toEqual(
      expect.arrayContaining(["auditor", "reviewer", "target_recovery"])
    );

    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as {
      modelSelection?: Record<string, { provider: string }>;
    };
    expect(result.status).toBe("complete");
    expect(report.modelSelection?.["auditor"]).toMatchObject({ provider });
    expect(report.modelSelection?.["reviewer"]).toMatchObject({ provider });
  });

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

    const auditCheckpointSnapshots: Array<{ report: { runArtifacts: Array<{ role: string; path: string }> }; trace: Array<{ event: string; provider: string }> }> = [];
    const result = await runUiDiff({
      expectedImagePath: expected,
      actualImagePath: actual,
      projectRoot: tmpDir,
      mode: "free_opencode",
      onCheckpoint: async progress => {
        if (progress.stage !== "audit") return;
        const checkpoint = JSON.parse(await fs.readFile(progress.checkpointPath, "utf8")) as {
          runArtifacts: Array<{ role: string; path: string }>;
        };
        const providerTracePath = checkpoint.runArtifacts.find(artifact => artifact.role === "provider_trace")?.path;
        expect(providerTracePath).toBeTruthy();
        const providerTrace = JSON.parse(await fs.readFile(providerTracePath!, "utf8")) as Array<{ event: string; provider: string }>;
        auditCheckpointSnapshots.push({ report: checkpoint, trace: providerTrace });
      }
    }, { probeOverride });

    const report = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as {
      modelSelection?: Record<string, { provider: string; model: string }>;
      runArtifacts: Array<{ role: string; path: string }>;
      stages: Array<{ name: string; status: string; outcome: string; detail?: string }>;
    };
    expect(report.modelSelection?.["auditor"]).toMatchObject({ provider: "opencode", model: "mimo-v2.5-free" });
    expect(report.modelSelection?.["reviewer"]).toMatchObject({ provider: "opencode", model: "mimo-v2.5-free" });
    expect(report.modelSelection?.["targetRecovery"]).toMatchObject({ provider: "opencode", model: "mimo-v2.5-free" });
    expect(mockFetch.mock.calls.some(([url]) => typeof url === "string" && url.includes("opencode.ai/zen/v1/chat/completions"))).toBe(true);
    const providerTracePath = report.runArtifacts.find(artifact => artifact.role === "provider_trace")?.path;
    expect(providerTracePath).toBeTruthy();
    const providerTrace = JSON.parse(await fs.readFile(providerTracePath!, "utf8")) as Array<{ provider: string; event: string }>;
    expect(providerTrace.some(event => event.provider === "opencode" && event.event === "call_success")).toBe(true);
    expect(auditCheckpointSnapshots.length).toBeGreaterThan(0);
    expect(auditCheckpointSnapshots.some(snapshot =>
      snapshot.report.runArtifacts.some(artifact => artifact.role === "provider_trace") &&
      snapshot.trace.some(event => event.provider === "opencode" && event.event === "call_success")
    )).toBe(true);
    const stageMap = Object.fromEntries(report.stages.map(stage => [stage.name, stage]));
    expect(stageMap["model_probe"]).toMatchObject({ status: "complete", outcome: "success" });
    expect(stageMap["audit"]).toMatchObject({ status: "complete", outcome: "success" });
    expect(stageMap["target_recovery"]).toMatchObject({ status: "skipped", outcome: "not_applicable" });
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
    const rawReport = JSON.parse(reportRaw) as {
      diffs: { criterion: string }[];
      unresolvedRegions: unknown[];
      elements: { expected: unknown[]; actual: unknown[] };
      visualClassificationStatus: string;
      debugSummary?: unknown;
      runArtifacts: { role: string; path: string }[];
    };
    const report = await hydrateReportParts(rawReport as Parameters<typeof hydrateReportParts>[0], result.reportPath) as typeof rawReport;
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
    expect(report.runArtifacts.some((a: { role: string }) => a.role === "locator_expected_overlay")).toBe(true);
    expect(report.runArtifacts.some((a: { role: string }) => a.role === "locator_actual_overlay")).toBe(true);
    expect(report.runArtifacts.some((a: { role: string }) => a.role === "locator_overlay_legend")).toBe(true);
    expect(report.runArtifacts.some((a: { role: string }) => a.role === "locator_input_actual")).toBe(false);

    await expectFinalArtifactManifest(report as unknown as FinalArtifactReport);
    expect(result.diffCount).toBe(report.diffs.length);
    expect(result.unresolvedRegionCount).toBe(report.unresolvedRegions.length);

    expect(sidecar.requests).toHaveLength(1);
    expect(sidecar.requests[0]?.queries).toHaveLength(8);
  });

  it("removes broad accepted VLM evidence while preserving the unresolved classification", async () => {
    const expected = await writeSolidPng(tmpDir, "broad-vlm-expected.png", 200, 400, 255, 255, 255);
    const actual = await writeSolidPng(tmpDir, "broad-vlm-actual.png", 200, 400, 0, 0, 0);
    sidecar = await startMockSidecar({ imageWidth: 200, imageHeight: 400 });
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecar.url);
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-broad-vlm");
    vi.mocked(buildDeterministicDiffs).mockClear();
    vi.mocked(buildDeterministicDiffs).mockImplementation(() => [{
        id: "broad-vlm",
        criterion: "geometry",
        severity: "high",
        title: "Entire screen changed",
        location: { x: 0, y: 0, width: 200, height: 400 },
        evidence: ["entire screen differs"],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "accepted",
        classificationSource: "vlm_reviewed"
      }]);
    const probeOverride = async () => [
      { role: "auditor", provider: "openrouter", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", status: "pass" as const, checkedAt: new Date().toISOString() },
      { role: "reviewer", provider: "openrouter", model: "nex-agi/nex-n2-pro:free", status: "pass" as const, checkedAt: new Date().toISOString() }
    ];

    const result = await runUiDiff({ expectedImagePath: expected, actualImagePath: actual, projectRoot: tmpDir, mode: "full" }, { probeOverride });
    expect(buildDeterministicDiffs).toHaveBeenCalled();
    const raw = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as {
      diffs: Array<{ classificationSource?: string }>;
      unresolvedRegions: Array<{ reason: string; relatedFindingIds: string[] }>;
      visualClassificationStatus: string;
      runArtifacts: Array<{ role: string; path: string }>;
    };
    const report = await hydrateReportParts(raw as Parameters<typeof hydrateReportParts>[0], result.reportPath) as typeof raw;

    expect(report.diffs.some(diff => diff.classificationSource === "vlm_reviewed")).toBe(false);
    expect(report.unresolvedRegions).toContainEqual(expect.objectContaining({
      reason: "not_classified",
      detail: "not_classified; broad_vlm_evidence: broad-vlm",
      relatedFindingIds: ["broad-vlm"]
    }));
    expect(report.visualClassificationStatus).toBe("incomplete");
    await expectFinalArtifactManifest(report as unknown as FinalArtifactReport);
  });

  it("completes when a broad raw finding is fully superseded by local coverage", async () => {
    const expected = await writeSolidPng(tmpDir, "broad-superseded-expected.png", 200, 400, 255, 255, 255);
    const actual = await writeRectPng(tmpDir, "broad-superseded-actual.png", 200, 400, 255, 255, 255, 20, 50, 160, 44, 0, 0, 0);
    sidecar = await startMockSidecar({ imageWidth: 200, imageHeight: 400 });
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecar.url);
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-broad-superseded");
    vi.stubGlobal("fetch", makeMockFetch(Array.from({ length: 100 }, () => ({
      criterion: "geometry" as const,
      hasDiff: false,
      reviewerDecision: "accepted" as const
    }))));
    vi.mocked(buildDeterministicDiffs).mockImplementation(() => [
      {
        id: "broad-raw",
        criterion: "geometry",
        severity: "high",
        title: "Broad raw finding",
        location: { x: 0, y: 0, width: 200, height: 400 },
        evidence: ["broad raw evidence"],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "accepted",
        classificationSource: "vlm_reviewed"
      },
      {
        id: "local-coverage",
        criterion: "geometry",
        severity: "medium",
        title: "Local coverage finding",
        location: { x: 20, y: 50, width: 160, height: 44 },
        evidence: ["local coverage evidence"],
        measurements: [],
        artifactPaths: [],
        reviewerStatus: "not_reviewed",
        classificationSource: "deterministic_geometry"
      }
    ]);
    const probeOverride = async () => [
      { role: "auditor", provider: "openrouter", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", status: "pass" as const, checkedAt: new Date().toISOString(), schemaValid: true, contentAccurate: true, maxImagesSupported: 5 },
      { role: "reviewer", provider: "openrouter", model: "nex-agi/nex-n2-pro:free", status: "pass" as const, checkedAt: new Date().toISOString(), schemaValid: true, contentAccurate: true, maxImagesSupported: 5 }
    ];

    const result = await runUiDiff({ expectedImagePath: expected, actualImagePath: actual, projectRoot: tmpDir, mode: "full" }, { probeOverride });
    const raw = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as {
      diffs: Array<{ id: string }>;
      unresolvedRegions: unknown[];
      visualClassificationStatus: string;
    };
    const report = await hydrateReportParts(raw as Parameters<typeof hydrateReportParts>[0], result.reportPath) as typeof raw;
    expect(report.diffs.some(diff => diff.id === "broad-raw")).toBe(false);
    expect(report.diffs.some(diff => diff.id === "local-coverage")).toBe(true);
    expect(report.unresolvedRegions).toHaveLength(0);
    expect(report.visualClassificationStatus).toBe("complete");
  });

  it("records the exact images sent to LocateAnything as report artifacts", async () => {
    const expected = await writeSolidPng(tmpDir, "locator-payload-e.png", 400, 800, 200, 200, 200);
    const actual = await writeSolidPng(tmpDir, "locator-payload-a.png", 400, 800, 200, 200, 200);
    sidecar = await startMockSidecar({ imageWidth: 100, imageHeight: 200 });

    const mockFetch = makeMockFetch([
      { criterion: "geometry", hasDiff: false, reviewerDecision: "accepted" }
    ], { sidecarImageWidth: 200, sidecarImageHeight: 400 });
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecar.url);
    vi.stubEnv("LOCATEANYTHING_MAX_DIMENSION", "200");
    vi.stubEnv("UI_DIFF_DUAL_LOCATOR", "1");
    vi.stubEnv("UI_DIFF_ALLOW_DUAL_LOCATOR", "1");
    vi.stubEnv("UI_DIFF_DUAL_LOCATOR_REASON", "test exact locator payload artifacts");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test-locator-payload");

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

    const rawReport = JSON.parse(await fs.readFile(result.reportPath, "utf8")) as {
      locatorInputSizing?: {
        expected?: { sentWidth: number; sentHeight: number };
        actual?: { sentWidth: number; sentHeight: number };
      };
      runArtifacts: Array<{ role: string; path: string }>;
    };
    const report = await hydrateReportParts(rawReport as Parameters<typeof hydrateReportParts>[0], result.reportPath) as typeof rawReport;

    expect(sidecar.requests).toHaveLength(2);

    async function expectLocatorPayloadArtifact(
      role: "locator_input_expected" | "locator_input_actual",
      fileName: string,
      sizing: { sentWidth: number; sentHeight: number } | undefined,
      callIndex: number
    ): Promise<void> {
      const locatorInput = report.runArtifacts.find(artifact => artifact.role === role);
      expect(locatorInput?.path).toBe(path.join(result.artifactRoot, fileName));
      await expect(fs.access(locatorInput!.path)).resolves.toBeUndefined();

      const metadata = await sharp(locatorInput!.path).metadata();
      expect({ width: metadata.width, height: metadata.height }).toEqual({
        width: sizing?.sentWidth,
        height: sizing?.sentHeight
      });

      const sidecarBody = sidecar.requests[callIndex] as { imageBase64: string };
      const savedBytes = await fs.readFile(locatorInput!.path);
      expect(savedBytes.equals(Buffer.from(sidecarBody.imageBase64, "base64"))).toBe(true);
    }

    await expectLocatorPayloadArtifact(
      "locator_input_expected",
      "locator-input-expected.png",
      report.locatorInputSizing?.expected,
      0
    );
    await expectLocatorPayloadArtifact(
      "locator_input_actual",
      "locator-input-actual.png",
      report.locatorInputSizing?.actual,
      1
    );
  });

  it("returns model_unavailable when required models are not_checked", async () => {
    const { expected, actual } = await writeTwoButtonFixture(
      tmpDir, "e.png", "a.png"
    );

    const probeOverride = async () => [
      { role: "auditor", provider: "openrouter", model: "qwen/qwen3-vl-30b-a3b-instruct", status: "not_checked" as const, checkedAt: new Date().toISOString(), detail: "No API key provided" },
      { role: "reviewer", provider: "openrouter", model: "google/gemini-2.5-flash-lite", status: "not_checked" as const, checkedAt: new Date().toISOString(), detail: "No API key provided" }
    ];

    sidecar = await startMockSidecar({ imageWidth: 200, imageHeight: 400 });
    const mockFetch = makeMockFetch([]);
    vi.stubGlobal("fetch", mockFetch);
    vi.stubEnv("LOCATEANYTHING_SIDECAR_URL", sidecar.url);

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
