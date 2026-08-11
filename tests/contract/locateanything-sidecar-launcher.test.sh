#!/usr/bin/env bash
# Hermetic contract tests for scripts/start-locateanything-sidecar.sh.
# The launcher is intentionally absent while this suite is first introduced so
# the initial execution records a genuine RED state.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LAUNCHER="$REPO_ROOT/scripts/start-locateanything-sidecar.sh"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/locateanything-launcher-test.XXXXXX")"
BASE_PATH="$PATH"
BASH_BIN="$(command -v bash)"
NODE_BIN="$(command -v node)"
PASS=0
FAIL=0
PIDS=()

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

pass() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

assert_status() {
  local expected="$1" actual="$2" label="$3"
  if [ "$expected" = "$actual" ]; then pass "$label"; else fail "$label (expected $expected, got $actual)"; fi
}

assert_contains() {
  local needle="$1" haystack="$2" label="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$label"; else fail "$label (missing: $needle)"; fi
}

assert_not_exists() {
  local path="$1" label="$2"
  if [ ! -e "$path" ]; then pass "$label"; else fail "$label (unexpected path: $path)"; fi
}

assert_not_contains() {
  local needle="$1" haystack="$2" label="$3"
  if [[ "$haystack" != *"$needle"* ]]; then pass "$label"; else fail "$label (unexpected present: $needle)"; fi
}

# Pinned provenance constants (must match launcher/server/cpp_worker).
PINNED_ENGINE_COMMIT="77376ab332de918220f7a7e391542eefb5407c9f"
PINNED_MODEL_SHA256="894088a00a2cd2bbb7f34b12893988dd0376c8ed92213a9f2cf6420f1e3901da"
PINNED_ABI_VERSION="1"
# Measured Q4 peak RSS (KiB) + 512 MiB headroom = required MemAvailable.
Q4_PEAK_RSS_KIB="4797980"
MEM_HEADROOM_KIB="524288"
REQUIRED_MEM_AVAILABLE_KIB="5322268"

new_case() {
  CASE_DIR="$TEST_ROOT/$1"
  mkdir -p "$CASE_DIR/bin" "$CASE_DIR/eagle/locateanything_worker" "$CASE_DIR/logs" "$CASE_DIR/metrics"
  : > "$CASE_DIR/eagle/locateanything_worker/__init__.py"
  export UI_DIFF_LOCATEANYTHING_KNOWN_PYTHON_INTERNAL="$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_EAGLE_DIR_INTERNAL="$CASE_DIR/eagle"
  export UI_DIFF_LOCATEANYTHING_LOG_DIR_INTERNAL="$CASE_DIR/logs"
  export UI_DIFF_LOCATEANYTHING_METRICS_DIR_INTERNAL="$CASE_DIR/metrics"
  export UI_DIFF_LOCATEANYTHING_PORT_INTERNAL="$2"
  export UI_DIFF_LOCATEANYTHING_TIMEOUT_MS="160"
  export UI_DIFF_LOCATEANYTHING_POLL_MS="20"
  # Existing Stage-6 assertions target the official path; pin non-ARM so ARM hosts
  # do not flip those cases onto the C++ backend during hermetic runs.
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="x86_64"
  LAUNCHER_PATH="$CASE_DIR/bin:$BASE_PATH"
  unset LOCATEANYTHING_PYTHON LOCATEANYTHING_EAGLE_EMBODIED_DIR
  unset LOCATEANYTHING_IN_TOKEN_LIMIT LOCATEANYTHING_GENERATION_MODE LOCATEANYTHING_MAX_NEW_TOKENS
  unset LOCATEANYTHING_BACKEND
  unset LOCATEANYTHING_CPP_LIBRARY_PATH LOCATEANYTHING_CPP_MODEL_PATH LOCATEANYTHING_CPP_CHECKOUT_DIR
  unset LOCATEANYTHING_COLOCATION_EVIDENCE
  unset UI_DIFF_LOCATEANYTHING_CPP_CHECKOUT_INTERNAL
  unset UI_DIFF_LOCATEANYTHING_CPP_LIBRARY_INTERNAL
  unset UI_DIFF_LOCATEANYTHING_CPP_MODEL_INTERNAL
  unset UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL
  unset UI_DIFF_LOCATEANYTHING_MEMINFO_INTERNAL
  unset UI_DIFF_LOCATEANYTHING_COLOCATION_EVIDENCE_INTERNAL
  unset UI_DIFF_LOCATEANYTHING_REDROID_NAME_INTERNAL
  unset UI_DIFF_LOCATEANYTHING_PROC_PID_INTERNAL
  unset FAKE_PYTHON_PREFLIGHT_MODE FAKE_PYTHON_PREFLIGHT_MARKER
  unset FAKE_GIT_HEAD FAKE_SHA256_HASH FAKE_DOCKER_STATE FAKE_PYTHON_ABI FAKE_PYTHON_ABI_CODE_LOG
  unset FAKE_CURL_COUNT FAKE_CURL_RESPONSES FAKE_STATIC_HEALTH
  unset FAKE_PYTHON_CWD FAKE_PYTHON_ARGS FAKE_PYTHON_ENV FAKE_PYTHON_CALLS FAKE_PYTHON_MODE FAKE_PYTHON_SLEEP
}

