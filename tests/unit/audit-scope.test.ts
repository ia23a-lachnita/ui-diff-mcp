import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditScopeSummaries } from "../../src/audit/audit-scope.js";
import { UiArtifactSchema } from "../../src/schemas/core.js";
import type { ScopeDiffSummary } from "../../src/schemas/core.js";
import type { VisionJsonCaller } from "../../src/models/vision-json.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-scope-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writePng(name: string): Promise<string> {
  const out = path.join(tmpDir, name);
  await sharp({ create: { width: 20, height: 20, channels: 4, background: "#202020" } }).png().toFile(out);
  return out;
}

describe("auditScopeSummaries", () => {
  it("audits only triggered scope criteria and records scope metadata", async () => {
    const expectedPath = await writePng("expected.png");
    const actualPath = await writePng("actual.png");
    const overlayPath = await writePng("overlay.png");
    const maskPath = await writePng("mask.png");
    const summaries: ScopeDiffSummary[] = [{
      id: "screen",
      kind: "screen",
      label: "Whole screen",
      box: { x: 0, y: 0, width: 20, height: 20 },
      changedPixelPercent: 20,
      edgeChangedPercent: 5,
      triggeredCriteria: ["geometry"],
      measurements: [{ name: "changed_pixel_percent", value: 20, unit: "percent" }]
    }];
    const auditor: VisionJsonCaller = vi.fn(async () => ({
      parsed: {
        hasDiff: true,
        severity: "high",
        title: "Whole screen layout differs",
        evidence: ["Full-screen overlay shows a broad placement difference."]
      },
      rawContent: "{}",
      model: "mock-auditor",
      provider: "mock"
    }));
    const reviewer: VisionJsonCaller = vi.fn(async () => ({
      parsed: { decision: "accepted", reason: "Supported by overlay." },
      rawContent: "{}",
      model: "mock-reviewer",
      provider: "mock"
    }));

    const result = await auditScopeSummaries({
      summaries,
      diffScope: { kind: "screen" },
      expectedImagePath: expectedPath,
      actualImagePath: actualPath,
      directionalOverlayPath: overlayPath,
      pixelDiffMaskPath: maskPath,
      auditorCaller: auditor,
      reviewerCaller: reviewer
    });

    expect(auditor).toHaveBeenCalledTimes(1);
    expect(reviewer).toHaveBeenCalledTimes(1);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      criterion: "geometry",
      scopeId: "screen",
      scopeKind: "screen",
      scopeLabel: "Whole screen",
      classificationSource: "vlm_reviewed",
      reviewerStatus: "accepted"
    });
    const artifacts = result.accepted[0]?.artifactPaths ?? [];
    expect(artifacts).toEqual(expect.arrayContaining([
      { role: "expected_normalized", path: expectedPath },
      { role: "actual_comparison_space", path: actualPath },
      { role: "directional_overlay", path: overlayPath },
      { role: "pixel_diff_mask", path: maskPath }
    ]));
    expect(artifacts).toHaveLength(4);
    for (const artifact of artifacts) UiArtifactSchema.parse(artifact);
  });
});
