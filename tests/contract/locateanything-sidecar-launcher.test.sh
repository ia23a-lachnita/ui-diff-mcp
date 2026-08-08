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

new_case() {
  CASE_DIR="$TEST_ROOT/$1"
  mkdir -p "$CASE_DIR/bin" "$CASE_DIR/eagle/locateanything_worker" "$CASE_DIR/logs"
  : > "$CASE_DIR/eagle/locateanything_worker/__init__.py"
  export UI_DIFF_LOCATEANYTHING_KNOWN_PYTHON_INTERNAL="$CASE_DIR/known-python"
  export UI_DIFF_LOCATEANYTHING_EAGLE_DIR_INTERNAL="$CASE_DIR/eagle"
  export UI_DIFF_LOCATEANYTHING_LOG_DIR_INTERNAL="$CASE_DIR/logs"
  export UI_DIFF_LOCATEANYTHING_PORT_INTERNAL="$2"
  export UI_DIFF_LOCATEANYTHING_TIMEOUT_MS="160"
  export UI_DIFF_LOCATEANYTHING_POLL_MS="20"
  LAUNCHER_PATH="$CASE_DIR/bin:$BASE_PATH"
  unset LOCATEANYTHING_PYTHON LOCATEANYTHING_EAGLE_EMBODIED_DIR
  unset LOCATEANYTHING_IN_TOKEN_LIMIT LOCATEANYTHING_GENERATION_MODE LOCATEANYTHING_MAX_NEW_TOKENS
  unset FAKE_PYTHON_PREFLIGHT_MODE FAKE_PYTHON_PREFLIGHT_MARKER
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
  if [ "${FAKE_PYTHON_PREFLIGHT_MODE:-pass}" = "fail" ]; then
    printf 'Traceback (most recent call last):\nModuleNotFoundError: No module named uvicorn\n' >&2
    exit 1
  fi
  exit 0
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
fi

printf '%s run, %s passed, %s failed\n' "$((PASS + FAIL))" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