make_python() {
  local path="$1"
  cat > "$path" <<'PY'
#!/bin/bash
set -euo pipefail
if [ "${1:-}" = "--version" ]; then
  printf 'Python 3.11.0\n'
  exit 0
fi
if [ "${1:-}" = "-c" ]; then
  [ -n "${FAKE_PYTHON_PREFLIGHT_MARKER:-}" ] && printf 'checked\n' > "$FAKE_PYTHON_PREFLIGHT_MARKER"
  code="${2:-}"
  printf '%s\n' "$code" > "${FAKE_PYTHON_PREFLIGHT_CODE:-/dev/null}"
  mode="${FAKE_PYTHON_PREFLIGHT_MODE:-pass}"
  case "$mode" in
    fail)
      printf 'Traceback (most recent call last):\nModuleNotFoundError: No module named uvicorn\n' >&2
      exit 1
      ;;
    fail_pillow)
      printf 'Traceback (most recent call last):\nModuleNotFoundError: No module named PIL\n' >&2
      exit 1
      ;;
    fail_cpp_worker)
      printf 'Traceback (most recent call last):\nModuleNotFoundError: No module named sidecars.locateanything.cpp_worker\n' >&2
      exit 1
      ;;
    fail_abi)
      printf 'ABI mismatch: expected 1, got 99\n' >&2
      exit 1
      ;;
    pass|*)
      # Handle ctypes ABI version probe from verify_cpp_abi before import log.
      if printf '%s\n' "$code" | grep -q 'la_capi_abi_version'; then
        if [ -n "${FAKE_PYTHON_ABI_CODE_LOG:-}" ]; then
          printf '%s\n' "$code" >> "$FAKE_PYTHON_ABI_CODE_LOG"
        fi
        if [ "${FAKE_PYTHON_ABI:-}" = "mismatch" ]; then
          printf 'ABI mismatch: expected 1, got 99\n' >&2
          exit 1
        fi
        printf '1\n'
        exit 0
      fi
      # Only non-ABI calls write preflight import log.
      if [ -n "${FAKE_PYTHON_PREFLIGHT_CODE_LOG:-}" ]; then
        printf '%s\n' "$code" >> "$FAKE_PYTHON_PREFLIGHT_CODE_LOG"
      fi
      if [ "${FAKE_PYTHON_ABI:-}" = "mismatch" ]; then
        printf 'ABI mismatch: expected 1, got 2\n' >&2
        exit 1
      fi
      exit 0
      ;;
  esac
fi
printf '%s\n' "$PWD" > "${FAKE_PYTHON_CWD:?}"
printf '%s\n' "$@" > "${FAKE_PYTHON_ARGS:?}"
env | LC_ALL=C sort > "${FAKE_PYTHON_ENV:?}"
if [ -n "${FAKE_PYTHON_CALLS:-}" ]; then
  calls=0; [ -f "$FAKE_PYTHON_CALLS" ] && calls="$(cat "$FAKE_PYTHON_CALLS")"
  printf '%s' "$((calls + 1))" > "$FAKE_PYTHON_CALLS"
fi
if [ "${FAKE_PYTHON_MODE:-exit}" = "serve" ]; then
  port="${!#}"
  exec node -e 'const http=require("http");const port=Number(process.argv[1]);http.createServer((req,res)=>{res.setHeader("content-type","application/json");res.end(JSON.stringify({ready:true,error:null}))}).listen(port,"127.0.0.1")' "$port"
fi
sleep "${FAKE_PYTHON_SLEEP:-5}"
PY
  chmod +x "$path"
}

write_meminfo() {
  local path="$1" available_kib="$2"
  cat > "$path" <<EOF
MemTotal:        8007460 kB
MemFree:          191540 kB
MemAvailable:    ${available_kib} kB
SwapTotal:       2097148 kB
SwapFree:        1542648 kB
EOF
}

write_colocation_evidence() {
  local path="$1"
  local machine="${2:-aarch64}"
  local commit="${3:-$PINNED_ENGINE_COMMIT}"
  local sha="${4:-$PINNED_MODEL_SHA256}"
  local status="${5:-pass}"
  local swap_delta="${6:-0}"
  cat > "$path" <<EOF
schema_version=1
engine_commit=${commit}
model_sha256=${sha}
abi_version=${PINNED_ABI_VERSION}
quantization=Q4_K
host_machine=${machine}
concurrent_peak_rss_kib=5100000
concurrent_swap_delta_kib=${swap_delta}
status=${status}
EOF
}

setup_cpp_hermetic_defaults() {
  # Minimal hermetic C++ provenance surface for check-only success paths.
  mkdir -p "$CASE_DIR/checkout" "$CASE_DIR/lib" "$CASE_DIR/models"
  : > "$CASE_DIR/lib/liblocate_anything.so"
  printf 'fake-q4-model\n' > "$CASE_DIR/models/locate-anything-q4_k.gguf"
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="aarch64"
  export UI_DIFF_LOCATEANYTHING_CPP_CHECKOUT_INTERNAL="$CASE_DIR/checkout"
  export UI_DIFF_LOCATEANYTHING_CPP_LIBRARY_INTERNAL="$CASE_DIR/lib/liblocate_anything.so"
  export UI_DIFF_LOCATEANYTHING_CPP_MODEL_INTERNAL="$CASE_DIR/models/locate-anything-q4_k.gguf"
  export UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL="aarch64"
  write_meminfo "$CASE_DIR/meminfo" "$REQUIRED_MEM_AVAILABLE_KIB"
  export UI_DIFF_LOCATEANYTHING_MEMINFO_INTERNAL="$CASE_DIR/meminfo"
  export FAKE_GIT_HEAD="$PINNED_ENGINE_COMMIT"
  export FAKE_SHA256_HASH="$PINNED_MODEL_SHA256"
  export FAKE_DOCKER_STATE="absent"
  cat > "$CASE_DIR/bin/git" <<'GIT'
#!/bin/bash
set -euo pipefail
# Support: git -C <dir> rev-parse HEAD
if [ "${1:-}" = "-C" ] && [ "${3:-}" = "rev-parse" ] && [ "${4:-}" = "HEAD" ]; then
  printf '%s\n' "${FAKE_GIT_HEAD:?}"
  exit 0
fi
exit 1
GIT
  cat > "$CASE_DIR/bin/sha256sum" <<'SHA'
#!/bin/bash
set -euo pipefail
# Emit pinned or configured hash for any file argument.
target="${1:-}"
printf '%s  %s\n' "${FAKE_SHA256_HASH:?}" "$target"
SHA
  cat > "$CASE_DIR/bin/docker" <<'DOCKER'
#!/bin/bash
set -euo pipefail
# Rootless Podman docker shim shape: inspect Running state.
if [ "${1:-}" = "inspect" ]; then
  case "${FAKE_DOCKER_STATE:-absent}" in
    running) printf 'true\n'; exit 0 ;;
    stopped) printf 'false\n'; exit 0 ;;
    absent|*) exit 1 ;;
  esac
