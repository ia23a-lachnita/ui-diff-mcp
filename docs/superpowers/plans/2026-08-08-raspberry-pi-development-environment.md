# Raspberry Pi Development Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an idempotent Raspberry Pi 4 ARM64 Debian development environment for ui-diff-mcp with Dockerized ReDroid (software rendering, loopback-only ADB), platform-tools/udev for a future phone, verified Calorix Actions APK fetching, package-lock bin preservation, and a clean handoff back to Task 8 structural source-facts.

**Architecture:** Environment setup is a documentation-and-scripts stage isolated from active Task 8 pipeline work. Bash scripts under `scripts/` install and check adb/udev, start/stop/reset ReDroid with binder/kvm and persistent data, and optionally fetch a Calorix GitHub Actions APK only when the workflow source SHA equals the requested committed source SHA and the SHA256 checksum verifies. Focused shell/unit checks prove invariants; `npm run verify` remains the repository gate. Workers never commit or push; the host reviews, verifies, commits, and pushes.

**Tech Stack:** Raspberry Pi 4 ARM64 Debian, bash, Docker, ReDroid ARM64, Android platform-tools/adb, Linux udev, GitHub Actions artifacts via `gh` or authenticated HTTPS, Node.js 22+, npm, Vitest for any Node-side invariant checks.

## Global Constraints

- Do not implement Task 8 structural source-facts in this plan.
- Do not edit `AGENTS.md` or pipeline/provider/locator/MCP implementation code unless a later task explicitly names a file and the host authorizes that scope change.
- ReDroid is acceptable release evidence for platform-independent UI/layout/state/navigation behavior only.
- OEM rendering, camera hardware, sensors, thermals/performance, and physical-device screenshot parity remain phone-only.
- Do not globally block production validation merely because a physical phone is absent.
- ADB must publish only to `127.0.0.1:5555`; never `0.0.0.0` or LAN interfaces.
- Preserve and verify the intentional package-lock bin path `dist/src/index.js`.
- Every behavior change is test-first: write the failing check, run it red, implement, run green, then `npm run verify` at stage boundaries.
- Workers never commit or push. Host reviews, verifies, commits, and pushes each meaningful stage.
- Worker model route order by actual model: `grok-4.5` high primary → `qwen3.7-max` → `opencode/nemotron-3-ultra-free` → `opencode/mimo-v2.5-free` → `opencode/deepseek-v4-flash-free` → Claude paid last. Record exact failure timestamp, model, category, and message before each fallback.
- Antigravity external review order remains separate: Gemini 3.6 Flash (High) → Gemini 3.1 Pro (High) → Gemini 3.5 Flash (High). Green only with `AGREEMENT_STATUS: agree` and `MUST_FIX: none`.
- Never commit secrets, APK binaries, Docker volumes, build output, or generated run artifacts.

## Root/Bootstrap Blocker Semantics

Scripts may be implemented and tested without root. Actual execution that requires elevated privileges constitutes an environment blocker, not a code failure:

- `adb` package install via `apt` or manual download: may require root for system-wide install
- Docker group membership: agent-runner must be in the `docker` group to run Docker without sudo; if absent, requires user/root setup
- Binder device node setup: if `/dev/binder`, `/dev/hwbinder`, `/dev/vndbinder` are absent, requires root to create them (using major:minor from sysfs) or mount binderfs; scripts inspect `/sys/class/misc/{binder,hwbinder,vndbinder}/dev` for kernel-reported major:minor and never guess numbers
- ReDroid smoke test: requires Docker access and binder nodes, which may require root

Current host facts (2026-08-08): Docker service active; agent-runner is not in docker group; `sudo -n` unavailable; `/dev/kvm` exists; `CONFIG_ANDROID_BINDER_IPC=y` and `CONFIG_ANDROID_BINDER_DEVICES=binder,hwbinder,vndbinder`; device nodes currently absent. Setup must require root to create/mount/initialize binder nodes or fail with exact root remediation.

### Exact root blocker check commands

Scripts must provide diagnostics even when execution is blocked. Run these before any operation that requires elevated privileges:

```bash
# Current user identity
id

# Docker group membership
getent group docker

# Docker daemon access
docker info

# Kernel binder config
grep CONFIG_ANDROID_BINDER_IPC /boot/config-$(uname -r) || grep CONFIG_ANDROID_BINDER_IPC /proc/config.gz 2>/dev/null || zcat /proc/config.gz 2>/dev/null | grep CONFIG_ANDROID_BINDER_IPC

# Binder device nodes
ls -la /dev/binder /dev/hwbinder /dev/vndbinder 2>&1 || true

# Sysfs binder registrations (for major:minor discovery)
cat /sys/class/misc/binder/dev 2>&1 || true
cat /sys/class/misc/hwbinder/dev 2>&1 || true
cat /sys/class/misc/vndbinder/dev 2>&1 || true

# KVM availability
ls -la /dev/kvm 2>&1 || true
```

When a blocker is detected, scripts must print a clear message identifying the exact blocker and the remediation command.

## Research Inputs

- Approved design: `docs/superpowers/specs/2026-08-08-raspberry-pi-development-environment.md`
- Active structural plan remains: `docs/superpowers/plans/2026-07-30-structural-container-parent-first-consolidation.md`
- Current HEAD at drafting: `782119e` (`Preserve locator query provenance`)
- Pre-existing intentional working-tree change: `package-lock.json` root bin `ui-diff-mcp` corrected from `dist/index.js` to `dist/src/index.js` to match `package.json`
- Existing Calorix device helper: `tests/helpers/calorix-device.ts` already drives adb install/launch/capture and local debug APK freshness; this plan adds host/ReDroid/Actions-APK environment support without rewriting pipeline logic
- Existing sidecar starter is PowerShell-only (`scripts/start-locateanything-sidecar.ps1`); this plan adds the Linux equivalent bash launcher while preserving the PowerShell script for Windows
- Antigravity pre-review on 2026-08-08: `gemini-3.6-flash`, `gemini-3.1-pro`, and `gemini-3.5-flash` all rejected empty `--effort` before review; no response body and no green review

## File Map

- Create: `docs/superpowers/specs/2026-08-08-raspberry-pi-development-environment.md` (approved design; already drafted in this stage)
- Create: `docs/superpowers/plans/2026-08-08-raspberry-pi-development-environment.md` (this plan)
- Modify: `docs/implementation-status.md` (Pi migration becomes current bounded prerequisite; Task 8 resumes after)
- Create: `scripts/lib/android-env-common.sh` shared helpers for path detection, loopback bind checks, and failure formatting
- Create: `scripts/lib/package-bin-policy.mjs` executable Node ESM module exporting `checkPackageBinPolicy` and `isPackageBinPolicyOk`; used by `scripts/verify-package-bin-lock.sh` (bash fetcher) and `tests/unit/package-bin-lock.test.ts` (Vitest)
- Create: `scripts/lib/calorix-actions-apk-policy.mjs` executable Node ESM module exporting the APK provenance decision (`decideCalorixActionsApkFetch`); invoked by the fetcher and imported by Vitest
- Create: `scripts/install-android-platform-tools.sh`
- Create: `scripts/check-adb.sh`
- Create: `tests/contract/android-env.test.sh` shell contract tests for android-env-common, install-android-platform-tools, and check-adb scripts (63 tests across 12 groups)
- Create: `scripts/start-redroid.sh`
- Create: `scripts/stop-redroid.sh`
- Create: `scripts/reset-redroid.sh`
- Create: `scripts/fetch-calorix-actions-apk.sh`
- Create: `scripts/start-locateanything-sidecar.sh` Linux bash launcher for LocateAnything sidecar; resolves `LOCATEANYTHING_PYTHON` → `/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin/python` (sibling shared venv) → `python3`; resolves `LOCATEANYTHING_EAGLE_EMBODIED_DIR` → `/home/agent-runner/projects/Eagle/Embodied`; starts `uvicorn sidecars.locateanything.server:app` at loopback port 39731; health-checks; never exposes publicly
- Create: `scripts/verify-package-bin-lock.sh` focused lockfile bin assertion
- Create: `tests/unit/package-bin-lock.test.ts` Node assertion that package and lock root bins agree on `dist/src/index.js`
- Create: `tests/unit/calorix-actions-apk-policy.test.ts` pure policy tests for source-SHA and checksum gates (imports from `scripts/lib/calorix-actions-apk-policy.mjs`)
- Modify: `package.json` only if a non-behavior script alias is added for env checks; do not change the existing `"bin": { "ui-diff-mcp": "./dist/src/index.js" }` entry
- Modify: `package-lock.json` only to keep the intentional root bin `dist/src/index.js` synchronized; do not regenerate a lock that reverts it
- Modify: `AGENTS.md` in the final implementation stage to add Pi/bash environment section and update the worker route to: `grok-4.5` high → `qwen3.7-max` → `opencode/nemotron-3-ultra-free` → `opencode/mimo-v2.5-free` → `opencode/deepseek-v4-flash-free` → Claude paid last; record exact failure before each fallback
- Modify: `README.md` environment section for Pi/ReDroid/adb/udev/APK fetch commands
- Do not modify: locator/pipeline/provider implementation files, or Task 8 structural source-facts modules in this plan

