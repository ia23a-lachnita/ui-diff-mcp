# Pi Local Locator And Android Validation Implementation Plan

> Execute with `superpowers:executing-plans`. Every behavior change is test-first. Workers edit; the host reviews, verifies, commits, and pushes each bounded stage.

**Goal:** Serve real Q4_K LocateAnything detections on the Pi through the existing sidecar, establish honest throughput/resource gates, and make the unsupported rootless Android path fail with exact evidence.

**Architecture:** Keep FastAPI, Python, Pillow, `/health`, and `/v1/locate-ui-elements`. Add a ctypes worker for the external pinned `locate-anything.cpp` shared library. Do not add a C HTTP server, new endpoint, in-repo C++ source, or committed model/build output.

**Production truth:** Q4 is selected, but full Pi UI-diff readiness remains blocked until the adapter, direct live gate, vision-reuse throughput decision, and available device gates are complete.

## Stage 1: Commit Benchmark Evidence And Q4 Selection

**Files:**

- Create: `docs/release/2026-08-09-pi-locator-benchmark.md`
- Modify: `docs/implementation-status.md`
- Modify: this plan

- [x] Record the exact host, command shape, input dimensions, prompt, mode, threads, engine commit, model hashes, elapsed time, detection count, peak RSS, process swap, and visual-review boundary for official BF16, Q4_K, and Q5_K.
- [x] Record Q4_K as the sole Pi candidate: `473.506s`, `4,797,980 KiB`, `21` detections at 276x600.
- [x] Record Q5_K as rejected: `591.213s`, `5,127,908 KiB`, `13` detections, about 245 MiB process swap under concurrent load, and lower visible coverage.
- [x] Record that the saved annotated outputs were visually inspected, while model labels were not treated as OCR truth.
- [x] Run `git diff --check`.
- [x] Update tracking, commit, and push.

**Acceptance:** There is one model choice, one provider/backend identity, and no duplicate ranking that can be read as a runtime fallback.

## Stage 2: Fix Official Compatibility And Add Backend Selection

**Files:**

- Modify: `sidecars/locateanything/server.py`
- Create: `sidecars/locateanything/test_server.py`
- Modify: `sidecars/locateanything/README.md`
- Modify: `package.json` if sidecar test discovery must include the new module

- [ ] RED: add tests proving unset `LOCATEANYTHING_TOP_K` returns integer `0`, explicit positive values pass, and zero/negative explicit values fail.
- [ ] GREEN: change `_locateanything_top_k` without altering explicit-value validation.
- [ ] RED: add backend-selection tests for explicit `official`, explicit `cpp`, ARM automatic selection, non-ARM official selection, diagnostic skip, and invalid explicit override.
- [ ] RED: prove `_apply_worker_runtime_config` applies processor/token-limit settings to the official worker but bypasses PyTorch-specific `processor.image_processor` access for `CppLocateAnythingWorker` without raising when `LOCATEANYTHING_IN_TOKEN_LIMIT` is set.
- [ ] GREEN: isolate official imports inside the official factory so the C++ path never imports Torch, Eagle, or Decord.
- [ ] Ensure load errors include selected backend and exact remediation without exposing secrets.
- [ ] Run:

```bash
PATH=/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin:$PATH \
  python -m unittest sidecars.locateanything.test_server
npm run typecheck
```

- [ ] Update tracking, commit, and push.

**Acceptance:** Current upstream official code receives `top_k=0`; backend selection is explicit, deterministic, and fail-closed.

## Stage 3: Implement The ctypes Worker And Contract Conversion

**Files:**

- Create: `sidecars/locateanything/cpp_worker.py`
- Create: `sidecars/locateanything/test_cpp_worker.py`
- Modify: `sidecars/locateanything/server.py`
- Modify: `src/locator/locateanything-client.ts` only if additive lane metadata requires schema support
- Modify: `tests/unit/locateanything-client.test.ts` when the TypeScript schema changes

- [ ] RED: inject a fake CDLL and assert configured signatures for only `la_capi_abi_version`, `la_capi_load`, `la_capi_free`, `la_capi_locate_buffer`, `la_capi_free_string`, and `la_capi_last_error`.
- [ ] RED: cover ABI mismatch, null load, null inference result, invalid UTF-8/JSON, missing fields, non-finite coordinates, unordered/empty boxes, out-of-bounds boxes, and over-cap detections.
- [ ] RED: prove every successful C string is freed exactly once and the context is freed exactly once at shutdown.
- [ ] RED: run concurrent calls against a blocking fake library and prove one `threading.Lock` serializes the complete multi-query request.
- [ ] RED: verify pixel `xyxy` conversion to `box`, 0..1000 `rawBox1000`, exact `queryId`, `label`/`rawText`, confidence policy, warnings, and received image dimensions.
- [ ] GREEN: implement persistent `CppLocateAnythingWorker` with dependency injection for hermetic tests.
- [ ] GREEN: wire the worker into the existing locateanything lane without changing endpoint inputs or required response fields.
- [ ] Add backend/model/quant/hash/ABI and timing fields additively to lane metadata; update TypeScript schemas test-first if those fields cross the client boundary.
- [ ] Run:

```bash
PATH=/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin:$PATH \
  python -m unittest sidecars.locateanything.test_cpp_worker sidecars.locateanything.test_server
npx vitest run tests/unit/locateanything-client.test.ts
npm run typecheck
```

- [ ] Update tracking, commit, and push.

**Acceptance:** A fake and a real ABI can use the existing sidecar contract with correct ownership, bounds, identity, and locking.

## Stage 4: Harden Launcher, Provenance, RAM, And Metrics

**Files:**

- Modify: `scripts/start-locateanything-sidecar.sh`
- Modify: `tests/contract/locateanything-sidecar-launcher.test.sh`
- Modify: `.env.example`
- Modify: `sidecars/locateanything/README.md`

- [ ] RED: add hermetic cases for explicit library/model overrides, bad override with no fallback, ARM known paths, wrong checkout commit, wrong model hash, missing shared library, ABI mismatch, wrong architecture, and official non-ARM path.
- [ ] RED: prove C++ check-only does not require Eagle or Torch but still requires usable Python, uvicorn, Pillow, the external library, and the pinned model.
- [ ] GREEN: build guidance uses external commit `77376ab332de918220f7a7e391542eefb5407c9f` and `cmake -DLA_SHARED=ON`; no build or GGUF enters Git.
- [ ] GREEN: verify Q4 SHA-256 `894088a00a2cd2bbb7f34b12893988dd0376c8ed92213a9f2cf6420f1e3901da` and ABI `1` before startup.
- [ ] RED/GREEN: preflight `MemAvailable`; record process RSS/peak and process-swap delta; fail on insufficient headroom, new swap use, or page-thrashing evidence. Do not require host swap to be disabled.
- [ ] RED/GREEN: reject concurrent ReDroid plus C++ locator on this host unless an explicit measured co-location evidence flag/file is present.
- [ ] Ensure all paths bind only to `127.0.0.1` and logs contain no credentials.
- [ ] Run:

```bash
bash tests/contract/locateanything-sidecar-launcher.test.sh
bash -n scripts/start-locateanything-sidecar.sh
git diff --check
```

- [ ] Update tracking, commit, and push.

**Acceptance:** Automatic ARM startup is reproducible, provenance-checked, resource-aware, and cannot silently fall back to a diagnostic model.

## Stage 5: Make Long Runs Honest And Add The Direct Locator Gate

**Files:**

- Modify: `src/pipeline/run-ui-diff.ts`
- Modify: `src/locator/locateanything-client.ts`
- Modify: `tests/unit/locateanything-client.test.ts`
- Modify: `tests/unit/sidecar-manager.test.ts`
- Modify: `tests/helpers/sidecar-manager.ts`
- Modify: `tests/live/locateanything.live.test.ts`
- Modify: `package.json`
- Create: `docs/release/fixtures/pi-locator-today-annotations.json` if a committed compact annotation contract is needed

- [ ] RED: prove the configured Pi timeout can exceed the current 300-second default and 600-second Calorix setting without integer truncation or an obsolete launcher cap.
- [ ] RED: prove direct synchronous calls time out honestly, while `start_ui_diff_run` returns a run ID and `get_ui_diff_run_status` can poll a multi-hour background locator run without holding one MCP request open.
- [ ] GREEN: implement a bounded maximum appropriate to measured multi-query duration; document the operational value rather than silently raising every provider timeout.
- [ ] Extend the existing direct live gate to send the canonical Calorix Today image to `/v1/locate-ui-elements` using the Q4 backend.
- [ ] Save exact input bytes, raw JSON, readable annotated output, and memory/timing/provenance evidence under the run artifact directory.
- [ ] Assert category-query hit ratio, exact/stable query IDs, finite bounds, duplicate ceiling, Q4 hash, ABI `1`, non-diagnostic execution, and no new process swap.
- [ ] Keep a one-query bounded profile separate from the full existing query set; label the evidence accordingly.
- [ ] Run the direct real-model gate and inspect every generated artifact.
- [ ] Update tracking with exact run ID, commit, and push.

**Acceptance:** The direct Q4 adapter gate is real and inspectable, and no bounded pass is mislabeled as full semantic throughput.

## Stage 6: Investigate Prepared-Image Reuse With Parity Gates

**Files:**

- Create: `docs/release/2026-08-09-pi-locator-vision-reuse.md`
- Modify: `sidecars/locateanything/cpp_worker.py` only after an external ABI is proven
- Modify: `sidecars/locateanything/test_cpp_worker.py`
- Modify: launcher provenance checks if an external fork commit is adopted

