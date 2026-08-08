# Raspberry Pi Development Environment Design

**Status:** approved for implementation planning (documentation stage only)

**Date:** 2026-08-08

**Purpose:** define a bounded Raspberry Pi 4 ARM64 development and validation environment for `ui-diff-mcp` and Calorix live gates so structural source-facts work (Task 8 Stage A) can resume on a stable Linux host without conflating environment setup with pipeline implementation.

## Problem

Active structural work is Task 8 retained-relation hardening Stage A (query provenance and structural source facts) on plan `docs/superpowers/plans/2026-07-30-structural-container-parent-first-consolidation.md`. Query provenance is already at HEAD `782119e`. Remaining structural source-facts work must not be mixed with host migration.

The previous Windows host path is not the target environment for continued live Android capture. The project needs an idempotent Pi 4 ARM64 Debian environment with:

- Docker-hosted ReDroid for everyday UI/layout/state/navigation evidence
- platform-tools/ADB and Linux udev rules for a future physical phone
- a fail-closed path to download only SHA-matched Calorix GitHub Actions release APKs
- worker/edit routing that records exact failures before fallback
- explicit preservation of the intentional `package-lock.json` bin path `dist/src/index.js`

## Non-Goals

- Do not implement Task 8 structural source-facts in this environment stage.
- Do not change pipeline, provider, schema, locator, or MCP implementation code in the drafting stage.
- Do not alter `AGENTS.md` in the drafting stage.
- Do not treat ReDroid as a substitute for OEM rendering, camera hardware, sensors, thermals/performance, or physical-device screenshot parity.
- Do not expose ADB on any non-loopback address.
- Do not use a Calorix Actions APK as current evidence when the requested source is uncommitted or the workflow source SHA differs from the requested committed source SHA.

## Target Host

| Property | Required value |
|---|---|
| Hardware | Raspberry Pi 4 |
| Architecture | ARM64 (`aarch64`) |
| OS | Debian (64-bit) |
| Shell | bash |
| Container runtime | Docker with `/dev/kvm` and binder support available to ReDroid |
| Primary Android runtime | ReDroid ARM64 image in Docker |
| Rendering | software rendering only for ReDroid |
| ADB publish | `127.0.0.1:5555` only |
| Physical phone path | platform-tools + udev installed and verified; phone optional |

## Architecture

```text
Pi 4 ARM64 Debian
  ├── Docker
  │     └── ReDroid ARM64 container
  │           ├── software rendering
  │           ├── persistent data volume
  │           └── ADB published only to 127.0.0.1:5555
  ├── Android platform-tools / adb
  ├── Linux udev rules for future USB phone
  ├── optional verified Calorix Actions APK fetcher
  │     (source SHA match + SHA256 checksum only)
  └── ui-diff-mcp repo
        ├── package.json bin: ./dist/src/index.js
        └── package-lock.json bin: dist/src/index.js  (must stay synchronized)
```

## Validation Evidence Policy

### ReDroid is acceptable release evidence for

- platform-independent UI layout
- navigation and screen state transitions
- application state after reseed/debug entry points
- ADB-driven install, launch, and screenshot capture used by Calorix live helpers
- structural/report/pipeline behavior that does not depend on OEM-specific pixels

### Physical phone remains required for

- OEM rendering differences
- camera hardware behavior
- sensors
- thermals and device performance characteristics
- physical-device screenshot parity claims

### Production validation rule

Absence of a physical phone must not globally block production validation. Production claims that only require platform-independent UI/layout/state/navigation evidence may proceed on ReDroid. Claims that explicitly require phone-only properties remain phone-gated and must record the exact missing property rather than a blanket environment failure.

### Capability-based gate results

ReDroid gate results must be recorded with explicit capability tags:

| Capability | ReDroid | Physical Phone |
|---|---|---|
| UI layout / navigation / state transitions | ✅ pass/fail recorded | ✅ pass/fail recorded |
| Application persistence / reseed | ✅ pass/fail recorded | ✅ pass/fail recorded |
| OEM rendering differences | ❌ not testable | ✅ pass/fail recorded |
| Camera hardware behavior | ❌ not testable | ✅ pass/fail recorded |
| Sensor behavior | ❌ not testable | ✅ pass/fail recorded |
| Thermals / performance | ❌ not testable | ✅ pass/fail recorded |
| Physical screenshot parity | ❌ not testable | ✅ pass/fail recorded |

Each gate run records which capabilities were exercised and their pass/fail status. A "ReDroid-only" gate run is valid evidence for its covered capabilities only.

## Calorix Release APK Artifact Contract

Calorix GitHub Actions produces a single artifact named `android-apk-${github.sha}` containing both the versioned release APK and its SHA256 checksum file.

Download and use of that APK is permitted only when all of the following are true:

1. The requested Calorix source is a committed SHA (not dirty/uncommitted work).
2. The Actions workflow that produced the artifact was built from that exact source SHA.
3. The downloaded APK SHA256 matches the checksum file included in the same artifact.
4. The workflow run has a successful conclusion, expected workflow file/name, and immutable run/database ID.
5. The local fetch script records the source SHA, workflow run identity, artifact names, and verification result.

If any condition fails, the script must exit non-zero and must not leave the APK marked as current evidence.