## Interfaces

```js
// scripts/lib/package-bin-policy.mjs
// Executable Node ESM module (type: module).
// Exports:
//   checkPackageBinPolicy(pkgPath, lockPath) → { ok: boolean, pkg: string, lock: string, error?: string }
//   isPackageBinPolicyOk(pkgPath, lockPath) → boolean
// Used by: scripts/verify-package-bin-lock.sh (via node --input-type=module import) and tests/unit/package-bin-lock.test.ts (direct import)
// Validates package.json bin["ui-diff-mcp"] === "./dist/src/index.js"
// Validates lock.packages[""].bin["ui-diff-mcp"] === "dist/src/index.js"
// Returns structured result; never exits non-zero (caller decides exit behavior).
```

```js
// scripts/lib/calorix-actions-apk-policy.mjs
// Executable Node ESM module (type: module).
// Exports:
//   decideCalorixActionsApkFetch(input: unknown) → { allowed: true } | { allowed: false; reason: CalorixActionsApkFetchRejectionReason }
//   normalizeGitSha(value) → string  (throws on malformed input)
// Used by: scripts/fetch-calorix-actions-apk.sh (via node --input-type=module) and tests/unit/calorix-actions-apk-policy.test.ts (direct import)
// Pure policy: no network I/O, case-insensitive SHA/checksum normalization, closed reason strings only.
// Artifact contract: one artifact named android-apk-<40-char-source-sha> containing exactly one .apk and its matching .apk.sha256.
```

```bash
# scripts/lib/android-env-common.sh
# Exports:
#   UI_DIFF_REDROID_NAME=ui-diff-redroid
#   UI_DIFF_REDROID_IMAGE=redroid/redroid@sha256:46478a567194aed24cd0877d4434a9e58b534d4aad30931eb21999a52f2ce131
#   UI_DIFF_REDROID_ADB_HOST=127.0.0.1
#   UI_DIFF_REDROID_ADB_PORT=5555
#   UI_DIFF_REDROID_DATA_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/ui-diff-mcp/redroid-data
# Functions:
#   try_resolve_adb_bin                     # nonfatal: same resolution rules, returns 1 (no exit) when unusable
#   resolve_adb_bin                         # fatal wrapper over try_resolve_adb_bin; if UI_DIFF_ADB_BIN set, require exact path usable, no PATH fallback; else command -v adb; exports ADB_BIN + ADB_VERSION; exits with remediation on failure
#   require_cmd <name>
#   assert_loopback_publish <publish_spec>   # accepts only 127.0.0.1:5555:5555
#   fail <message>                          # stderr + non-zero exit
```

```bash
# scripts/lib/package-bin-policy.mjs
# Executable Node ESM module (type: module).
# Exports: function checkPackageBinPolicy(pkgPath, lockPath) → { ok: boolean, pkg: string, lock: string, error?: string }
# Used by: scripts/verify-package-bin-lock.sh (via node --input-type=module import) and tests/unit/package-bin-lock.test.ts (direct import)
# Validates package.json bin["ui-diff-mcp"] === "./dist/src/index.js"
# Validates lock.packages[""].bin["ui-diff-mcp"] === "dist/src/index.js"
# Returns structured result; never exits non-zero (caller decides exit behavior).
```

```bash
# Script CLIs
scripts/install-android-platform-tools.sh [--check-only]
scripts/check-adb.sh [--expect-redroid]
scripts/start-redroid.sh
scripts/stop-redroid.sh
scripts/reset-redroid.sh [--yes]
scripts/fetch-calorix-actions-apk.sh \
  --repo <owner/calorix> \
  --source-sha <40-char-sha> \
  --workflow <workflow-file-or-name> (optional, default: android-build.yml) \
  --artifact-name <apk-artifact-name> (optional, default: android-apk-<source-sha>) \
  --output <path.apk>
scripts/verify-package-bin-lock.sh
```

---

### Task 1: Status Split And Package-Lock Bin Guard

**Files:**
- Modify: `docs/implementation-status.md`
- Create: `scripts/lib/package-bin-policy.mjs`
- Create: `scripts/verify-package-bin-lock.sh`
- Create: `tests/unit/package-bin-lock.test.ts`
- Modify: `package-lock.json` only if still needed to keep root bin `dist/src/index.js`
- Modify (migration prerequisite): `tests/helpers/calorix-device.ts` — cross-platform `DEFAULT_CALORIX_PROJECT_ROOT`
- Modify (migration prerequisite): `tests/e2e/compare-ui-images.test.ts` — replace hardcoded Windows literal
- Modify (migration prerequisite): `tests/unit/calorix-device.test.ts` — add sibling-path assertion

**Interfaces:**
- Produces: executable Node ESM helper `checkPackageBinPolicy(pkgPath, lockPath)` in `scripts/lib/package-bin-policy.mjs` returning `{ ok, pkg, lock, error? }`.
- Produces: shell and Vitest checks that `package.json` bin `./dist/src/index.js` and lock root bin `dist/src/index.js` match.
- Produces: status text stating Pi migration is the current bounded prerequisite and Task 8 structural source-facts resumes after migration.
- Preserves: intentional pre-existing lock bin correction at HEAD working tree.

- [x] **Step 1: Write the failing package-bin lock test**

Add `tests/unit/package-bin-lock.test.ts` that imports `checkPackageBinPolicy` from `../../scripts/lib/package-bin-policy.mjs` and asserts:

```ts
import { checkPackageBinPolicy } from "../../scripts/lib/package-bin-policy.mjs";

const result = checkPackageBinPolicy("package.json", "package-lock.json");
expect(result.ok).toBe(true);
expect(result.pkg).toBe("./dist/src/index.js");
expect(result.lock).toBe("dist/src/index.js");
expect(result.lock).not.toBe("dist/index.js");
```

Also add `scripts/verify-package-bin-lock.sh` that calls `node --input-type=module` to import the ESM helper and exits non-zero if the result is not ok.

- [x] **Step 2: Run focused RED for missing ESM helper**

Run:

```bash
npx vitest run tests/unit/package-bin-lock.test.ts
bash scripts/verify-package-bin-lock.sh
```

Expected before implementation: fail because `package-bin-policy.mjs` does not exist or import fails.

**Actual RED:** `npx vitest run tests/unit/package-bin-lock.test.ts` — `1` failed test file, `0` tests executed, `Cannot find module '../../scripts/lib/package-bin-policy.mjs'`. Bash guard not run (module missing).

- [x] **Step 3: Implement the ESM policy helper**

Create `scripts/lib/package-bin-policy.mjs`:

```js
#!/usr/bin/env node
export function checkPackageBinPolicy(pkgPath, lockPath) {
  // Read package.json, parse, assert bin["ui-diff-mcp"] === "./dist/src/index.js"
  // Read package-lock.json, parse, assert packages[""].bin["ui-diff-mcp"] === "dist/src/index.js"
  // Return { ok: true/false, pkg: actualPkgValue, lock: actualLockValue, error?: string }
}
```

Make executable: `chmod +x scripts/lib/package-bin-policy.mjs`.

- [x] **Step 4: Run focused GREEN**

Run:

```bash
npx vitest run tests/unit/package-bin-lock.test.ts
bash scripts/verify-package-bin-lock.sh
```

Expected: PASS with the intentional working-tree correction already present; test guards against future reversion.

**Actual GREEN:** Vitest `1` file passed, `4` tests passed. Bash guard `PASS: package-bin policy check OK`.

- [x] **Step 5: Ensure the intentional lock bin correction is present**

Confirm `package-lock.json` root package bin is exactly:

```json
"bin": {
  "ui-diff-mcp": "dist/src/index.js"
}
```

Do not run a blind `npm install` that reverts it. If a later dependency change rewrites the lock, re-apply only the root bin path and re-run the focused test.

**Confirmed:** `package-lock.json` root bin is `"dist/src/index.js"` matching `package.json` `"./dist/src/index.js"`.

- [x] **Step 6: Update status for the scope split**

