import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeJsonArtifact } from "../../src/images/artifacts.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "artifacts-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("writeJsonArtifact", () => {
  it("writes JSON to an output file and returns the path", async () => {
    const outPath = path.join(tmpDir, "out.json");
    const result = await writeJsonArtifact(outPath, { foo: "bar", n: 42 });
    expect(result).toBe(outPath);
    const raw = await fs.readFile(outPath, "utf8");
    expect(JSON.parse(raw)).toEqual({ foo: "bar", n: 42 });
  });

  it("creates intermediate directories as needed", async () => {
    const outPath = path.join(tmpDir, "nested", "deep", "data.json");
    await writeJsonArtifact(outPath, [1, 2, 3]);
    await expect(fs.access(outPath)).resolves.toBeUndefined();
  });
});