fi
exit 1
DOCKER
  chmod +x "$CASE_DIR/bin/git" "$CASE_DIR/bin/sha256sum" "$CASE_DIR/bin/docker"
}

make_curl() {
  cat > "$CASE_DIR/bin/curl" <<'CURL'
#!/bin/bash
set -euo pipefail
count_file="${FAKE_CURL_COUNT:?}"
responses="${FAKE_CURL_RESPONSES:?}"
count=0
[ -f "$count_file" ] && count="$(cat "$count_file")"
count=$((count + 1))
printf '%s' "$count" > "$count_file"
line="$(sed -n "${count}p" "$responses" || true)"
case "$line" in
  CURL_FAIL) exit 7 ;;
  *) printf '%s\n' "$line" ;;
esac
CURL
  chmod +x "$CASE_DIR/bin/curl"
}

make_health_only_path() {
  cat > "$CASE_DIR/bin/dirname" <<'DIRNAME'
#!/bin/bash
printf '%s\n' "${1%/*}"
DIRNAME
  cat > "$CASE_DIR/bin/curl" <<'CURL'
#!/bin/bash
printf '%s\n' "${FAKE_STATIC_HEALTH:?}"
CURL
  cat > "$CASE_DIR/bin/node" <<'NODE'
#!/bin/bash
exec "${REAL_NODE_BIN:?}" "$@"
NODE
  chmod +x "$CASE_DIR/bin/dirname" "$CASE_DIR/bin/curl" "$CASE_DIR/bin/node"
  LAUNCHER_PATH="$CASE_DIR/bin"
  export REAL_NODE_BIN="$NODE_BIN"
}

make_invalid_explicit_python() {
  cat > "$CASE_DIR/invalid-python" <<'PYTHON'
#!/bin/bash
printf 'invoked\n' > "${INVALID_PYTHON_INVOKED:?}"
exit 9
PYTHON
  chmod +x "$CASE_DIR/invalid-python"
  export INVALID_PYTHON_INVOKED="$CASE_DIR/invalid-python-invoked"
  export LOCATEANYTHING_PYTHON="$CASE_DIR/invalid-python"
}

run_launcher() {
  OUTPUT=""
  set +e
  OUTPUT="$(PATH="$LAUNCHER_PATH" "$BASH_BIN" "$LAUNCHER" "$@" 2>&1)"
  STATUS=$?
  set -e
}

# RED: this first assertion must fail until the launcher is implemented.
new_case absent-launcher 40101
[ ! -x "$LAUNCHER" ] || make_python "$CASE_DIR/known-python"
run_launcher --check-only
assert_status 0 "$STATUS" "launcher exists and accepts check-only"