In `docs/implementation-status.md` set:

- Current task: Raspberry Pi development environment migration (bounded prerequisite)
- Actual HEAD: `8ca68dd`
- Pre-existing intentional package-lock bin synchronization: `dist/src/index.js`
- Task 8 structural source-facts resumes after migration
- No production-readiness claim

- [x] **Step 7: Focused green and repository verify**

Run:

```bash
npx vitest run tests/unit/package-bin-lock.test.ts
npx vitest run tests/unit/calorix-device.test.ts tests/e2e/compare-ui-images.test.ts
bash scripts/verify-package-bin-lock.sh
npm run verify
git diff --check
```

Expected: all PASS (line-ending warnings only are acceptable for `--check`).

**Migration prerequisite correction (2026-08-08):** `DEFAULT_CALORIX_PROJECT_ROOT` was hardcoded to `C:/Users/xursc/projects/calorix` and failed on Linux. Fixed by deriving it via `import.meta.url` + `fileURLToPath` + `path.resolve` to find the sibling `../calorix` checkout. E2E test `copyFile` Windows literal replaced with imported constants. Sibling-path assertion added. Focused `2` files `62` tests GREEN; typecheck PASS; git diff --check PASS.

**Full verify result (2026-08-08):** First plain `npm run verify` passed 73 files / 1,296 TS tests; `test:sidecar` failed because system Python lacked fastapi. Host created uncommitted external venv `/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything` using Python 3.11 with parser-only deps (fastapi, pillow, numpy, opencv-python-headless). With `PATH` prepend: `npm run test:sidecar` passed 25 tests; `npm run verify` passed all stages: typecheck clean; 73 files / 1,296 TypeScript tests; 25 Python parser tests; build clean; 3 integration files / 22 tests; `git diff --check` clean. Parser-only venv; no full LocateAnything model environment or production readiness claimed.

- [x] **Step 8: Host commit and push checkpoint**

Host only:

```bash
git add docs/implementation-status.md docs/superpowers/specs/2026-08-08-raspberry-pi-development-environment.md docs/superpowers/plans/2026-08-08-raspberry-pi-development-environment.md package-lock.json scripts/lib/package-bin-policy.mjs scripts/verify-package-bin-lock.sh tests/unit/package-bin-lock.test.ts
git commit -m "Document Pi environment migration and preserve package bin lock"
git push origin HEAD
```

Workers stop before this step.

**Implemented:** Implementation commit `536c4f0` pushed to `origin/master`.

---

### Task 2: Pure Calorix Actions APK Policy

**Files:**
- Create: `scripts/lib/calorix-actions-apk-policy.mjs` (replaces `src/env/calorix-actions-apk-policy.ts`)
- Create: `scripts/lib/calorix-actions-apk-policy.d.mts` (TypeScript declaration file for the MJS)
- Create: `tests/unit/calorix-actions-apk-policy.test.ts`

**Interfaces:**
- Produces: `decideCalorixActionsApkFetch` and `normalizeGitSha` as specified above; both pure, no I/O. `decideCalorixActionsApkFetch` never throws (fail-closed on malformed input); `normalizeGitSha` throws on malformed standalone input.
- Rejects: malformed SHAs/checksums (case-insensitive normalization), uncommitted source, mismatched source SHAs, mismatched checksums, wrong workflow identity, wrong artifact structure.
- Actual test coverage: `90` tests across `17` describe blocks covering every terminal reason, uppercase acceptance, type-invalid/no-throw inputs, order independence, precedence, and never-throw semantics.

- [x] **Step 1: Write failing policy tests**

Cover exactly. All SHA/checksum values must be exact 40 or 64 hex characters in either case, normalized to lowercase by the policy. The policy must fail closed on every malformed input.

**Closed reason strings** (the policy must return exactly these strings, never throw):

| Reason | Meaning |
|---|---|
| `malformed_requested_source_sha` | `requestedSourceSha` is not exactly 40 hex chars |
| `malformed_workflow_source_sha` | `workflowSourceSha` is not exactly 40 hex chars |
| `malformed_artifact_sha256` | `artifactSha256` is not exactly 64 hex chars |
| `malformed_expected_sha256` | `expectedSha256` is not exactly 64 hex chars |
| `uncommitted_source` | `workingTreeClean` is false |
| `source_sha_mismatch` | normalized SHAs differ |
| `workflow_conclusion_not_success` | `workflowConclusion` is not `success` |
| `wrong_workflow_name` | `workflowName` is not the expected workflow name |
| `wrong_workflow_path` | `workflowPath` is not the expected workflow file path |
| `wrong_artifact_name` | `artifactName` does not match `android-apk-<requestedSourceSha>` |
| `artifact_file_count_invalid` | artifact does not contain exactly one `.apk` file and one matching `<apk-basename>.sha256`; rejects nonstrings, extras, duplicates, nested paths, and dot segments |
| `checksum_mismatch` | SHA256 of the APK file does not match the expected checksum |

```ts
// ── Allowed path ──────────────────────────────────────────────
// allowed only when all fields valid, clean tree, equal normalized SHAs, equal checksums
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: true });

// case-insensitive SHA normalization
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: true });

// ── Malformed source SHA (too short) ──────────────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "malformed_requested_source_sha" });

// ── Malformed workflow source SHA (too long) ──────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b000",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "malformed_workflow_source_sha" });

// ── Malformed artifact SHA256 (not hex) ───────────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "xyz00000000000000000000000000000000000000000000000000000000000",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "malformed_artifact_sha256" });

// ── Malformed expected SHA256 (too short) ─────────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c4"
})).toMatchObject({ allowed: false, reason: "malformed_expected_sha256" });

// ── Uncommitted source ────────────────────────────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   false,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "uncommitted_source" });

// ── Source SHA mismatch ───────────────────────────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "source_sha_mismatch" });

// ── Workflow conclusion not success ───────────────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "failure",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "workflow_conclusion_not_success" });

// ── Wrong workflow name ───────────────────────────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "ci-build",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "wrong_workflow_name" });

// ── Wrong workflow path ───────────────────────────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/ci.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "wrong_workflow_path" });

// ── Wrong artifact name ───────────────────────────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "some-other-artifact",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "wrong_artifact_name" });

// ── Artifact file count invalid (missing sha256 file) ─────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "artifact_file_count_invalid" });

// ── Artifact file count invalid (extra files) ─────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256", "extra.txt"],
  artifactSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "artifact_file_count_invalid" });

// ── Checksum mismatch ─────────────────────────────────────────
expect(decideCalorixActionsApkFetch({
  requestedSourceSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workflowSourceSha:  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  workingTreeClean:   true,
  workflowConclusion: "success",
  workflowName:       "Build Android APK",
  workflowPath:       ".github/workflows/android-build.yml",
  artifactName:       "android-apk-a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  artifactFiles:      ["app-release.apk", "app-release.apk.sha256"],
  artifactSha256:     "aabbccdd00000000000000000000000000000000000000000000000000000000",
  expectedSha256:     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
})).toMatchObject({ allowed: false, reason: "checksum_mismatch" });
```

- [x] **Step 2: Run focused RED**

Run:

```bash
npx vitest run tests/unit/calorix-actions-apk-policy.test.ts
```

Expected: fail because the module is missing or decisions are unimplemented.

**Actual RED:** `npx vitest run tests/unit/calorix-actions-apk-policy.test.ts` — `1` failed test file, `0` tests executed, `Error: Cannot find module '../../scripts/lib/calorix-actions-apk-policy.mjs'`.

- [x] **Step 3: Implement the pure policy module**

Implement `scripts/lib/calorix-actions-apk-policy.mjs` with case-insensitive SHA/checksum normalization, no network I/O, and closed reason strings only. Also create `scripts/lib/calorix-actions-apk-policy.d.mts` with typed declarations: `normalizeGitSha(value: string): string` (throws on malformed input), `CalorixActionsApkFetchRejectionReason` union of the 12 rejection strings, discriminated `CalorixActionsApkFetchResult`, and `decideCalorixActionsApkFetch(input: unknown)` (never throws, fail-closed).

- [x] **Step 4: Run focused GREEN**

Run:

```bash
npx vitest run tests/unit/calorix-actions-apk-policy.test.ts
```

Expected: PASS.

**Actual GREEN:** Vitest `1` file passed, `90` tests passed. `npm run typecheck` PASS. `git diff --check` PASS. Combined focused `npx vitest run tests/unit/package-bin-lock.test.ts tests/unit/calorix-actions-apk-policy.test.ts` — `2` files, `95` tests PASS.

- [x] **Step 5: Repository verify and host checkpoint**