Uncommitted Calorix work cannot use the Actions artifact as current evidence. Local debug/build paths remain separate and must not be relabeled as Actions-verified evidence.

## Worker And Review Routing

### Implementation worker route order (by actual model)

Use this exact fallback order for editing workers. Record exact failure timestamp, model, category, and message before trying the next route:

1. `grok-4.5` high (primary)
2. `qwen3.7-max`
3. `opencode/nemotron-3-ultra-free`
4. `opencode/mimo-v2.5-free`
5. `opencode/deepseek-v4-flash-free`
6. Claude paid (last)

Workers never commit or push. The host reviews, verifies, commits, and pushes.

### Antigravity external review order (unchanged and separate)

Antigravity MCP review remains a separate contract from worker editing:

1. Gemini 3.6 Flash (High) primary
2. Gemini 3.1 Pro (High) fallback
3. Gemini 3.5 Flash (High) final fallback

A review is green only with explicit `AGREEMENT_STATUS: agree` and `MUST_FIX: none`. Empty or failed routes are not green.

### Antigravity pre-review failure record for this design stage

On 2026-08-08, required Antigravity pre-review attempts failed before any review body:

| Route | Result |
|---|---|
| `gemini-3.6-flash` | rejected empty `--effort` before review |
| `gemini-3.1-pro` | rejected empty `--effort` before review |
| `gemini-3.5-flash` | rejected empty `--effort` before review |

No response body, no repository mutation, and no green review are claimed for this drafting stage.

### Worker failure recording for this design stage

On 2026-08-08, implementation worker fallback was exercised:

| Timestamp | Model | Category | Message |
|---|---|---|---|
| 2026-08-08T20:19:38+02:00 | `grok-4.5` high | quota | free Grok Build usage limit reached |
| Approximately 2026-08-08T20:20+02:00 | `qwen3.7-max` | empty_output | exited with no response and no additional mutations; no captured exact timestamp |
| Approximately 2026-08-08T20:25+02:00 | `opencode/nemotron-3-ultra-free` | quota/upstream | became next route; observed next-command timestamp 20:25:34 |

## Planned Scripts

All scripts are bash, idempotent where practical, and live under `scripts/`.

| Script | Responsibility |
|---|---|
| `scripts/install-android-platform-tools.sh` | Install or verify Android platform-tools/adb and Linux udev support for future USB phones |
| `scripts/check-adb.sh` | Verify `adb` is on PATH, reports version, and can see expected local devices without public bind |
| `scripts/start-redroid.sh` | Start ReDroid ARM64 container with software rendering, persistent data, binder/kvm devices, ADB on `127.0.0.1:5555` only |
| `scripts/stop-redroid.sh` | Stop the ReDroid container without deleting the persistent data volume |
| `scripts/reset-redroid.sh` | Stop container and recreate/clear persistent data, then start clean |
| `scripts/fetch-calorix-actions-apk.sh` | Optionally download a Calorix Actions APK only after source-SHA match, workflow provenance validation, and SHA256 verification |
| `scripts/start-locateanything-sidecar.sh` | Linux launcher for LocateAnything sidecar (bash equivalent of PowerShell starter) |

Security invariants for every script:

- Never publish ADB to `0.0.0.0`, LAN interfaces, or non-loopback hosts.
- Never commit secrets, tokens, APK binaries, or run artifacts.
- Re-running install/start scripts must not break an already-correct setup.

## Package-Lock Bin Invariant

`package.json` declares:

```json
"bin": {
  "ui-diff-mcp": "./dist/src/index.js"
}
```

The intentional working-tree correction in `package-lock.json` synchronizes the root package bin to:

```text
ui-diff-mcp -> dist/src/index.js
```

This correction is pre-existing and intentional. Environment-migration work must preserve it, verify it with focused assertions, and include it in the migration commit rather than regenerating a lockfile that reverts the path to `dist/index.js`.

## Scope Split

| Stage | Owns | Does not own |
|---|---|---|
| Pi environment migration (this design/plan) | host setup, Docker/ReDroid, adb/udev, APK fetch policy, docs/status, package-lock bin preservation, AGENTS.md Pi/bash environment update | Task 8 structural source-facts code |
| Task 8 Stage A residual work | typed structural source facts and retained-relation observations after query provenance | host migration, ReDroid, Actions APK fetcher |

Task 8 Stage A resumes only after the Pi migration stage is documented, implemented, verified, committed, and pushed by the host.

## Success Criteria

- Pi 4 ARM64 Debian host can install and re-run the setup scripts idempotently.
- ReDroid answers on `127.0.0.1:5555` with software rendering and persistent data.
- `adb devices` can see ReDroid locally; no public ADB bind exists.
- platform-tools and udev support are present for a future phone.
- Calorix Actions APK fetch rejects SHA mismatch, provenance mismatch, and uncommitted source requests.
- `package-lock.json` root bin remains `dist/src/index.js` and `npm run verify` still passes.
- Status file records Pi migration as the current bounded prerequisite and states that Task 8 structural source-facts resumes afterward.
- No production-readiness claim is made from environment setup alone.

## Out Of Scope For Drafting Stage

- Creating or executing the bash scripts
- Changing TypeScript/Python implementation
- Editing `AGENTS.md`
- Running live Calorix gates on ReDroid
- Committing or pushing (worker drafting stage)

(End of file - total 225 lines)