# The remaining contracts are intentionally skipped in RED when the file does
# not exist. They become executable assertions once the launcher is present.
if [ -x "$LAUNCHER" ]; then
  new_case help 40102
  run_launcher --help
  assert_status 0 "$STATUS" "help exits zero"
  assert_contains "--check-only" "$OUTPUT" "help documents check-only"
  run_launcher --check-only --check-only
  assert_status 1 "$STATUS" "duplicate flag rejected"
  run_launcher --help --check-only
  assert_status 1 "$STATUS" "combined flags rejected"
  run_launcher --unknown
  assert_status 1 "$STATUS" "unknown flag rejected"
  if ! grep -q '0.0.0.0' "$LAUNCHER"; then pass "launcher contains no public bind literal"; else fail "launcher contains no public bind literal"; fi

  new_case missing-python 40103
  export UI_DIFF_LOCATEANYTHING_KNOWN_PYTHON_INTERNAL="$CASE_DIR/missing-python"
  printf '#!/bin/bash\nexit 9\n' > "$CASE_DIR/bin/python3"; chmod +x "$CASE_DIR/bin/python3"
  LAUNCHER_PATH="$CASE_DIR/bin:/bin"
  run_launcher --check-only
  assert_status 1 "$STATUS" "missing python fails closed"
  assert_contains "Python" "$OUTPUT" "missing python remediation"

  new_case system-python-fallback 40115
  export UI_DIFF_LOCATEANYTHING_KNOWN_PYTHON_INTERNAL="$CASE_DIR/missing-python"
  make_python "$CASE_DIR/bin/python3"
  run_launcher --check-only
  assert_status 0 "$STATUS" "usable PATH python3 is accepted after absent known venv"
  assert_contains "$CASE_DIR/bin/python3" "$OUTPUT" "PATH python3 selection is reported"

  new_case invalid-python 40104
  printf '#!/usr/bin/env bash\nexit 9\n' > "$CASE_DIR/bad-python"; chmod +x "$CASE_DIR/bad-python"
  make_python "$CASE_DIR/known-python"
  export LOCATEANYTHING_PYTHON="$CASE_DIR/bad-python"
  run_launcher --check-only
  assert_status 1 "$STATUS" "invalid explicit python does not fall back"
  assert_contains "LOCATEANYTHING_PYTHON" "$OUTPUT" "invalid explicit python names override"

  new_case python-precedence 40105
  make_python "$CASE_DIR/known-python"
  make_python "$CASE_DIR/explicit python"
  set +e; "$CASE_DIR/explicit python" --version > "$CASE_DIR/version" 2>&1; fixture_status=$?; set -e
  assert_status 0 "$fixture_status" "explicit python fixture reports a version"
  export LOCATEANYTHING_PYTHON="$CASE_DIR/explicit python"
  run_launcher --check-only
  assert_status 0 "$STATUS" "explicit python usable"
  assert_contains "explicit python" "$OUTPUT" "explicit python wins precedence"

  new_case eagle-override 40106
  make_python "$CASE_DIR/known-python"
  export LOCATEANYTHING_EAGLE_EMBODIED_DIR="$CASE_DIR/not-eagle"
  mkdir -p "$LOCATEANYTHING_EAGLE_EMBODIED_DIR"
  run_launcher --check-only
  assert_status 1 "$STATUS" "invalid explicit Eagle dir does not fall back"
  assert_contains "locateanything_worker" "$OUTPUT" "Eagle remediation names marker"

  new_case missing-default-eagle 40116
  make_python "$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_EAGLE_DIR_INTERNAL="$CASE_DIR/missing-eagle"
  run_launcher --check-only
  assert_status 1 "$STATUS" "missing default Eagle dir fails with remediation"
  assert_contains "Eagle Embodied" "$OUTPUT" "missing default Eagle remediation"

  new_case no-start-check-only 40107
  make_python "$CASE_DIR/known-python"; make_curl
  printf '{"ready":true,"error":null}\n' > "$CASE_DIR/responses"
  export FAKE_CURL_COUNT="$CASE_DIR/count" FAKE_CURL_RESPONSES="$CASE_DIR/responses"
  export FAKE_PYTHON_CWD="$CASE_DIR/cwd" FAKE_PYTHON_ARGS="$CASE_DIR/args" FAKE_PYTHON_ENV="$CASE_DIR/env"
  run_launcher --check-only
  assert_status 0 "$STATUS" "check-only validates valid dependencies"
  assert_not_exists "$CASE_DIR/args" "check-only does not spawn python"
  assert_not_exists "$CASE_DIR/count" "check-only does not make a health request"

  new_case check-only-missing-launch-modules 40119
  make_python "$CASE_DIR/known-python"; make_curl
  printf '{"ready":true,"error":null}\n' > "$CASE_DIR/responses"
  export FAKE_CURL_COUNT="$CASE_DIR/count" FAKE_CURL_RESPONSES="$CASE_DIR/responses"
  export FAKE_PYTHON_PREFLIGHT_MODE=fail FAKE_PYTHON_PREFLIGHT_MARKER="$CASE_DIR/preflight"
  export FAKE_PYTHON_CWD="$CASE_DIR/cwd" FAKE_PYTHON_ARGS="$CASE_DIR/args" FAKE_PYTHON_ENV="$CASE_DIR/env"
  run_launcher --check-only
  assert_status 1 "$STATUS" "check-only fails when selected Python lacks launch modules"
  assert_contains "$CASE_DIR/known-python" "$OUTPUT" "module remediation names selected interpreter"
  assert_contains "sidecars/locateanything/requirements.txt" "$OUTPUT" "module remediation names requirements file"
  assert_contains "ModuleNotFoundError: No module named uvicorn" "$OUTPUT" "module remediation preserves missing launch package detail"
  if [ -f "$CASE_DIR/preflight" ]; then pass "check-only executes module preflight"; else fail "check-only executes module preflight"; fi
  assert_not_exists "$CASE_DIR/count" "check-only module failure makes no health request"
  assert_not_exists "$CASE_DIR/args" "check-only module failure does not spawn sidecar"

  new_case unready-missing-launch-modules 40120
  make_python "$CASE_DIR/known-python"; make_curl
  printf '{"ready":false,"error":null}\n' > "$CASE_DIR/responses"
  export FAKE_CURL_COUNT="$CASE_DIR/count" FAKE_CURL_RESPONSES="$CASE_DIR/responses"
  export FAKE_PYTHON_PREFLIGHT_MODE=fail FAKE_PYTHON_PREFLIGHT_MARKER="$CASE_DIR/preflight"
  export FAKE_PYTHON_CWD="$CASE_DIR/cwd" FAKE_PYTHON_ARGS="$CASE_DIR/args" FAKE_PYTHON_ENV="$CASE_DIR/env"
  run_launcher
  assert_status 1 "$STATUS" "unready service fails when selected Python lacks launch modules"
  assert_status 1 "$(cat "$CASE_DIR/count")" "unready module failure performs one authoritative health check"
  if [ -f "$CASE_DIR/preflight" ]; then pass "unready service executes module preflight"; else fail "unready service executes module preflight"; fi
  assert_not_exists "$CASE_DIR/args" "unready module failure occurs before sidecar spawn"

  new_case validation 40108
  make_python "$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_PORT_INTERNAL=0
  run_launcher --check-only
  assert_status 1 "$STATUS" "port zero rejected"
  export UI_DIFF_LOCATEANYTHING_PORT_INTERNAL=70000
  run_launcher --check-only
  assert_status 1 "$STATUS" "out of range port rejected"
  export UI_DIFF_LOCATEANYTHING_PORT_INTERNAL=40108 UI_DIFF_LOCATEANYTHING_TIMEOUT_MS=0
  run_launcher --check-only
  assert_status 1 "$STATUS" "zero timeout rejected"
  export UI_DIFF_LOCATEANYTHING_TIMEOUT_MS=160 UI_DIFF_LOCATEANYTHING_POLL_MS=999999
  run_launcher --check-only
  assert_status 1 "$STATUS" "oversized poll rejected"

  new_case ready-spawn 40109
  make_python "$CASE_DIR/known-python"; make_curl
  printf '{"ready":false,"error":null}\n{"ready":true,"error":null}\n' > "$CASE_DIR/responses"
  export FAKE_CURL_COUNT="$CASE_DIR/count" FAKE_CURL_RESPONSES="$CASE_DIR/responses"
  export FAKE_PYTHON_CWD="$CASE_DIR/cwd" FAKE_PYTHON_ARGS="$CASE_DIR/args" FAKE_PYTHON_ENV="$CASE_DIR/env" FAKE_PYTHON_SLEEP=5
  run_launcher
  assert_status 0 "$STATUS" "unready then ready starts successfully"
  assert_contains "PID:" "$OUTPUT" "start prints child PID"
  assert_contains "Log:" "$OUTPUT" "start prints log path"
  assert_contains "$REPO_ROOT" "$(cat "$CASE_DIR/cwd")" "uvicorn runs from repo root"
  assert_contains "-m" "$(cat "$CASE_DIR/args")" "uvicorn args include module mode"
  assert_contains "sidecars.locateanything.server:app" "$(cat "$CASE_DIR/args")" "uvicorn target exact"
  assert_contains "127.0.0.1" "$(cat "$CASE_DIR/args")" "uvicorn host is loopback"
  assert_contains "LOCATEANYTHING_IN_TOKEN_LIMIT=4096" "$(cat "$CASE_DIR/env")" "token default passed"
  assert_contains "LOCATEANYTHING_GENERATION_MODE=hybrid" "$(cat "$CASE_DIR/env")" "generation default passed"
  assert_contains "LOCATEANYTHING_MAX_NEW_TOKENS=512" "$(cat "$CASE_DIR/env")" "max token default passed"
  pid="$(sed -n 's/^PID: //p' <<<"$OUTPUT")"; PIDS+=("$pid")

  new_case already-healthy-broken-startup 40118
  make_health_only_path
  make_invalid_explicit_python
  export LOCATEANYTHING_EAGLE_EMBODIED_DIR="$CASE_DIR/missing-eagle"
  export FAKE_STATIC_HEALTH='{"ready":true,"error":null}'
  if ! PATH="$LAUNCHER_PATH" command -v nohup >/dev/null 2>&1; then pass "healthy no-op fixture has no nohup"; else fail "healthy no-op fixture has no nohup"; fi
  run_launcher
  assert_status 0 "$STATUS" "already healthy service ignores invalid startup dependencies"
  assert_contains "already healthy" "$OUTPUT" "already healthy no-op is reported"
  assert_not_exists "$INVALID_PYTHON_INVOKED" "already healthy no-op does not probe or spawn Python"

  new_case already-healthy-skips-module-preflight 40121
  make_health_only_path
  make_python "$CASE_DIR/selected-python"
  export LOCATEANYTHING_PYTHON="$CASE_DIR/selected-python"
  export LOCATEANYTHING_EAGLE_EMBODIED_DIR="$CASE_DIR/missing-eagle"
  export FAKE_STATIC_HEALTH='{"ready":true,"error":null}'
  export FAKE_PYTHON_PREFLIGHT_MODE=fail FAKE_PYTHON_PREFLIGHT_MARKER="$CASE_DIR/preflight"
  export FAKE_PYTHON_CWD="$CASE_DIR/cwd" FAKE_PYTHON_ARGS="$CASE_DIR/args" FAKE_PYTHON_ENV="$CASE_DIR/env"
  run_launcher
  assert_status 0 "$STATUS" "already healthy service bypasses module preflight"
  assert_not_exists "$CASE_DIR/preflight" "already healthy service does not execute module preflight"
  assert_not_exists "$CASE_DIR/args" "already healthy module-bypass case does not spawn sidecar"

  new_case health-error 40110
  make_health_only_path
  make_invalid_explicit_python
  export LOCATEANYTHING_EAGLE_EMBODIED_DIR="$CASE_DIR/missing-eagle"
  export FAKE_STATIC_HEALTH='{"ready":false,"error":"worker load failed"}'
  run_launcher
  assert_status 1 "$STATUS" "pre-existing health error fails fast"
  assert_contains "worker load failed" "$OUTPUT" "health error is surfaced"
  assert_not_exists "$INVALID_PYTHON_INVOKED" "pre-existing health error does not probe Python"

  new_case spawned-health-error 40117
  make_python "$CASE_DIR/known-python"; make_curl
  printf '{"ready":false,"error":null}\n{"ready":false,"error":"worker load failed after spawn"}\n' > "$CASE_DIR/responses"
  export FAKE_CURL_COUNT="$CASE_DIR/count" FAKE_CURL_RESPONSES="$CASE_DIR/responses"
  export FAKE_PYTHON_CWD="$CASE_DIR/cwd" FAKE_PYTHON_ARGS="$CASE_DIR/args" FAKE_PYTHON_ENV="$CASE_DIR/env" FAKE_PYTHON_SLEEP=5
  run_launcher
  assert_status 1 "$STATUS" "own-child health error fails"
  assert_contains "worker load failed after spawn" "$OUTPUT" "own-child health error is surfaced"
  pid="$(sed -n 's/^PID: //p' <<<"$OUTPUT" || true)"
  sleep 0.05
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then pass "own-child health error cleans up child"; else fail "own-child health error cleans up child"; fi

  new_case invalid-json 40111
  make_python "$CASE_DIR/known-python"; make_curl
  printf 'not-json\nnot-json\nnot-json\nnot-json\nnot-json\nnot-json\nnot-json\nnot-json\nnot-json\n' > "$CASE_DIR/responses"
  export FAKE_CURL_COUNT="$CASE_DIR/count" FAKE_CURL_RESPONSES="$CASE_DIR/responses"
  export FAKE_PYTHON_CWD="$CASE_DIR/cwd" FAKE_PYTHON_ARGS="$CASE_DIR/args" FAKE_PYTHON_ENV="$CASE_DIR/env" FAKE_PYTHON_SLEEP=5
  run_launcher
  assert_status 1 "$STATUS" "invalid health JSON times out"
  pid="$(sed -n 's/^PID: //p' <<<"$OUTPUT" || true)"
  sleep 0.05
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then pass "timeout cleans up its own child"; else fail "timeout cleans up its own child"; fi

  new_case missing-curl 40112
  make_python "$CASE_DIR/known-python"
  cat > "$CASE_DIR/bin/dirname" <<'DIRNAME'