Run:

```bash
npm run verify
git diff --check
```

Host commit message: `Add Calorix Actions APK fetch policy guards`

**Actual full verify (2026-08-08, via parser-only LocateAnything venv):** `PATH=/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin:$PATH npm run verify` PASS: typecheck clean; 74 files / 1,389 TypeScript tests; 25 Python parser tests (sidecar); build clean; 3 integration files / 22 tests; `git diff --check` PASS. Focused policy: 93 tests. Combined package-bin + APK policy: 98 tests.

**Task 2 pre-review failures (2026-08-08):** Antigravity MCP `ask-ai` rejected before review for all three model routes:
1. `gemini-3.6-flash`: rejected `--effort ""` — available low/medium/high
2. `gemini-3.1-pro`: rejected `--effort ""` — available low/high
3. `gemini-3.5-flash`: rejected `--effort ""` — available low/medium/high

No response body, no repository mutation, no green review claimed.

**Task 2 post-review (2026-08-08):** same three routes (`gemini-3.6-flash`, `gemini-3.1-pro`, `gemini-3.5-flash`) all failed before review again — wrapper passed empty effort with same available sets; no response body, no mutation, no green review.

---

### Task 3: Shared Bash Helpers And ADB/Udev Installer

**Files:**
- Create: `scripts/lib/android-env-common.sh`
- Create: `scripts/install-android-platform-tools.sh`
- Create: `scripts/check-adb.sh`

**Interfaces:**
- Produces: idempotent installer for platform-tools/adb and Linux udev support.
- Produces: `check-adb.sh` that verifies binary presence/version and optional ReDroid visibility.
- Produces: shared loopback-publish assertion used by ReDroid scripts.

- [x] **Step 1: Write failing shell contract checks**

Create a focused manual/scripted checklist encoded as comments and executable asserts inside the scripts' `--self-test` or a small `scripts/check-android-env-contract.sh` that fails when:

- `assert_loopback_publish "0.0.0.0:5555:5555"` does not fail
- `assert_loopback_publish "127.0.0.1:5555:5555"` does not pass
- `install-android-platform-tools.sh --check-only` exits non-zero when `adb` is absent

Prefer pure bash assertions over network.

**Actual:** Created `tests/contract/android-env.test.sh` with 41 contract tests across 10 groups covering loopback publish, missing-adb check-only, usable-adb no-op, devices output, --expect-redroid pass/fail, cwd independence, fake adb/apt via PATH, no public publish string, script structure, and ReDroid defaults. Contract test file added to plan file map.

**Step 1 correction (2026-08-08):** The original 41-test suite used two separate `mktemp -d` temp dirs (the first leaked past the trap, which only cleaned the second), and its one no-override PATH-resolution test still set `UI_DIFF_ADB_BIN` (an override), so it never genuinely exercised PATH-only resolution or proved the installer's no-override/missing-adb privilege-check branch was reachable — the two assertions that should have caught the Step-4 unreachable-install-path bug (`install mentions root requirement`, `install uses resolved binary`) were themselves wrong/vacuous and were among the only 2 failures out of 49 actually-executed tests. Rewritten to: one shared temp dir; a `_path_without_adb` PATH fixture that keeps real shell utilities but filters out any directory containing a host `adb`, used for genuine no-override PATH-resolution and installer no-op tests; a genuine no-override/no-PATH-adb/non-root/no-sudo test proving the installer reaches and fails in the apt-get/privilege branch specifically (not the earlier override-fail-closed path); an invalid-explicit-override test proving apt-get is never invoked (file-based call log, not stdout grep); and an installer-with-override assertion on the exact resolved path/version rather than `adb devices` output (the installer never calls `adb devices`; that is `check-adb.sh`'s responsibility). Now 63 tests across 12 groups.

- [x] **Step 2: Run RED for missing helpers**

Run:

```bash
bash scripts/install-android-platform-tools.sh --check-only
bash scripts/check-adb.sh
```

Expected before implementation: missing script or missing adb failure with a clear remediation message.

**Actual RED:** `tests/contract/android-env.test.sh` — 41 run, 14 passed, 27 failed. All failures expected: scripts not yet implemented.

- [x] **Step 3: Implement common helpers**

`scripts/lib/android-env-common.sh` must:

- define ReDroid name/image/data-dir/adb host-port defaults
- implement `require_cmd`, `assert_loopback_publish`, and `fail`
- reject any publish spec that is not exactly `127.0.0.1:5555:5555` or an equivalent explicit loopback form documented in the script header

**Actual:** Implemented with `set -euo pipefail`, REPO_ROOT resolution from BASH_SOURCE, all ReDroid defaults pinned, `fail` (stderr + exit 1), `require_cmd`, and `assert_loopback_publish` (accepts only exactly `127.0.0.1:5555:5555`).

- [x] **Step 4: Implement installer and checker**

`scripts/install-android-platform-tools.sh`:

- detect existing `adb` and skip re-download when version is usable
- install platform-tools on Debian ARM64 when missing
- install or verify Linux udev rules supporting future physical phones (Android vendor rules or equivalent project-local rules under `/etc/udev/rules.d/` with documented reload)
- support `--check-only`
- be safe to re-run

`scripts/check-adb.sh`:

- print `adb version`
- run `adb devices`
- with `--expect-redroid`, require a device on `127.0.0.1:5555` or the connected emulator serial used by start-redroid
- never attempt to bind or rebind ADB to a public interface

**Actual:** `install-android-platform-tools.sh` --check-only exits 0 with version or exits 1 with remediation. Real install: Debian/Ubuntu via apt-get, root or noninteractive sudo required, no-op if adb usable (reports udev state), never curls platform-tools. `check-adb.sh` prints version and devices, --expect-redroid requires `127.0.0.1:5555\tdevice` line.

**Step 4 correction (2026-08-08, unreachable-install-path bug):** Root cause: `resolve_adb_bin` was fatal and was called unconditionally at the top of the installer before any install logic; when adb was absent it exited the whole process immediately, so the apt-get install branch (already unreachable a second time behind an earlier stray `exit 0`) could never run. Fix: `android-env-common.sh` now exports `try_resolve_adb_bin` (nonfatal — returns 1, no output, no exit; same override/PATH resolution rules, same fail-closed/no-PATH-fallback behavior for an explicit `UI_DIFF_ADB_BIN`) plus `resolve_adb_bin` as a thin fatal wrapper around it. The version-string match also stopped piping `adb version` output through `head -1 | grep -qi` under `set -o pipefail`, since a `grep -q` reader that exits early can SIGPIPE the upstream writer and make pipefail report failure even when the pattern matched; it now uses parameter-expansion first-line extraction plus a `case` glob match instead. `install-android-platform-tools.sh` was restructured: `--check-only` or any explicit `UI_DIFF_ADB_BIN` override now call fatal `resolve_adb_bin` and never attempt install; with no override, a nonfatal `try_resolve_adb_bin` decides between the already-usable no-op path and the apt-get install path (root/noninteractive-sudo check → `apt-get update`/`install` → fatal `resolve_adb_bin` verification), and the previously-dead code after the old inline `exit 0` was removed. RED (this correction): `timeout 60 bash tests/contract/android-env.test.sh` — with the pre-fix scripts, the rewritten contract suite (see Step 1 update) failed 3 of the 3 new no-override/missing-PATH-adb privilege-branch assertions (installer exited 0 immediately via the fatal top-of-script `resolve_adb_bin` "adb not on PATH" message instead of reaching the apt-get attempt/root remediation). GREEN: `timeout 60 bash tests/contract/android-env.test.sh` — 63 run, 63 passed, 0 failed. `bash -n` syntax check PASS for `scripts/lib/android-env-common.sh`, `scripts/install-android-platform-tools.sh`, `scripts/check-adb.sh`, and `tests/contract/android-env.test.sh`. `git diff --check` PASS (no whitespace errors). `check-adb.sh` was not modified (it already only ever needs a usable adb and has no install branch). Full `npm run verify` and live gates were not run for this bounded shell-only correction; no production-readiness claim.

- [ ] **Step 5: Run GREEN on the Pi host** (partial/blocked)

Run:

```bash
bash scripts/install-android-platform-tools.sh
bash scripts/install-android-platform-tools.sh --check-only
bash scripts/check-adb.sh
bash scripts/install-android-platform-tools.sh
```

Expected: first install succeeds or no-ops correctly; second install is idempotent; check passes binary presence even if no device is connected yet.

