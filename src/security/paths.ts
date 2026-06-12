import path from "node:path";
import fs from "node:fs/promises";

export const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function assertSupportedImagePath(filePath: string): void {
  if (filePath.includes("\0")) {
    throw new Error(`Path contains null byte: ${filePath}`);
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported image extension "${ext}". Supported: ${[...SUPPORTED_IMAGE_EXTENSIONS].join(", ")}`);
  }
}

export function resolveInputImagePath(filePath: string, base?: string): string {
  assertSupportedImagePath(filePath);
  const resolved = path.resolve(base ?? process.cwd(), filePath);
  if (resolved.includes("\0")) {
    throw new Error("Resolved path contains null byte");
  }
  return resolved;
}

export async function createRunDirectory(root: string, runId: string): Promise<string> {
  const runDir = path.join(root, ".ui-diff", "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  return runDir;
}