#!/bin/bash
printf '%s\n' "${1%/*}"
DIRNAME
  chmod +x "$CASE_DIR/bin/dirname"
  LAUNCHER_PATH="$CASE_DIR/bin"
  run_launcher --check-only
  assert_status 1 "$STATUS" "missing curl fails before spawn"

  new_case missing-node 40113
  make_python "$CASE_DIR/known-python"; make_curl
  printf '{"ready":true,"error":null}\n' > "$CASE_DIR/responses"
  export FAKE_CURL_COUNT="$CASE_DIR/count" FAKE_CURL_RESPONSES="$CASE_DIR/responses"
  printf '#!/bin/bash\nexit 127\n' > "$CASE_DIR/bin/node"; chmod +x "$CASE_DIR/bin/node"
  run_launcher
  assert_status 1 "$STATUS" "missing node fails before spawn"

  new_case real-loopback 40114
  make_python "$CASE_DIR/known-python"
  export FAKE_PYTHON_CWD="$CASE_DIR/cwd" FAKE_PYTHON_ARGS="$CASE_DIR/args" FAKE_PYTHON_ENV="$CASE_DIR/env" FAKE_PYTHON_CALLS="$CASE_DIR/calls" FAKE_PYTHON_MODE=serve
  run_launcher
  assert_status 0 "$STATUS" "local loopback health service reaches ready"
  pid="$(sed -n 's/^PID: //p' <<<"$OUTPUT")"; PIDS+=("$pid")
  run_launcher
  assert_status 0 "$STATUS" "already healthy service is idempotent"
  assert_status 1 "$(cat "$CASE_DIR/calls")" "already healthy does not spawn a second process"

  # ── Backend resolution contracts ──────────────────────────────────────

  new_case arm-default-cpp 40201
  make_python "$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="aarch64"
  setup_cpp_hermetic_defaults
  export FAKE_PYTHON_PREFLIGHT_MARKER="$CASE_DIR/preflight"
  export FAKE_PYTHON_PREFLIGHT_CODE_LOG="$CASE_DIR/preflight-code"
  run_launcher --check-only
  assert_status 0 "$STATUS" "aarch64 defaults to cpp backend and passes check-only"
  assert_contains "backend=cpp" "$OUTPUT" "reported backend is cpp"
  assert_contains "liblocate_anything.so" "$OUTPUT" "check-only reports library path"
  if [ -f "$CASE_DIR/preflight" ]; then pass "aarch64 check-only executes python preflight"; else fail "aarch64 check-only executes python preflight"; fi

  new_case x86-default-official 40202
  make_python "$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="x86_64"
  run_launcher --check-only
  assert_status 0 "$STATUS" "x86_64 defaults to official backend and passes check-only"
  assert_contains "backend=official" "$OUTPUT" "reported backend is official"
  assert_contains "Eagle" "$OUTPUT" "check-only reports Eagle path"

  new_case explicit-official-override 40203
  make_python "$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="aarch64"
  export LOCATEANYTHING_BACKEND="official"
  run_launcher --check-only
  assert_status 0 "$STATUS" "explicit official override on aarch64 passes check-only"
  assert_contains "backend=official" "$OUTPUT" "reported backend is official despite aarch64"
  assert_contains "Eagle" "$OUTPUT" "official backend resolves Eagle dir"

  new_case explicit-cpp-override 40204
  make_python "$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="x86_64"
  export LOCATEANYTHING_BACKEND="cpp"
  setup_cpp_hermetic_defaults
  run_launcher --check-only
  assert_status 0 "$STATUS" "explicit cpp override on x86_64 passes check-only"
  assert_contains "backend=cpp" "$OUTPUT" "reported backend is cpp despite x86_64"

  new_case invalid-backend-override 40205
  make_python "$CASE_DIR/known-python"
  export LOCATEANYTHING_BACKEND="cuda"
  run_launcher --check-only
  assert_status 1 "$STATUS" "invalid LOCATEANYTHING_BACKEND value fails closed"
  assert_contains "LOCATEANYTHING_BACKEND" "$OUTPUT" "error names the invalid override variable"
  assert_contains "official" "$OUTPUT" "error documents valid backend values"
  assert_contains "cpp" "$OUTPUT" "error documents cpp as valid backend value"

  # ── C++ check-only preflight contracts ────────────────────────────────

  new_case cpp-check-only-imports-modules 40206
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export FAKE_PYTHON_PREFLIGHT_MARKER="$CASE_DIR/preflight"
  export FAKE_PYTHON_PREFLIGHT_CODE_LOG="$CASE_DIR/preflight-code"
  export FAKE_PYTHON_ABI_CODE_LOG="$CASE_DIR/abi-code"
  run_launcher --check-only
  assert_status 0 "$STATUS" "cpp check-only passes with valid hermetic defaults"
  if [ -f "$CASE_DIR/preflight" ]; then pass "cpp check-only executes python preflight"; else fail "cpp check-only executes python preflight"; fi
  if [ -f "$CASE_DIR/preflight-code" ]; then
    preflight_code="$(cat "$CASE_DIR/preflight-code")"
    assert_contains "uvicorn" "$preflight_code" "cpp preflight imports uvicorn"
    assert_contains "fastapi" "$preflight_code" "cpp preflight imports fastapi"
    assert_contains "PIL" "$preflight_code" "cpp preflight imports Pillow"
    assert_contains "sidecars.locateanything.server" "$preflight_code" "cpp preflight imports server module"
    assert_contains "sidecars.locateanything.cpp_worker" "$preflight_code" "cpp preflight imports cpp_worker module"
  else
    fail "cpp check-only preflight code log missing"
  fi
  if [ -f "$CASE_DIR/abi-code" ]; then
    abi_code="$(cat "$CASE_DIR/abi-code")"
    assert_contains "ctypes" "$abi_code" "abi code log contains ctypes import"
    assert_contains "la_capi_abi_version" "$abi_code" "abi code log contains la_capi_abi_version probe"
  else
    fail "cpp check-only abi code log missing"
  fi

  new_case cpp-check-only-skips-eagle 40207
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  # Remove Eagle directory to prove cpp path does not need it
  rm -rf "$CASE_DIR/eagle"
  unset UI_DIFF_LOCATEANYTHING_EAGLE_DIR_INTERNAL
  export LOCATEANYTHING_EAGLE_EMBODIED_DIR=""
  run_launcher --check-only
  assert_status 0 "$STATUS" "cpp check-only succeeds without Eagle directory"
  assert_not_contains "Eagle" "$OUTPUT" "cpp check-only does not reference Eagle"

  new_case cpp-check-only-missing-preflight-modules 40208
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export FAKE_PYTHON_PREFLIGHT_MODE=fail
  export FAKE_PYTHON_PREFLIGHT_MARKER="$CASE_DIR/preflight"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails when python lacks required modules"
  assert_contains "C++ sidecar modules" "$OUTPUT" "error names C++ sidecar modules"
  assert_contains "uvicorn" "$OUTPUT" "error mentions uvicorn"
  assert_contains "cpp_worker" "$OUTPUT" "error mentions cpp_worker"
  assert_contains "ABI" "$OUTPUT" "error mentions ABI"
  if [ -f "$CASE_DIR/preflight" ]; then pass "cpp missing-module preflight was executed"; else fail "cpp missing-module preflight was executed"; fi

  new_case cpp-check-only-pillow-missing 40209
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export FAKE_PYTHON_PREFLIGHT_MODE=fail_pillow
  export FAKE_PYTHON_PREFLIGHT_MARKER="$CASE_DIR/preflight"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails when Pillow import fails"
  assert_contains "C++ sidecar modules" "$OUTPUT" "error names C++ sidecar modules for Pillow failure"
  assert_contains "PIL" "$OUTPUT" "error mentions PIL"

  new_case cpp-check-only-abi-mismatch 40210
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export FAKE_PYTHON_ABI=mismatch
  export FAKE_PYTHON_PREFLIGHT_MARKER="$CASE_DIR/preflight"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails on ABI version mismatch"
  assert_contains "ABI" "$OUTPUT" "error mentions ABI mismatch"
  assert_contains "C++ sidecar modules" "$OUTPUT" "error references C++ sidecar modules"

  # ── C++ provenance contracts ──────────────────────────────────────────

  new_case cpp-engine-commit-mismatch 40211
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export FAKE_GIT_HEAD="deadbeef00000000000000000000000000000000"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails on engine commit mismatch"
  assert_contains "engine commit" "$OUTPUT" "error describes engine commit mismatch"
  assert_contains "$PINNED_ENGINE_COMMIT" "$OUTPUT" "error shows expected pinned commit"
  assert_contains "deadbeef" "$OUTPUT" "error shows actual commit"

  new_case cpp-model-hash-mismatch 40212
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export FAKE_SHA256_HASH="0000000000000000000000000000000000000000000000000000000000000000"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails on model hash mismatch"
  assert_contains "model hash" "$OUTPUT" "error describes model hash mismatch"
  assert_contains "$PINNED_MODEL_SHA256" "$OUTPUT" "error shows expected pinned hash"
  assert_contains "locate-anything-q4_k.gguf" "$OUTPUT" "error names the model file"

  new_case cpp-missing-library 40213
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  rm -f "$CASE_DIR/lib/liblocate_anything.so"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails when shared library is missing"
  assert_contains "shared library" "$OUTPUT" "error names missing shared library"
  assert_contains "cmake" "$OUTPUT" "error includes cmake build remediation"
  assert_contains "$PINNED_ENGINE_COMMIT" "$OUTPUT" "error references pinned commit for rebuild"

  new_case cpp-missing-model 40214
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  rm -f "$CASE_DIR/models/locate-anything-q4_k.gguf"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails when model file is missing"
  assert_contains "model file" "$OUTPUT" "error names missing model file"
  assert_contains "GGUF" "$OUTPUT" "error references GGUF model format"
  assert_contains "Q4_K" "$OUTPUT" "error references Q4_K quantization"

  # ── C++ library architecture contracts ────────────────────────────────

  new_case cpp-lib-arch-match 40215
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="aarch64"
  export UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL="aarch64"
  run_launcher --check-only
  assert_status 0 "$STATUS" "cpp check-only passes when lib arch matches host arch"

  new_case cpp-lib-arch-mismatch 40216
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="aarch64"
  export UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL="x86_64"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails when lib arch differs from host arch"
  assert_contains "architecture mismatch" "$OUTPUT" "error describes architecture mismatch"
  assert_contains "x86_64" "$OUTPUT" "error names library architecture"
  assert_contains "aarch64" "$OUTPUT" "error names host architecture"

  new_case cpp-lib-arch-unknown 40217
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL=""
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails when lib architecture is unknown"
  assert_contains "architecture unknown" "$OUTPUT" "error describes unknown architecture"

  new_case cpp-readelf-arch-success 40218
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="aarch64"
  # Create a readelf mock that reports matching architecture
  cat > "$CASE_DIR/bin/readelf" <<'READELF'