**Actual (2026-08-08):** `--check-only` correctly exits 1 with exact remediation message (`adb is not installed or not usable. Install with: sudo apt-get install adb android-sdk-platform-tools-common`). This host lacks adb and root/noninteractive sudo — expected environment blocker, not test failure. Contract tests GREEN 41/41 with fake adb. Syntax checks PASS. `git diff --check` PASS.

**Actual (2026-08-08, post-correction):** Re-ran on this host after the Step 4 unreachable-install-path fix and the Step 1 test-suite correction: `bash scripts/install-android-platform-tools.sh --check-only` still exits 1 with the same remediation message (no adb on PATH); a genuine no-override, no-fake-adb, no-root, no-working-sudo run of `bash scripts/install-android-platform-tools.sh` (no `UI_DIFF_ADB_BIN` set) now correctly reaches and prints `adb not found on PATH; installing via apt-get...` before failing closed on the root/noninteractive-sudo requirement, proving the previously-unreachable branch is reachable. Still blocked on this host by the same environment prerequisite (no root/noninteractive sudo, no real network apt-get run) — environment blocker, not a code/test failure. Contract suite GREEN 63/63 (`timeout 60 bash tests/contract/android-env.test.sh`). Syntax checks PASS for all 3 scripts plus the test file. `git diff --check` PASS. Full `npm run verify` and live gates were not run for this bounded correction; no production-readiness claim.

**Host re-verification (2026-08-08):** Host reran the syntax and shell contract checks — 63/63 PASS. Real Pi `--check-only` run exited 1 with the adb-missing remediation. The normal no-override run reached the apt-get path then failed closed on the root/noninteractive-sudo prerequisite. The earlier full `npm run verify` result remains recorded in status. Step 5 remains partial/blocked; Step 6 is complete at `40f91e0` on `origin/master`. No production-readiness claim.

- [x] **Step 6: Host checkpoint**

Host commit message: `Add adb and udev setup scripts for Pi host`

**Implemented:** Host committed and pushed at `40f91e0` on `origin/master`.

---

### Task 4: ReDroid Start/Stop/Reset Scripts

**Files:**
- Create: `scripts/start-redroid.sh`
- Create: `scripts/stop-redroid.sh`
- Create: `scripts/reset-redroid.sh`
- Modify: `scripts/lib/android-env-common.sh` if shared defaults need extension

**Interfaces:**
- Produces: Docker ReDroid ARM64 container with software rendering, persistent data directory/volume, `/dev/kvm` and binder device access when present, ADB published only to `127.0.0.1:5555`.
- Produces: stop without data loss; reset with explicit data wipe.

- [x] **Step 1: Encode failing security/contract assertions**

Before implementation, add script-level preflight tests that fail if start would:

- publish ADB as `0.0.0.0:5555:5555`
- omit software-rendering flags required by the pinned ReDroid ARM64 image
- omit persistent data mount
- silently continue when Docker is absent

Document the exact docker run shape in the start script header, including image tag, restart policy, and device mounts.

**Actual RED and test audit (2026-08-08):** The initial delegated worker left a contract suite but no lifecycle scripts. After auditing it, the suite was corrected to avoid real host state-directory writes, to verify successful baseline launch before inspecting its fake Docker command, to model Docker state transitions through stop/remove/run, and to fail closed rather than reward an attempted `mknod` over a binderfs directory. Reset coverage was extended to reject dot components and both parent and leaf symlink escapes. Against the missing scripts it ran `82` checks: `33` passed and `49` failed for the expected absent lifecycle behaviors and reset guards.

- [x] **Step 2: Implement `start-redroid.sh`**

Required behavior:

- require Docker
- detect host features before starting: check `/dev/kvm` existence (optional, report if present/absent) and binder node presence (`/dev/binder`, `/dev/hwbinder`, `/dev/vndbinder`); require CONFIG_ANDROID_BINDER_IPC and legacy binder devices; record detection results; if binder nodes are absent, inspect `/sys/class/misc/{binder,hwbinder,vndbinder}/dev` for kernel-reported major:minor pairs and create `/dev/binder c <major> <minor>` (and similarly for hwbinder/vndbinder) only from those values; if sysfs registrations are absent, fail closed and instruct root/operator to fix or reboot the kernel setup. Never map binderfs directories as device files and never guess numbers.
- document privileged Docker requirement in script header: ReDroid requires `--privileged` or equivalent capabilities (`SYS_ADMIN`, `NET_ADMIN`) to access binder devices; document the security risk that `--privileged` grants full host device access; note that loopback-only ADB mitigates network exposure but not host device access
- create persistent data dir `${UI_DIFF_REDROID_DATA_DIR}` if missing
- use pinned ARM64 ReDroid image: `redroid/redroid@sha256:46478a567194aed24cd0877d4434a9e58b534d4aad30931eb21999a52f2ce131` (source tag `redroid/redroid:14.0.0_64only-latest`; manifest-list digest `sha256:0a611199ba2e0b5d60af39b3327a517f6407231f4352114ed3bd3cbfe2be69aa`). Before implementation, verify the digest with `docker manifest inspect redroid/redroid:14.0.0_64only-latest` and confirm the arm64 entry matches the pinned digest.
- enable software rendering only via official guest flags: `androidboot.redroid_gpu_mode=guest` and `androidboot.use_memfd=1`
- pass `/dev/kvm` when present (optional); require binder nodes (`/dev/binder`, `/dev/hwbinder`, `/dev/vndbinder`); if binder nodes are missing, inspect `/sys/class/misc/{binder,hwbinder,vndbinder}/dev` for kernel-reported major:minor pairs and create the device nodes only from those values; if sysfs registrations are absent, fail closed with exact root remediation (fix or reboot the kernel setup) rather than starting a half-working container. Never guess major:minor numbers. Use official `--privileged` with security warning documented in script header.
- publish ADB only as `127.0.0.1:5555:5555`
- wait until `adb connect 127.0.0.1:5555` succeeds or time out with a clear error
- be idempotent: if the named container is already running and healthy on loopback ADB, exit 0

**Implemented:** `scripts/start-redroid.sh` sources the shared helper, performs Docker CLI/API preflight before adb resolution, handles a healthy named container as an idempotent no-op, removes stopped/unhealthy containers, validates/creates the persistent data directory, creates only missing binder character nodes from validated sysfs values, conditionally maps a real character `/dev/kvm`, launches exactly the pinned digest with `--restart unless-stopped`, `--privileged`, the exact loopback publish, `/data` mount, and the two guest-rendering flags, then performs bounded `adb connect` plus `get-state` readiness. The header documents the source tag, manifest-list digest, and privileged-access risk.

- [x] **Step 3: Implement `stop-redroid.sh` and `reset-redroid.sh`**

- `stop-redroid.sh` stops/removes the container but keeps persistent data
- `reset-redroid.sh --yes` stops, deletes persistent data, and starts clean
- `reset-redroid.sh` without `--yes` must refuse to wipe data

**Implemented:** `scripts/stop-redroid.sh` is a Docker-preflighted no-op for an absent container and otherwise stops/removes it while preserving data. `scripts/reset-redroid.sh` refuses all invocations other than `--yes`, validates the complete data-directory path before deletion (including root, relative, dot, shallow, basename, and symlink-escape guards), stops/removes the container, recreates the data directory, and execs the start script.

- [ ] **Step 4: Run focused host verification**

Run on the Pi:

```bash
bash scripts/start-redroid.sh
bash scripts/check-adb.sh --expect-redroid
adb -s 127.0.0.1:5555 shell getprop ro.product.cpu.abi
bash scripts/stop-redroid.sh
bash scripts/start-redroid.sh
bash scripts/reset-redroid.sh --yes
bash scripts/check-adb.sh --expect-redroid
ss -ltn | grep 5555 || true
```

Expected:

- ReDroid reachable on loopback after start/reset
- ABI is ARM64-compatible
- listening address for 5555 is local-only (`127.0.0.1`), never a public bind
- stop leaves data; reset recreates a clean instance

