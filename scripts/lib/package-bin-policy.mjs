#!/usr/bin/env node
import { readFileSync } from "node:fs";

const EXPECTED_PKG_BIN = "./dist/src/index.js";
const EXPECTED_LOCK_BIN = "dist/src/index.js";

export function checkPackageBinPolicy(pkgPath, lockPath) {
  try {
    const pkgRaw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(pkgRaw);
    const pkgBin = pkg?.bin?.["ui-diff-mcp"];

    const lockRaw = readFileSync(lockPath, "utf8");
    const lock = JSON.parse(lockRaw);
    const lockBin = lock?.packages?.[""]?.bin?.["ui-diff-mcp"];

    if (pkgBin !== EXPECTED_PKG_BIN) {
      return {
        ok: false,
        pkg: pkgBin,
        lock: lockBin,
        error: `package.json bin["ui-diff-mcp"] is ${JSON.stringify(pkgBin)}, expected ${JSON.stringify(EXPECTED_PKG_BIN)}`,
      };
    }

    if (lockBin !== EXPECTED_LOCK_BIN) {
      return {
        ok: false,
        pkg: pkgBin,
        lock: lockBin,
        error: `package-lock.json root bin["ui-diff-mcp"] is ${JSON.stringify(lockBin)}, expected ${JSON.stringify(EXPECTED_LOCK_BIN)}`,
      };
    }

    return { ok: true, pkg: pkgBin, lock: lockBin };
  } catch (err) {
    return {
      ok: false,
      pkg: undefined,
      lock: undefined,
      error: err.message,
    };
  }
}

export function isPackageBinPolicyOk(pkgPath, lockPath) {
  return checkPackageBinPolicy(pkgPath, lockPath).ok;
}
