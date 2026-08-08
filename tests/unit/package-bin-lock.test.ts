import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  checkPackageBinPolicy,
  isPackageBinPolicyOk,
} from "../../scripts/lib/package-bin-policy.mjs";

const SCRIPT_PATH = resolve("scripts/verify-package-bin-lock.sh");

describe("package-bin-lock policy", () => {
  it("package.json and package-lock.json bin paths agree on dist/src/index.js", () => {
    const result = checkPackageBinPolicy("package.json", "package-lock.json");
    expect(result.ok).toBe(true);
    expect(result.pkg).toBe("./dist/src/index.js");
    expect(result.lock).toBe("dist/src/index.js");
    expect(result.lock).not.toBe("dist/index.js");
  });

  it("reports error for missing package.json", () => {
    const result = checkPackageBinPolicy(
      "nonexistent-package.json",
      "package-lock.json",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("reports error for missing package-lock.json", () => {
    const result = checkPackageBinPolicy(
      "package.json",
      "nonexistent-lock.json",
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("isPackageBinPolicyOk returns boolean", () => {
    expect(typeof isPackageBinPolicyOk).toBe("function");
    const ok = isPackageBinPolicyOk("package.json", "package-lock.json");
    expect(typeof ok).toBe("boolean");
    expect(ok).toBe(true);
  });

  it("bash guard works when invoked via absolute path from a different cwd", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pkg-bin-lock-test-"));
    try {
      const result = spawnSync("bash", [SCRIPT_PATH], {
        cwd: tmpDir,
        encoding: "utf-8",
        timeout: 15_000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PASS: package-bin policy check OK");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