**Partial (2026-08-08):** host-independent shell verification is green: `bash -n` passed for the common helper, all lifecycle scripts, and both contract suites; `tests/contract/redroid-lifecycle.test.sh` passed `102/102`; `tests/contract/android-env.test.sh` passed `63/63`; ASCII and `git diff --check` passed. Full `PATH=/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin:$PATH npm run verify` passed: typecheck; 74 files / 1,389 TypeScript tests; 25 Python parser tests; build; 3 integration files / 22 tests. The added guards accept `aarch64`/`arm64`, reject `x86_64` before `docker run`, and require `UI_DIFF_KERNEL_CONFIG` or `/boot/config-$(uname -r)` to contain `CONFIG_ANDROID_BINDER_IPC=y` plus binder, hwbinder, and vndbinder. Real `bash scripts/start-redroid.sh` exited `1` because `docker info` was inaccessible. Pi evidence: `aarch64`, kernel `6.18.34+rpt-rpi-v8`, readable boot config with those values, unavailable `/proc/config.gz`, absent binder device files and sysfs registrations, present `/dev/kvm` character device, and absent Docker access/noninteractive sudo/adb. The image provenance remains `redroid/redroid:14.0.0_64only-latest`, manifest-list `sha256:0a611199ba2e0b5d60af39b3327a517f6407231f4352114ed3bd3cbfe2be69aa`, and runtime digest `sha256:46478a567194aed24cd0877d4434a9e58b534d4aad30931eb21999a52f2ce131`. These are host/bootstrap blockers, not a contract-test pass or production-readiness claim.

- [x] **Step 5: Evidence-policy note in README/status**

Record explicitly:

- ReDroid evidence is valid for platform-independent UI/layout/state/navigation
- phone-only properties remain phone-gated
- missing phone does not globally block production validation

**Implemented:** README, status, and this plan state the evidence boundary. ReDroid is valid for platform-independent UI/layout/state/navigation assertions; phone-only properties remain phone-gated; missing physical-phone access does not globally block validation for properties ReDroid covers.

- [x] **Step 6: Host checkpoint**

Host commit message: `Add ReDroid lifecycle scripts with loopback-only ADB`

**Checkpoint:** committed and pushed at `c182cf6`. Step 4 remains partial and
blocked by the recorded Pi root/Docker/adb prerequisites.

---

### Task 5: Verified Calorix Actions APK Fetch Script

**Files:**
- Create: `scripts/fetch-calorix-actions-apk.sh` (uses `scripts/lib/calorix-actions-apk-policy.mjs` for decision logic)
- Modify: `README.md` usage section

**Interfaces:**
- Produces: optional APK download path that is current evidence only after source-SHA equality and checksum verification.
- Rejects: dirty requested source, workflow SHA mismatch, checksum mismatch.

- [x] **Step 1: Write failing CLI contract cases**

Using a temporary fixture directory, assert the script exits non-zero when:

- `--source-sha` is empty
- caller marks working tree dirty / omits clean proof
- workflow source SHA fixture differs from requested SHA
- checksum fixture differs from APK digest

No real GitHub network is required for these fixture cases. Networked success path is a separate optional live check.

**Actual RED (2026-08-08):** before the script existed, `timeout 60s bash tests/contract/calorix-actions-apk-fetch.test.sh` produced `2 run, 2 passed, 0 failed`: the expected command-not-found exit (`127`) and no output-file side effect. The suite then became the deterministic GREEN harness; it fakes `gh` through `PATH` and performs no network I/O.

- [x] **Step 2: Implement the fetch script**

Required flow:

1. Parse `--repo`, `--source-sha`, optional `--workflow` (default `android-build.yml`), optional `--artifact-name` (default `android-apk-<source-sha>`), `--output`
2. Resolve the single workflow run whose head SHA equals the requested committed source SHA. The run must satisfy all of:
   - Workflow name is exactly `Build Android APK`
   - Workflow file path is exactly `.github/workflows/android-build.yml`
   - Workflow conclusion is exactly `success`
   - Head commit SHA equals the requested source SHA exactly
   - Record the immutable run database id (the numeric `id` field from `gh api` or `gh run view`)
3. Download exactly one artifact by that run's database id to a temp directory. The artifact must contain exactly one `.apk` file and exactly one matching `<apk-basename>.sha256` file (same basename, `.sha256` extension). Reject the download if the artifact contains any other file count.
4. Compute local SHA256 of the APK file
5. Call the same decision rules as `decideCalorixActionsApkFetch`
6. On allow, move APK to `--output` and write a sidecar verification record `${output}.verified.json` containing:
   - `run_id`: immutable run database id (numeric)
   - `workflow`: object with `name` and `path` exactly matching the expected values
   - `source_sha`: the requested source SHA (40-char hex, lowercase)
   - `artifact_name`: the exact artifact name downloaded
   - `apk_filename`: the APK basename (e.g., `app-release.apk`)
   - `checksum_filename`: the checksum filename (e.g., `app-release.apk.sha256`)
   - `digest`: the lowercase hex SHA256 digest of the APK file
7. On deny, delete temp artifacts and exit non-zero with the exact reason

Never label an unverified file as current evidence.

**Implemented:** `scripts/fetch-calorix-actions-apk.sh` accepts only the canonical `android-build.yml` identifier, exact 40-hex source SHA, and affirmative `--source-clean` proof. It uses only `gh api --method GET` with the requested SHA and workflow identifier, selects exactly one completed successful `Build Android APK` run at `.github/workflows/android-build.yml`, validates its numeric immutable run ID, downloads the requested artifact by that ID, rejects every recursive layout other than one versioned APK plus same-basename checksum, applies the existing policy helper as the final decision, and atomically publishes the APK plus provenance sidecar only on allow. Output paths must end in `.apk`, have an existing parent, and cannot overwrite an existing output or record.

- [x] **Step 3: Fixture GREEN**

Run the fixture denial/acceptance cases without network.

**Actual GREEN (2026-08-09):** `bash -n scripts/fetch-calorix-actions-apk.sh tests/contract/calorix-actions-apk-fetch.test.sh` PASS; `timeout 120s bash tests/contract/calorix-actions-apk-fetch.test.sh` - `65 run, 65 passed, 0 failed`; the prior `npx vitest run tests/unit/calorix-actions-apk-policy.test.ts` result remains `1` file, `93` tests PASS. The shell fixture covers a genuine single empty-SHA argument with no GitHub call/output; malformed/duplicate/unknown arguments; omitted/dirty clean proof; no/multiple/mismatched/failed/wrong-name/wrong-path runs; wrong artifact/download failure; extra/missing/symlink/nested files; malformed/mismatched/multi-line checksum; all typed verification-record fields and exact output APK digest; spaces in output; uppercase SHA normalization; temporary cleanup; explicit GET; numeric run-ID download; and missing `awk` failing dependency preflight before GitHub access. Missing-`awk` RED was `50/53`: the script reached line 218 with `awk: command not found` after the fake GitHub call. Real-checksum-format RED was `63/65`: the safe `dist/calorix-1.0.0+1-android-release.apk` checksum target alone failed as `malformed_expected_sha256`. The parser now accepts safe relative target components only when the basename exactly equals the flattened APK filename; it rejects absolute paths, backslashes, empty/dot/dotdot components, traversal, and different basenames without using that target to open a file.

- [x] **Step 4: Optional networked check when credentials exist**

If `gh` auth and a known Calorix release workflow are available, run one real fetch against a committed SHA and record run id, source SHA, and checksum result in status. If unavailable, record the exact blocker (missing auth, missing workflow, network error) and do not invent success.

**Live RED (2026-08-09):** the first fetch against a clean detached Calorix worktree at source SHA `1f538641f5e5f5c4a48c95cdfb97462838187106` and Actions run `31182023073` failed `malformed_expected_sha256`. The checksum line retained the safe target `87475182256c6733eb80fed0b35afe3a53a1ca2ef91ce010d016d3fbb3717e92  dist/calorix-1.0.0+1-android-release.apk`, while upload-artifact flattened the uploaded files to `calorix-1.0.0+1-android-release.apk` and its matching checksum file. New TDD was RED `63/65`; GREEN `65/65`. The parser accepts safe relative prefixes only when the basename exactly matches the flattened APK filename and rejects absolute, backslash, empty, dot, dotdot, traversal, or different-basename targets.

**Live GREEN (2026-08-09):** rerun passed for workflow `Build Android APK` at `.github/workflows/android-build.yml`, source SHA `1f538641f5e5f5c4a48c95cdfb97462838187106`, and artifact `android-apk-1f538641f5e5f5c4a48c95cdfb97462838187106`. The artifact contained APK `calorix-1.0.0+1-android-release.apk` and checksum `calorix-1.0.0+1-android-release.apk.sha256`; APK size was `64446420` bytes and verified digest was `87475182256c6733eb80fed0b35afe3a53a1ca2ef91ce010d016d3fbb3717e92`. Independent verification-record validation passed (`true`), and the temporary worktree and downloaded artifacts were cleaned.

**Final Task 5 verification (2026-08-09, Europe/Zurich):** `npm run verify` exited `0`; typecheck was clean; 74 files / 1,389 TypeScript tests passed; 25 Python parser tests passed; the build was clean; and 3 integration files / 22 tests passed. Focused shell verification remained `65/65`; policy verification remained `93/93`.