- [ ] Pin a separate local experiment branch/fork from engine commit `77376ab332de918220f7a7e391542eefb5407c9f`.
- [ ] Measure the current persistent-context path to separate model-load time from per-query preprocessing, ViT, projector, and decode time.
- [ ] Implement prepared-image/projected-embedding reuse externally, with explicit create/query/free ownership and thread-safety semantics.
- [ ] Compare cached and uncached outputs for every existing semantic query and generation mode; require identical labels and boxes within the quantization tolerance already accepted for Q4.
- [ ] Measure eight-query total latency, peak RSS, and process swap.
- [ ] Adopt the new ABI only after parity, ownership, and resource tests pass; record its exact external commit and ABI version.
- [ ] If parity or throughput fails, do not integrate it. Record `full_pi_locator_throughput_blocked` and retain only the direct bounded gate.
- [ ] Update tracking, commit the repository-side decision/docs, and push.

**Acceptance:** Vision reuse is either proven and pinned or explicitly blocks full Pi production use. It is never assumed.

## Stage 7: Correct ReDroid Contracts And Report The Rootless Blocker

**Files:**

- Modify: `scripts/lib/android-env-common.sh`
- Modify: `scripts/start-redroid.sh`
- Modify: `tests/contract/redroid-lifecycle.test.sh`
- Modify: `README.md`

- [ ] RED: add binderfs fixtures proving `/dev/binderfs/{binder,hwbinder,vndbinder}` map to legacy guest device names.
- [ ] RED: assert fully qualified `docker.io/redroid/redroid@sha256:...`, rootless Podman detection, `--group-add keep-groups`, and optional KVM mapping.
- [ ] RED: assert a rootless runtime fails before container launch with the verified Android-init/cgroup remediation, unless a future explicit supported-runtime capability probe passes.
- [ ] GREEN: implement source-device discovery and precise fail-fast diagnostics. Do not claim that these contract improvements boot Android.
- [ ] Preserve loopback-only ADB, pinned image, safe data directory, and idempotent lifecycle rules.
- [ ] Run:

```bash
bash tests/contract/redroid-lifecycle.test.sh
bash tests/contract/android-env.test.sh
bash -n scripts/start-redroid.sh scripts/lib/android-env-common.sh
```

- [ ] Perform one real rootless check and record exit code `129` evidence only as historical diagnosis; do not repeatedly launch the known-incompatible runtime.
- [ ] Update tracking, commit, and push.

**Acceptance:** Operators get an accurate rootless limitation, not a binder/KVM misdiagnosis or a request for broader privileges.

## Stage 8: APK, Device, Full Verification, And Handoff

**Files:**

- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `.env.example`
- Modify: `docs/implementation-status.md`
- Modify: this plan
- Create or modify: `docs/release/2026-08-09-pi-local-validation-results.md`

- [ ] Create a temporary clean Calorix worktree at `1f538641f5e5f5c4a48c95cdfb97462838187106` without touching the unrelated main-worktree `.mcp.json` edit.
- [ ] Fetch Actions run `31182023073`, verify artifact name and checksum, and record the verified APK path/digest.
- [ ] If a physical device or supported Android runtime is connected: install, seed, navigate to Today, capture a fresh screenshot, and run the deterministic, bounded, full, and release UI-diff gates.
- [ ] If no Android target exists: record `adb_no_device` or `supported_android_runtime_unavailable` exactly; do not substitute a historical screenshot.
- [ ] Run deterministic verification:

```bash
PATH=/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin:$PATH npm run verify
git diff --check
```

- [ ] Run every relevant live gate allowed by available credentials, quota, sidecar, and device. Record exact commands, run IDs, model/backend selection, diff counts, `auditLimited`, visual status, provider errors, and inspection scope.
- [ ] Request final Antigravity review in the same conversation and iterate until `AGREEMENT_STATUS: agree` and `MUST_FIX: none`, or record the exact tool failure.
- [ ] Mark only actually completed checkboxes, update the status file, commit, and push.

**Acceptance:** Repository verification is green; real-locator and device evidence are clearly separated; no unavailable gate is represented as passing.

## Rollback

- Set the explicit backend to the official worker on supported hosts; do not use diagnostic skip as rollback.
- Remove the C++ auto-selection branch while retaining adapter tests and benchmark evidence if the external ABI becomes unavailable.
- Revert a prepared-image ABI independently from the stable baseline C ABI adapter.
- ReDroid diagnostic changes are independent from locator behavior and can be reverted without affecting report contracts.

## Non-Claims

This plan does not claim that:

- the official BF16 model is usable on the Pi;
- Q5 is a backup or second candidate;
- persistent model load alone makes eight-query inference practical;
- a direct locator pass proves a complete UI-diff run;
- rootless ReDroid boots on this host;
- Q4 and an Android container can safely share 8 GiB RAM;
- production readiness is achieved before all applicable release gates and artifact inspections complete.