#!/bin/bash
# Mock readelf: report Machine field for -h flag
if [ "${1:-}" = "-h" ]; then
  printf 'Machine: AArch64\n'
  exit 0
fi
exit 1
READELF
  chmod +x "$CASE_DIR/bin/readelf"
  export UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL=""
  LAUNCHER_PATH="$CASE_DIR/bin:$BASE_PATH"
  run_launcher --check-only
  assert_status 0 "$STATUS" "readelf mock reports aarch64 and check-only passes"

  new_case cpp-readelf-arch-mismatch 40219
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="aarch64"
  # Create a readelf mock that reports different architecture
  cat > "$CASE_DIR/bin/readelf" <<'READELF'
#!/bin/bash
if [ "${1:-}" = "-h" ]; then
  printf 'Machine: x86-64\n'
  exit 0
fi
exit 1
READELF
  chmod +x "$CASE_DIR/bin/readelf"
  export UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL=""
  LAUNCHER_PATH="$CASE_DIR/bin:$BASE_PATH"
  run_launcher --check-only
  assert_status 1 "$STATUS" "readelf reports mismatched arch and check-only fails"
  assert_contains "architecture" "$OUTPUT" "error describes architecture problem"

  # ── Explicit override fail-closed contracts ───────────────────────────

  new_case explicit-backend-invalid-fail-closed 40220
  make_python "$CASE_DIR/known-python"
  export LOCATEANYTHING_BACKEND="gpu"
  run_launcher --check-only
  assert_status 1 "$STATUS" "invalid explicit backend override fails closed"
  assert_contains "LOCATEANYTHING_BACKEND" "$OUTPUT" "error names the variable"
  assert_contains "official" "$OUTPUT" "error lists official as valid"
  assert_contains "cpp" "$OUTPUT" "error lists cpp as valid"
  assert_not_contains "Eagle" "$OUTPUT" "no Eagle fallback attempted"
  assert_not_exists "$CASE_DIR/args" "no python was spawned for invalid override"

  # ── Memory preflight boundary contracts ───────────────────────────────

  new_case meminfo-pass 40221
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  write_meminfo "$CASE_DIR/meminfo" "$REQUIRED_MEM_AVAILABLE_KIB"
  export UI_DIFF_LOCATEANYTHING_MEMINFO_INTERNAL="$CASE_DIR/meminfo"
  run_launcher --check-only
  assert_status 0 "$STATUS" "cpp check-only passes when MemAvailable equals requirement"
  assert_contains "Memory preflight passed" "$OUTPUT" "memory preflight success is reported"

  new_case meminfo-exactly-one-below-fail 40222
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  below=$((REQUIRED_MEM_AVAILABLE_KIB - 1))
  write_meminfo "$CASE_DIR/meminfo" "$below"
  export UI_DIFF_LOCATEANYTHING_MEMINFO_INTERNAL="$CASE_DIR/meminfo"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails when MemAvailable is one KiB below requirement"
  assert_contains "Insufficient memory" "$OUTPUT" "error describes insufficient memory"
  assert_contains "$below" "$OUTPUT" "error shows actual available KiB"
  assert_contains "$REQUIRED_MEM_AVAILABLE_KIB" "$OUTPUT" "error shows required KiB"

  new_case meminfo-pass-one-above 40223
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  above=$((REQUIRED_MEM_AVAILABLE_KIB + 1))
  write_meminfo "$CASE_DIR/meminfo" "$above"
  export UI_DIFF_LOCATEANYTHING_MEMINFO_INTERNAL="$CASE_DIR/meminfo"
  run_launcher --check-only
  assert_status 0 "$STATUS" "cpp check-only passes when MemAvailable is one KiB above requirement"

  new_case meminfo-unreadable 40224
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export UI_DIFF_LOCATEANYTHING_MEMINFO_INTERNAL="$CASE_DIR/nonexistent-meminfo"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails when meminfo is unreadable"
  assert_contains "memory" "$OUTPUT" "error references memory problem"

  new_case meminfo-missing-field 40225
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  cat > "$CASE_DIR/meminfo" <<'MEMINFO'
MemTotal:        8007460 kB
MemFree:          191540 kB
SwapTotal:       2097148 kB
SwapFree:        1542648 kB
MEMINFO
  export UI_DIFF_LOCATEANYTHING_MEMINFO_INTERNAL="$CASE_DIR/meminfo"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails when MemAvailable field is missing"
  assert_contains "MemAvailable" "$OUTPUT" "error names the missing field"

  # ── Official backend still needs Eagle ────────────────────────────────

  new_case official-backend-missing-eagle 40226
  make_python "$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="x86_64"
  export UI_DIFF_LOCATEANYTHING_EAGLE_DIR_INTERNAL="$CASE_DIR/missing-eagle"
  run_launcher --check-only
  assert_status 1 "$STATUS" "official backend fails when Eagle directory is missing"
  assert_contains "Eagle" "$OUTPUT" "error references Eagle directory"

  # ── Backend resolution does not leak to official for cpp paths ────────

  new_case cpp-does-not-check-eagle 40227
  make_python "$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="aarch64"
  setup_cpp_hermetic_defaults
  # Destroy Eagle entirely — cpp backend should not care
  rm -rf "$CASE_DIR/eagle"
  unset UI_DIFF_LOCATEANYTHING_EAGLE_DIR_INTERNAL
  export LOCATEANYTHING_EAGLE_EMBODIED_DIR=""
  run_launcher --check-only
  assert_status 0 "$STATUS" "cpp backend check-only succeeds without any Eagle directory"

  # ── Mixed scenario: cpp provenance pass then official backend ──────────

  new_case mixed-cpp-provenance-official-backend 40228
  make_python "$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="x86_64"
  export LOCATEANYTHING_BACKEND="official"
  # Set up cpp hermetic defaults even though backend is official — should be irrelevant
  setup_cpp_hermetic_defaults
  run_launcher --check-only
  assert_status 0 "$STATUS" "official backend ignores cpp provenance files"
  assert_contains "backend=official" "$OUTPUT" "reported backend is official"
  assert_contains "Eagle" "$OUTPUT" "official backend resolves Eagle dir"

  # ── check-only rejects missing nohup with actionable error ───────────

  new_case check-only-missing-nohup 40230
  make_python "$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL="x86_64"
  # Build a restricted PATH that has bash, curl, node, python but no nohup.
  mkdir -p "$CASE_DIR/nohup-missing-bin"
  cp "$BASH_BIN" "$CASE_DIR/nohup-missing-bin/bash"
  real_curl="$(command -v curl)"
  real_node="$(command -v node)"
  cp "$real_curl" "$CASE_DIR/nohup-missing-bin/curl"
  cp "$real_node" "$CASE_DIR/nohup-missing-bin/node"
  chmod +x "$CASE_DIR/nohup-missing-bin/"*
  LAUNCHER_PATH="$CASE_DIR/nohup-missing-bin"
  if ! PATH="$LAUNCHER_PATH" command -v nohup >/dev/null 2>&1; then
    :
  else
    # nohup is on the restricted PATH; skip this test
    pass "check-only-missing-nohup: nohup present on host, skipping"
  fi
  run_launcher --check-only
  assert_status 1 "$STATUS" "check-only fails when nohup is absent"
  assert_contains "nohup" "$OUTPUT" "error names missing nohup"
  assert_contains "coreutils" "$OUTPUT" "error suggests installing coreutils"

  # ── C++ check-only with explicit cpp_worker module failure detail ────

  new_case cpp-check-only-cpp-worker-import-fail 40229
  make_python "$CASE_DIR/known-python"
  setup_cpp_hermetic_defaults
  export FAKE_PYTHON_PREFLIGHT_MODE=fail_cpp_worker
  export FAKE_PYTHON_PREFLIGHT_MARKER="$CASE_DIR/preflight"
  run_launcher --check-only
  assert_status 1 "$STATUS" "cpp check-only fails when cpp_worker import fails"
  assert_contains "cpp_worker" "$OUTPUT" "error mentions cpp_worker module"
  assert_contains "C++ sidecar modules" "$OUTPUT" "error identifies C++ sidecar context"
fi

printf '%s run, %s passed, %s failed\n' "$((PASS + FAIL))" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