**Task 5 post-review attempts (2026-08-09, Europe/Zurich):** Gemini 3.6 Flash, Gemini 3.1 Pro, and Gemini 3.5 Flash all failed before review because the Antigravity wrapper supplied empty effort. Their available sets were respectively `low`/`medium`/`high`, `low`/`high`, and `low`/`medium`/`high`. No response body, repository mutation, or green review was produced.

Task 5 Steps 1-5 are complete and verified. The host checkpoint was committed
and pushed at `fab303a`. No production-readiness claim.

- [x] **Step 5: Host checkpoint**

Host commit message: `Add verified Calorix Actions APK fetch script`

---

### Task 6: LocateAnything Sidecar Linux Bash Launcher

**Files:**
- Create: `scripts/start-locateanything-sidecar.sh`
- Create: `tests/contract/locateanything-sidecar-launcher.test.sh` (shell contract checks)

**Interfaces:**
- Produces: idempotent bash launcher that starts the LocateAnything sidecar on loopback port 39731.
- Resolves Python: `LOCATEANYTHING_PYTHON` env → repo-local `/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin/python` (if it exists) → system `python3`.
- Resolves Eagle Embodied dir: `LOCATEANYTHING_EAGLE_EMBODIED_DIR` env → default `/home/agent-runner/projects/Eagle/Embodied` if env is unset and the directory exists; otherwise fails with exact remediation.
- Starts `uvicorn sidecars.locateanything.server:app` bound to `127.0.0.1:39731` only.
- Health-checks `/health` endpoint before declaring ready.
- Never exposes the sidecar on `0.0.0.0` or LAN interfaces.

- [x] **Step 1: Write failing contract checks**

Create `tests/contract/locateanything-sidecar-launcher.test.sh` that asserts:
- Script exits non-zero when `LOCATEANYTHING_PYTHON` is unset and no `/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin/python` exists and system `python3` is absent
- Script exits non-zero when `LOCATEANYTHING_EAGLE_EMBODIED_DIR` is unset and `/home/agent-runner/projects/Eagle/Embodied` does not exist
- When run with a temp fake python executable (a script that starts a local HTTP server responding to `/health` with 200 OK), script exits 0 and reports ready
- All tests must use temp directories, fake executables, and a local fake health endpoint; no dependency on real sidecar, real model, or network

- [x] **Step 2: Run RED for missing launcher**

Run:
```bash
bash tests/contract/locateanything-sidecar-launcher.test.sh
```
Expected: fail because `start-locateanything-sidecar.sh` does not exist.

- [x] **Step 3: Implement the launcher**

Create `scripts/start-locateanything-sidecar.sh`:
- Parse `--check-only` flag (verify python and dir exist without starting)
- Resolve python: `LOCATEANYTHING_PYTHON` env → `/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin/python` → system `python3`
- Resolve Eagle Embodied dir: `LOCATEANYTHING_EAGLE_EMBODIED_DIR` env → `/home/agent-runner/projects/Eagle/Embodied` if env unset and dir exists → fail with remediation
- Start uvicorn in background, bound to `127.0.0.1:39731`
- Health-check loop: poll `http://127.0.0.1:39731/health` until ready or timeout
- Print PID for caller tracking
- Be idempotent: if already running and healthy, exit 0

- [x] **Step 4: Run GREEN**

Run:
```bash
bash tests/contract/locateanything-sidecar-launcher.test.sh
```
Expected: PASS.

- [x] **Step 5: Update Linux env variables/paths in AGENTS.md and README**

In the final documentation task (Task 7), update AGENTS.md environment section to include:
- `LOCATEANYTHING_PYTHON` default path on Linux: `/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin/python` (sibling shared venv), fallback `python3`
- `LOCATEANYTHING_EAGLE_EMBODIED_DIR` default path on Linux: `/home/agent-runner/projects/Eagle/Embodied`
- LocateAnything sidecar start command: `bash scripts/start-locateanything-sidecar.sh`

**Actual (2026-08-09):**
- [x] README Linux launcher usage is complete.
- [x] `AGENTS.md` now contains the complete Pi environment and delegation-policy migration from Task 7.

- [x] **Step 6: Host checkpoint**

Host commit message: `Add LocateAnything sidecar Linux bash launcher`

**Checkpoint:** committed and pushed at `026fc19`.

**Task 6 verification (2026-08-09):** RED: before the launcher existed,
`bash tests/contract/locateanything-sidecar-launcher.test.sh` exited `1` with
`1 run, 0 passed, 1 failed` because the launcher command returned `127`.
GREEN: `bash -n scripts/start-locateanything-sidecar.sh tests/contract/locateanything-sidecar-launcher.test.sh` and
`timeout 90s bash tests/contract/locateanything-sidecar-launcher.test.sh`
passed with `68 run, 68 passed, 0 failed`. The host `--check-only` command
exited `1` without starting a process. The selected parser-only venv reports
Python `3.11.15` and can import `sidecars.locateanything.server`, but lacks
`uvicorn`; install `sidecars/locateanything/requirements.txt`. Separately,
`/home/agent-runner/projects/Eagle/Embodied` is absent or lacks
`locateanything_worker`; install a valid Eagle Embodied checkout or set the
explicit directory override. This is not a full sidecar environment.

**Full repository verification (2026-08-09):** `npm run verify` exited `0`:
typecheck clean; 74 files / 1,389 TypeScript tests; 25 Python parser tests;
build clean; 3 integration files / 22 tests. `bash -n`, ASCII, and
`git diff --check` also passed.

**Idempotence ordering correction (2026-08-09):** RED was `54 run, 49 passed,
5 failed`: invalid explicit Python/Eagle and unavailable `nohup` prevented an
already-healthy no-op, and startup validation hid a pre-existing health error.
GREEN was `54 run, 54 passed, 0 failed`. Normal invocation now validates
settings and `curl`/`node`, checks `/health`, returns or surfaces its error, and
only then resolves Python/Eagle and requires `nohup` when a start is needed.
`--check-only` still validates health plus startup dependencies without any
health request or process start.

**Launch-surface preflight correction (2026-08-09):** RED was `68 run, 61
passed, 7 failed`: check-only accepted an interpreter lacking `uvicorn`, and
an unready normal run spawned then polled instead of failing before launch.
GREEN was `68 run, 68 passed, 0 failed`. After Python selection, startup now
imports `uvicorn` and `sidecars.locateanything.server` from `REPO_ROOT`; failure
names the selected interpreter and the exact requirements install command.
Already-healthy normal invocation still bypasses Python/module/Eagle/nohup
checks. Host confirmation: Python version exit `0`, uvicorn exit `1`, server
import exit `0`, launcher check-only exit `1`; the Eagle checkout is also
separately missing. No full-sidecar-environment claim.

**Task 6 post-review attempts (2026-08-09):** Gemini 3.6 Flash, Gemini 3.1
Pro, and Gemini 3.5 Flash all failed before review because the wrapper supplied
empty effort. Their available effort sets were respectively
`low`/`medium`/`high`, `low`/`high`, and `low`/`medium`/`high`. No response
body, repository mutation, or green review was produced.

Task 6 Steps 1-4 are complete. Step 5's README portion is complete; its
`AGENTS.md` portion remains pending Task 7. Step 6 remains pending the host
commit/push checkpoint. No production-readiness claim.

---

### Task 7: Documentation, AGENTS.md Update, Final Verify, And Handoff To Task 8

**Files:**
- Modify: `AGENTS.md` to add Pi/bash environment section and update worker route order
- Modify: `README.md`
- Modify: `docs/implementation-status.md`
- Modify: this plan checkboxes as tasks complete
- Do not modify: Task 8 structural implementation modules

**Interfaces:**
- Produces: operator docs for Pi setup, ReDroid lifecycle, adb/udev, and APK fetch
- Produces: status handoff that resumes Task 8 Stage A structural source-facts after migration is green

- [x] **Step 1: Update AGENTS.md with Pi/bash environment, delegation policy, and worker route**

In `AGENTS.md`, add a Pi/bash environment section documenting:
- Target host: Raspberry Pi 4 ARM64 Debian, bash shell
- Docker with `/dev/kvm` (optional, detected/reported) and binder device support for ReDroid
- ReDroid ARM64 container with software rendering, loopback-only ADB (`127.0.0.1:5555`), persistent data
- platform-tools/adb and Linux udev for future physical phone
- LocateAnything sidecar: Linux bash launcher (`scripts/start-locateanything-sidecar.sh`); resolves `LOCATEANYTHING_PYTHON` → `/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin/python` (sibling shared venv) → `python3`; resolves `LOCATEANYTHING_EAGLE_EMBODIED_DIR` → `/home/agent-runner/projects/Eagle/Embodied`; starts uvicorn at loopback port 39731
- Calorix Actions APK fetcher: source-SHA match + SHA256 verification required
- `package-lock.json` root bin must stay `dist/src/index.js`
- Root/bootstrap blockers: adb install, docker-group membership, binder node setup, and ReDroid smoke may require root/sudo; record exact blocker and remediation

