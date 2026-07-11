import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareCalorixLiveGate } from "../helpers/calorix-live-gate.js";

describe("Calorix live gate setup", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects an invalid expected reference before starting the sidecar", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ui-diff-calorix-live-gate-"));
    const ensureSidecar = vi.fn();
    vi.stubEnv("UI_DIFF_LIVE_EXPECTED_IMAGE", path.join(root, "missing-expected.png"));

    await expect(prepareCalorixLiveGate({ projectRoot: root, ensureSidecar })).rejects.toThrow(/missing or unreadable/i);
    expect(ensureSidecar).not.toHaveBeenCalled();

    await fs.rm(root, { recursive: true, force: true });
  });
});