Replace the old OpenCode-only editing delegation policy (section 4) with the full worker route. Canonical invocation commands must be literal for each model:

```bash
# 1. grok-4.5 high (primary) — binary at ~/.grok/bin/grok if not on PATH
~/.grok/bin/grok -p "<prompt>" --model grok-4.5 --reasoning-effort high --cwd <repo> --permission-mode bypassPermissions --output-format plain

# 2. qwen3.7-max
qwen -p "<prompt>" --model qwen3.7-max --output-format text

# 3. opencode/nemotron-3-ultra-free
opencode run --model opencode/nemotron-3-ultra-free --auto --dir <repo> "<prompt>"

# 4. opencode/mimo-v2.5-free
opencode run --model opencode/mimo-v2.5-free --auto --dir <repo> "<prompt>"

# 5. opencode/deepseek-v4-flash-free
opencode run --model opencode/deepseek-v4-flash-free --auto --dir <repo> "<prompt>"

# 6. Claude paid (last)
claude -p "<prompt>" --model claude-fable-5 --dangerously-skip-permissions --output-format text
```

Record that exact failure timestamp, model, category, and message must be logged before each fallback. Do not merely append a conflicting route; replace the old policy entirely.

- [x] **Step 2: Document operator commands**

README must include exact commands:

```bash
bash scripts/install-android-platform-tools.sh
bash scripts/start-redroid.sh
bash scripts/check-adb.sh --expect-redroid
bash scripts/start-locateanything-sidecar.sh --check-only
bash scripts/start-locateanything-sidecar.sh
bash scripts/fetch-calorix-actions-apk.sh --repo ia23a-lachnita/calorix --source-sha <40-hex-sha> --source-clean --workflow android-build.yml --artifact-name android-apk-<40-hex-sha> --output /path/calorix-release.apk
bash scripts/stop-redroid.sh
bash scripts/reset-redroid.sh --yes
bash scripts/verify-package-bin-lock.sh
PATH=/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin:$PATH npm run verify
```

- [x] **Step 3: Final deterministic verification**

Run:

```bash
bash scripts/verify-package-bin-lock.sh
npx vitest run tests/unit/package-bin-lock.test.ts tests/unit/calorix-actions-apk-policy.test.ts
PATH=/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin:$PATH npm run verify
git diff --check
```

**Actual (2026-08-09):** package-bin guard PASS; focused package/APK
policy tests `98/98`; Android environment `63/63`; ReDroid lifecycle
`102/102`; Actions APK fetch `65/65`; sidecar launcher `68/68`. Plain
`npm run verify` first passed typecheck and `74` files / `1,389` TypeScript
tests, then failed because system Python 3.13 lacked FastAPI. The documented
PATH-prefixed command passed: typecheck; `74` files / `1,389` TypeScript tests;
`25` Python parser tests; build; `3` integration files / `22` tests.
`git diff --check` passed.

- [ ] **Step 4: Final host environment smoke on Pi** (partial/blocked)

Run:

```bash
bash scripts/install-android-platform-tools.sh --check-only
bash scripts/start-redroid.sh
bash scripts/check-adb.sh --expect-redroid
bash scripts/stop-redroid.sh
```

Record whether `/dev/kvm` was present (optional) and whether binder nodes were present (required). If binder setup required root, record whether root/sudo was available. If a physical phone is absent, record that phone-only claims remain blocked while ReDroid platform-independent evidence remains usable.

**Actual (2026-08-09):** `aarch64`, kernel `6.18.34+rpt-rpi-v8`, and
`/dev/kvm` present. adb is absent. Docker is installed but inaccessible to this
user. binder/hwbinder/vndbinder device nodes and sysfs registrations are
absent. Noninteractive sudo is unavailable. The sidecar parser venv lacks
`uvicorn`, and the Eagle Embodied checkout is absent. Start/stop/check commands
all failed closed with exact remediation; no container or sidecar was started.
Physical-phone-only claims remain blocked, while the hermetic ReDroid contracts
remain valid evidence for the platform-independent implementation.

- [x] **Step 5: Status handoff back to Task 8**

Update `docs/implementation-status.md` so that after migration completion:

- Pi environment migration is recorded complete with commit hash and verification
- Current task returns to **Task 8 retained-relation hardening Stage A: structural source facts**
- Query provenance at `782119e` remains the code baseline unless later commits supersede it
- Live/readiness checkboxes remain unchecked until Task 8 and fresh gates complete
- No production-readiness claim

- [x] **Step 6: Host final commit and push**

Host commit message: `Complete Pi development environment setup docs and scripts`

**Checkpoint:** documentation, verification, and handoff committed and pushed at
`33f1f67`. Host bootstrap remains partial/blocked as recorded in Step 4; Task 8
can resume for platform-independent implementation without claiming live Android
or production readiness.

Then resume Task 8 structural source-facts implementation under the structural plan, not this plan.

---

## Worker Route Failure Recording Template

Before every worker fallback, append a status/progress note with all four fields:

```text
timestamp: <ISO-8601 with timezone>
model: <exact model id>
category: <quota|timeout|tool_error|empty_output|invalid_route|other>
message: <exact provider/tool message, no secrets>
```

Worker order:

1. `grok-4.5` high
2. `qwen3.7-max`
3. `opencode/nemotron-3-ultra-free`
4. `opencode/mimo-v2.5-free`
5. `opencode/deepseek-v4-flash-free`
6. `claude-fable-5` paid

## Antigravity Review Record For This Plan Stage

| Timestamp date | Route | Result |
|---|---|---|
| 2026-08-08 | `gemini-3.6-flash` | rejected empty `--effort` before review; no response; not green |
| 2026-08-08 | `gemini-3.1-pro` | rejected empty `--effort` before review; no response; not green |
| 2026-08-08 | `gemini-3.5-flash` | rejected empty `--effort` before review; no response; not green |
| 2026-08-09 | `gemini-3.6-flash` (available `low`/`medium`/`high`) | rejected empty `--effort` before review; no response body; no repository mutation; not green |
| 2026-08-09 | `gemini-3.1-pro` (available `low`/`high`) | rejected empty `--effort` before review; no response body; no repository mutation; not green |
| 2026-08-09 | `gemini-3.5-flash` (available `low`/`medium`/`high`) | rejected empty `--effort` before review; no response body; no repository mutation; not green |

No external green pre-review is claimed for this drafting stage. Implementation tasks still require host verification and, when the review tool works, post-implementation Antigravity review with the separate model order above.

## Verification Matrix

| Stage | Focused command | Repository gate | Host/live |
|---|---|---|---|
| Task 1 | `npx vitest run tests/unit/package-bin-lock.test.ts` + `bash scripts/verify-package-bin-lock.sh` + cross-platform `DEFAULT_CALORIX_PROJECT_ROOT` (import.meta.url derivation) + E2E Windows-literal replacement + sibling-path assertion | `npm run verify` PASS: typecheck clean; 73 files / 1,296 TS tests; 25 Python parser tests (sidecar); build clean; 3 integration files / 22 tests; `git diff --check` clean | parser-only venv; no full LocateAnything model env |
| Task 2 | `npx vitest run tests/unit/calorix-actions-apk-policy.test.ts` | `npm run verify` | none |
| Task 3 | `bash scripts/install-android-platform-tools.sh --check-only` + `bash scripts/check-adb.sh` | `npm run verify` | Pi package install |
| Task 4 | `bash scripts/start-redroid.sh` + `bash scripts/check-adb.sh --expect-redroid` | `npm run verify` | Docker/ReDroid smoke |
| Task 5 | fixture fetch denials/acceptance | `npm run verify` | optional real Actions fetch |
| Task 6 | `bash tests/contract/locateanything-sidecar-launcher.test.sh` | `npm run verify` | sidecar health-check |
| Task 7 | package-bin + policy focused suite | `npm run verify` | final Pi smoke + status handoff |

## Explicit Non-Claims

- Completing this plan does not complete Task 8 structural source-facts.
- Completing this plan does not by itself make production readiness true.
- ReDroid success does not prove OEM rendering, camera, sensor, thermal, or physical screenshot parity.
- Failed Antigravity empty-effort routes are tooling failures, not review approval.
