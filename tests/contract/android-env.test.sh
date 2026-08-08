#!/usr/bin/env bash
# tests/contract/android-env.test.sh - shell-contract tests for Task 3
# Covers: loopback publish assertion, try_resolve_adb_bin/resolve_adb_bin
#          nonfatal-vs-fatal semantics, missing-adb check-only, genuine
#          no-override PATH resolution, genuine no-override installer
#          no-op, the no-override/no-adb privilege-failure branch (proven
#          reachable, not shadowed by the override fail-closed path),
#          invalid-override-never-calls-apt, devices output, --expect-redroid
#          pass/fail, cwd independence, fake adb/apt/sudo/id via a PATH
#          fixture that keeps real shell utilities but hides any host adb,
#          and no public publish string.
# Note: -e disabled intentionally; tests check exit codes explicitly.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0
TESTS_RUN=0

# --- helpers -------------------------------------------------------
pass() { PASS=$((PASS+1)); TESTS_RUN=$((TESTS_RUN+1)); printf "  PASS %s\n" "$1"; }
fail() { FAIL=$((FAIL+1)); TESTS_RUN=$((TESTS_RUN+1)); printf "  FAIL %s: %s\n" "$1" "$2"; }

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then pass "$label"
  else fail "$label" "output missing '$needle'"; fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then fail "$label" "output contains forbidden '$needle'"
  else pass "$label"; fi
}

assert_file_empty() {
  local label="$1" path="$2"
  if [ ! -s "$path" ]; then pass "$label"
  else fail "$label" "expected empty file but found: $(cat "$path")"; fi
}

# --- single shared temp dir for the whole suite ---------------------
_CONTRACT_TMP=$(mktemp -d)
cleanup_tmp() { [ -d "${_CONTRACT_TMP:-}" ] && rm -rf "$_CONTRACT_TMP"; }
trap cleanup_tmp EXIT

# --- Resolve scripts (must exist for GREEN) ------------------------
COMMON_SH="$REPO_ROOT/scripts/lib/android-env-common.sh"
INSTALL_SH="$REPO_ROOT/scripts/install-android-platform-tools.sh"
CHECK_ADB_SH="$REPO_ROOT/scripts/check-adb.sh"

# --- PATH fixture: real shell utilities retained, any host adb hidden --
# Filters PATH down to directories that do NOT contain an adb executable,
# so PATH-resolution tests are genuine regardless of whether this host
# happens to have adb installed.
_path_without_adb() {
  local dir result=""
  local saved_ifs="$IFS"
  IFS=':'
  for dir in $PATH; do
    if [ -n "$dir" ] && [ -x "$dir/adb" ]; then
      continue
    fi
    result="${result:+$result:}$dir"
  done
  IFS="$saved_ifs"
  printf '%s' "$result"
}
BASE_PATH_NO_ADB="$(_path_without_adb)"

# --- Fake binaries ---------------------------------------------------
FAKE_BIN="$_CONTRACT_TMP/fakebin"
mkdir -p "$FAKE_BIN"

# Fake adb: version only (used for override no-op / idempotency tests).
FAKE_ADB="$FAKE_BIN/adb_version_only"
cat > "$FAKE_ADB" <<'ADBEOF'
#!/usr/bin/env bash
echo "Android Debug Bridge version 1.0.41"
exit 0
ADBEOF
chmod +x "$FAKE_ADB"

# Fake adb: version + devices + -s + connect (used for check-adb tests).
FAKE_ADB_FULL="$FAKE_BIN/adb_full"
cat > "$FAKE_ADB_FULL" <<'ADBEOF'
#!/usr/bin/env bash
case "$1" in
  version) echo "Android Debug Bridge version 1.0.41"; exit 0 ;;
  devices)
    echo "List of devices attached"
    echo "127.0.0.1:5555	device"
    echo ""
    exit 0
    ;;
  -s)
    shift
    case "$2" in
      get-state) echo "device"; exit 0 ;;
      *) echo "FAKE_ADB: unsupported -s command: $*" >&2; exit 1 ;;
    esac
    ;;
  connect) echo "connected to $2"; exit 0 ;;
  *) echo "FAKE_ADB: unsupported: $*" >&2; exit 1 ;;
esac
ADBEOF
chmod +x "$FAKE_ADB_FULL"

# Fake adb: no device attached (used for --expect-redroid failure test).
FAKE_ADB_NO_DEVICE="$FAKE_BIN/adb_no_device"
cat > "$FAKE_ADB_NO_DEVICE" <<'ADBEOF'
#!/usr/bin/env bash
case "$1" in
  version) echo "Android Debug Bridge version 1.0.41"; exit 0 ;;
  devices)
    echo "List of devices attached"
    echo ""
    exit 0
    ;;
  connect) echo "failed to connect to $2"; exit 1 ;;
  *) echo "FAKE_ADB: unsupported: $*" >&2; exit 1 ;;
esac
ADBEOF
chmod +x "$FAKE_ADB_NO_DEVICE"

# Fake adb: deliberately wrong/competing binary, to prove override wins over
# PATH. Lives in its own directory (never FAKE_BIN, which the privilege-test
# PATH fixture below must keep free of any file named "adb").
WRONG_ADB_BIN="$_CONTRACT_TMP/wrongadbbin"
mkdir -p "$WRONG_ADB_BIN"
FAKE_ADB_WRONG="$WRONG_ADB_BIN/adb"
cat > "$FAKE_ADB_WRONG" <<'ADBEOF'
#!/usr/bin/env bash
echo "Android Debug Bridge version 0.0.1-WRONG"
exit 0
ADBEOF
chmod +x "$FAKE_ADB_WRONG"

# Fake adb living alone in its own directory, for genuine no-override
# PATH-resolution tests (kept separate from FAKE_BIN's other fakes/adb).
ADB_ONLY_BIN="$_CONTRACT_TMP/adbonlybin"
mkdir -p "$ADB_ONLY_BIN"
FAKE_ADB_PATH_ONLY="$ADB_ONLY_BIN/adb"
cat > "$FAKE_ADB_PATH_ONLY" <<'ADBEOF'
#!/usr/bin/env bash
echo "Android Debug Bridge version 1.0.41"
exit 0
ADBEOF
chmod +x "$FAKE_ADB_PATH_ONLY"

# Fake apt-get: logs every invocation to a file so tests can prove
# whether or not it was ever called, independent of stdout buffering.
APT_CALL_LOG="$_CONTRACT_TMP/apt-calls.log"
: > "$APT_CALL_LOG"
FAKE_APT="$FAKE_BIN/apt-get"
cat > "$FAKE_APT" <<APTEOF
#!/usr/bin/env bash
echo "\$*" >> "$APT_CALL_LOG"
echo "FAKE_APT_GET called with: \$*" >&2
exit 0
APTEOF
chmod +x "$FAKE_APT"

# Fake sudo: present on PATH but denies noninteractive access (simulates
# "no usable sudo" without requiring sudo to be absent from PATH).
FAKE_SUDO="$FAKE_BIN/sudo"
cat > "$FAKE_SUDO" <<'SUDOEOF'
#!/usr/bin/env bash
echo "FAKE_SUDO called" >&2
exit 1
SUDOEOF
chmod +x "$FAKE_SUDO"

# Fake id: reports a non-root uid. Must handle `-u` (numeric only),
# matching real `id -u` semantics used by the install script.
FAKE_ID="$FAKE_BIN/id"
cat > "$FAKE_ID" <<'IDEOF'
#!/usr/bin/env bash
case "$1" in
  -u) echo "1000" ;;
  *) echo "uid=1000(agent-runner) gid=1000(agent-runner) groups=1000(agent-runner)" ;;
esac
exit 0
IDEOF
chmod +x "$FAKE_ID"

# PATH fixture: fake apt-get/sudo/id, no fake adb, real shell utilities
# (coreutils/bash/grep/etc.) retained via BASE_PATH_NO_ADB, host adb hidden.
PRIVILEGE_TEST_PATH="$FAKE_BIN:$BASE_PATH_NO_ADB"

# =====================================================================
# GROUP 1: android-env-common.sh helpers
# =====================================================================
echo "=== Group 1: android-env-common.sh ==="

# Test: assert_loopback_publish rejects 0.0.0.0:5555:5555
(
  source "$COMMON_SH"
  assert_loopback_publish "0.0.0.0:5555:5555" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "assert_loopback_publish rejects 0.0.0.0:5555:5555" "did not reject public interface" \
  || pass "assert_loopback_publish rejects 0.0.0.0:5555:5555"

# Test: assert_loopback_publish accepts 127.0.0.1:5555:5555
(
  source "$COMMON_SH"
  assert_loopback_publish "127.0.0.1:5555:5555" 2>/dev/null
  echo "CORRECTLY_ACCEPTED"
) 2>/dev/null | grep -q "CORRECTLY_ACCEPTED" \
  && pass "assert_loopback_publish accepts 127.0.0.1:5555:5555" \
  || fail "assert_loopback_publish accepts 127.0.0.1:5555:5555" "rejected valid loopback spec"

# Test: assert_loopback_publish rejects ambiguous host-port (no explicit binding)
(
  source "$COMMON_SH"
  assert_loopback_publish "5555:5555" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "assert_loopback_publish rejects 5555:5555 (ambiguous)" "did not reject" \
  || pass "assert_loopback_publish rejects 5555:5555 (ambiguous)"

# Test: assert_loopback_publish rejects 127.0.0.1:5555 (missing container port)
(
  source "$COMMON_SH"
  assert_loopback_publish "127.0.0.1:5555" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "assert_loopback_publish rejects 127.0.0.1:5555 (missing container port)" "did not reject" \
  || pass "assert_loopback_publish rejects 127.0.0.1:5555 (missing container port)"

# Test: assert_loopback_publish rejects 0.0.0.0:5555
(
  source "$COMMON_SH"
  assert_loopback_publish "0.0.0.0:5555" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "assert_loopback_publish rejects 0.0.0.0:5555" "did not reject public interface" \
  || pass "assert_loopback_publish rejects 0.0.0.0:5555"

# Test: fail function exits nonzero and writes to stderr
(
  source "$COMMON_SH"
  fail "test error message" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "fail exits nonzero" "did not exit nonzero" \
  || pass "fail exits nonzero"

# Test: fail function output contains message
FAIL_OUTPUT=$( (
  source "$COMMON_SH"
  fail "specific error text XYZ" 2>&1 || true
) 2>&1 )
echo "$FAIL_OUTPUT" | grep -q "specific error text XYZ" && pass "fail outputs message to stderr" \
  || fail "fail outputs message" "message not found in output"

# Test: require_cmd succeeds for existing command
(
  source "$COMMON_SH"
  require_cmd bash 2>/dev/null
  echo "CORRECTLY_SUCCEEDED"
) 2>/dev/null | grep -q "CORRECTLY_SUCCEEDED" \
  && pass "require_cmd succeeds for bash" \
  || fail "require_cmd succeeds for bash" "rejected existing command"

# Test: require_cmd fails for nonexistent command
(
  source "$COMMON_SH"
  require_cmd __nonexistent_command_xyz_12345 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "require_cmd fails for missing command" "accepted nonexistent command" \
  || pass "require_cmd fails for missing command"

# Test: ReDroid defaults are defined
(
  source "$COMMON_SH"
  if [ -n "${UI_DIFF_REDROID_NAME:-}" ] && \
     [ -n "${UI_DIFF_REDROID_IMAGE:-}" ] && \
     [ -n "${UI_DIFF_REDROID_ADB_HOST:-}" ] && \
     [ -n "${UI_DIFF_REDROID_ADB_PORT:-}" ] && \
     [ -n "${UI_DIFF_REDROID_DATA_DIR:-}" ]; then
    echo "CORRECTLY_DEFINED"
  else
    echo "MISSING_DEFAULTS"
  fi
) | grep -q "CORRECTLY_DEFINED" && pass "ReDroid defaults are defined" \
  || fail "ReDroid defaults are defined" "some defaults missing"

# =====================================================================
# GROUP 2: install-android-platform-tools.sh --check-only / override,
# missing or invalid adb - must fail closed and never touch apt-get.
# =====================================================================
echo ""
echo "=== Group 2: install-android-platform-tools.sh --check-only / invalid override ==="

_NONEXISTENT_ADB="$_CONTRACT_TMP/nonexistent-adb-binary"

# Test: --check-only exits nonzero when UI_DIFF_ADB_BIN points to nonexistent path
(
  export UI_DIFF_ADB_BIN="$_NONEXISTENT_ADB"
  bash "$INSTALL_SH" --check-only 2>/dev/null
) && fail "check-only with nonexistent UI_DIFF_ADB_BIN" "expected nonzero exit" \
  || pass "check-only with nonexistent UI_DIFF_ADB_BIN exits nonzero"

CHECK_ONLY_OUTPUT=$(
  export UI_DIFF_ADB_BIN="$_NONEXISTENT_ADB"
  bash "$INSTALL_SH" --check-only 2>&1 || true
)
assert_contains "check-only output mentions adb" "$CHECK_ONLY_OUTPUT" "adb"

echo "$CHECK_ONLY_OUTPUT" | grep -qiE "install|apt|remediat|sudo|fix|unset" && pass "check-only mentions remediation" \
  || fail "check-only mentions remediation" "no remediation hint"

# Test: invalid explicit override never calls apt-get (fails closed before install logic)
: > "$APT_CALL_LOG"
(
  export UI_DIFF_ADB_BIN="$_NONEXISTENT_ADB"
  export PATH="$FAKE_BIN:$BASE_PATH_NO_ADB"
  bash "$INSTALL_SH" 2>/dev/null
) || true
assert_file_empty "invalid explicit override never invokes apt-get" "$APT_CALL_LOG"

# =====================================================================
# GROUP 3: install-android-platform-tools.sh with usable explicit override
# (no-op; must not install).
# =====================================================================
echo ""
echo "=== Group 3: install-android-platform-tools.sh with usable override ==="

(
  export UI_DIFF_ADB_BIN="$FAKE_ADB"
  bash "$INSTALL_SH" 2>/dev/null
) && pass "install with usable override exits 0 (no-op)" \
  || fail "install with usable override exits 0" "nonzero exit with usable adb"

OVERRIDE_INSTALL_OUTPUT=$(
  export UI_DIFF_ADB_BIN="$FAKE_ADB"
  bash "$INSTALL_SH" 2>&1 || true
)
assert_contains "install with override reports exact resolved path" "$OVERRIDE_INSTALL_OUTPUT" "$FAKE_ADB"
assert_contains "install with override reports exact version" "$OVERRIDE_INSTALL_OUTPUT" "1.0.41"

: > "$APT_CALL_LOG"
(
  export UI_DIFF_ADB_BIN="$FAKE_ADB"
  export PATH="$FAKE_BIN:$BASE_PATH_NO_ADB"
  bash "$INSTALL_SH" >/dev/null 2>&1
) || true
assert_file_empty "install no-op (usable override) never invokes apt-get" "$APT_CALL_LOG"

# =====================================================================
# GROUP 4: check-adb.sh
# =====================================================================
echo ""
echo "=== Group 4: check-adb.sh ==="

(
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  bash "$CHECK_ADB_SH" 2>&1 || true
) | grep -q "Android Debug Bridge" && pass "check-adb prints version" \
  || fail "check-adb prints version" "version not found"

(
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  bash "$CHECK_ADB_SH" 2>&1 || true
) | grep -q "127.0.0.1:5555" && pass "check-adb shows devices" \
  || fail "check-adb shows devices" "device not listed"

(
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  bash "$CHECK_ADB_SH" --expect-redroid 2>/dev/null
) && pass "check-adb --expect-redroid passes" \
  || fail "check-adb --expect-redroid passes" "exited nonzero with device present"

(
  export UI_DIFF_ADB_BIN="$FAKE_ADB_NO_DEVICE"
  bash "$CHECK_ADB_SH" --expect-redroid 2>/dev/null
) && fail "check-adb --expect-redroid fails without device" "expected nonzero exit" \
  || pass "check-adb --expect-redroid fails without device"

# =====================================================================
# GROUP 5: cwd independence
# =====================================================================
echo ""
echo "=== Group 5: cwd independence ==="

(
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  cd /tmp
  bash "$INSTALL_SH" --check-only 2>/dev/null
) && pass "install --check-only works from /tmp cwd" \
  || fail "install --check-only works from /tmp cwd" "failed from different cwd"

(
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  cd /tmp
  bash "$CHECK_ADB_SH" 2>&1 || true
) | grep -q "Android Debug Bridge" && pass "check-adb works from /tmp cwd" \
  || fail "check-adb works from /tmp cwd" "failed from different cwd"

# =====================================================================
# GROUP 6: No public publish string in scripts
# =====================================================================
echo ""
echo "=== Group 6: No public publish in Docker behavior ==="

NOT_PUB=$(grep -c "0\.0\.0\.0:5555" "$COMMON_SH" || true)
[ "${NOT_PUB:-0}" -eq 0 ] && pass "android-env-common.sh has no 0.0.0.0 publish" \
  || fail "android-env-common.sh has no 0.0.0.0 publish" "found 0.0.0.0:5555 reference"

NOT_PUB_INSTALL=$(grep -c "0\.0\.0\.0:5555" "$INSTALL_SH" || true)
[ "${NOT_PUB_INSTALL:-0}" -eq 0 ] && pass "install script has no 0.0.0.0 publish" \
  || fail "install script has no 0.0.0.0 publish" "found 0.0.0.0:5555 reference"

NOT_PUB_CHECK=$(grep -c "0\.0\.0\.0:5555" "$CHECK_ADB_SH" || true)
[ "${NOT_PUB_CHECK:-0}" -eq 0 ] && pass "check-adb has no 0.0.0.0 publish" \
  || fail "check-adb has no 0.0.0.0 publish" "found 0.0.0.0:5555 reference"

NOT_CURL=$(grep -ciE "curl.*platform.tools|wget.*platform.tools" "$INSTALL_SH" || true)
[ "${NOT_CURL:-0}" -eq 0 ] && pass "install script has no curl platform-tools download" \
  || fail "install script has no curl platform-tools download" "found curl/wget platform-tools reference"

# =====================================================================
# GROUP 7: install script edge cases (override path, fake sudo present)
# =====================================================================
echo ""
echo "=== Group 7: install script edge cases ==="

# --check-only with an invalid override must still fail closed even if a
# (denying) sudo happens to be on PATH - it must never reach the sudo check.
(
  export UI_DIFF_ADB_BIN="$_NONEXISTENT_ADB"
  export PATH="$FAKE_BIN:$BASE_PATH_NO_ADB"
  bash "$INSTALL_SH" --check-only 2>/dev/null
) && fail "check-only with fake sudo still nonzero" "expected nonzero" \
  || pass "check-only with fake sudo still nonzero"

# install script is safe to re-run (idempotent) via a usable override
(
  export UI_DIFF_ADB_BIN="$FAKE_ADB"
  bash "$INSTALL_SH" 2>/dev/null
  bash "$INSTALL_SH" 2>/dev/null
) && pass "install is idempotent (two runs)" \
  || fail "install is idempotent" "second run failed"

# =====================================================================
# GROUP 8: Script structure checks
# =====================================================================
echo ""
echo "=== Group 8: Script structure ==="

grep -q "set -euo pipefail" "$COMMON_SH" && pass "common uses set -euo pipefail" \
  || fail "common uses set -euo pipefail" "missing strict mode"

grep -q "set -euo pipefail" "$INSTALL_SH" && pass "install uses set -euo pipefail" \
  || fail "install uses set -euo pipefail" "missing strict mode"

grep -q "set -euo pipefail" "$CHECK_ADB_SH" && pass "check-adb uses set -euo pipefail" \
  || fail "check-adb uses set -euo pipefail" "missing strict mode"

grep -q "REPO_ROOT" "$COMMON_SH" && pass "common resolves REPO_ROOT" \
  || fail "common resolves REPO_ROOT" "no REPO_ROOT"

grep -q "REPO_ROOT" "$INSTALL_SH" && pass "install resolves REPO_ROOT" \
  || fail "install resolves REPO_ROOT" "no REPO_ROOT"

grep -q "REPO_ROOT" "$CHECK_ADB_SH" && pass "check-adb resolves REPO_ROOT" \
  || fail "check-adb resolves REPO_ROOT" "no REPO_ROOT"

[ -x "$COMMON_SH" ] && pass "common.sh is executable" \
  || fail "common.sh is executable" "not executable"

[ -x "$INSTALL_SH" ] && pass "install.sh is executable" \
  || fail "install.sh is executable" "not executable"

[ -x "$CHECK_ADB_SH" ] && pass "check-adb.sh is executable" \
  || fail "check-adb.sh is executable" "not executable"

# =====================================================================
# GROUP 9: genuine no-override PATH resolution (no UI_DIFF_ADB_BIN set at all)
# =====================================================================
echo ""
echo "=== Group 9: genuine no-override PATH resolution ==="

# try_resolve_adb_bin (nonfatal) resolves via PATH when no override is set.
(
  unset UI_DIFF_ADB_BIN
  export PATH="$ADB_ONLY_BIN:$BASE_PATH_NO_ADB"
  source "$COMMON_SH"
  if try_resolve_adb_bin && [ "$ADB_BIN" = "$FAKE_ADB_PATH_ONLY" ] && [ -n "$ADB_VERSION" ]; then
    echo "RESOLVED_OK"
  else
    echo "NOT_RESOLVED"
  fi
) | grep -q "RESOLVED_OK" && pass "try_resolve_adb_bin: no-override genuine PATH resolve works" \
  || fail "try_resolve_adb_bin: no-override genuine PATH resolve works" "failed to resolve via PATH"

# resolve_adb_bin (fatal wrapper) also resolves via PATH when no override is set.
(
  unset UI_DIFF_ADB_BIN
  export PATH="$ADB_ONLY_BIN:$BASE_PATH_NO_ADB"
  source "$COMMON_SH"
  resolve_adb_bin
  if [ "$ADB_BIN" = "$FAKE_ADB_PATH_ONLY" ] && [ -n "$ADB_VERSION" ]; then
    echo "RESOLVED_OK"
  else
    echo "NOT_RESOLVED"
  fi
) | grep -q "RESOLVED_OK" && pass "resolve_adb_bin: no-override genuine PATH resolve works" \
  || fail "resolve_adb_bin: no-override genuine PATH resolve works" "failed to resolve via PATH"

# try_resolve_adb_bin (nonfatal) returns 1 with no output/exit when no adb is on PATH.
NONFATAL_OUTPUT=$( (
  unset UI_DIFF_ADB_BIN
  export PATH="$BASE_PATH_NO_ADB"
  source "$COMMON_SH"
  if try_resolve_adb_bin; then
    echo "UNEXPECTED_SUCCESS"
  else
    echo "CORRECTLY_FAILED_NONFATAL"
  fi
) 2>&1 )
echo "$NONFATAL_OUTPUT" | grep -q "CORRECTLY_FAILED_NONFATAL" && pass "try_resolve_adb_bin: no adb on PATH returns 1 (not fatal)" \
  || fail "try_resolve_adb_bin: no adb on PATH returns 1" "did not fail nonfatally: $NONFATAL_OUTPUT"

# The install script's no-op path is reachable via genuine PATH resolution
# (no override set) - must not touch apt-get.
: > "$APT_CALL_LOG"
INSTALL_PATH_NOOP_OUTPUT=$(
  unset UI_DIFF_ADB_BIN
  export PATH="$ADB_ONLY_BIN:$FAKE_BIN:$BASE_PATH_NO_ADB"
  bash "$INSTALL_SH" 2>&1
)
INSTALL_PATH_NOOP_EXIT=$?
[ "$INSTALL_PATH_NOOP_EXIT" -eq 0 ] && pass "install no-op via genuine PATH adb exits 0" \
  || fail "install no-op via genuine PATH adb exits 0" "nonzero exit: $INSTALL_PATH_NOOP_EXIT"
assert_contains "install no-op via genuine PATH adb reports version" "$INSTALL_PATH_NOOP_OUTPUT" "1.0.41"
assert_file_empty "install no-op via genuine PATH adb never invokes apt-get" "$APT_CALL_LOG"

# =====================================================================
# GROUP 10: no-override, no PATH adb, non-root, no sudo - must reach and
# fail in the privilege-check branch (not the earlier override-fail path).
# =====================================================================
echo ""
echo "=== Group 10: no-override / missing PATH adb privilege-failure branch ==="

: > "$APT_CALL_LOG"
PRIVILEGE_OUTPUT=$(
  unset UI_DIFF_ADB_BIN
  export PATH="$PRIVILEGE_TEST_PATH"
  bash "$INSTALL_SH" 2>&1
)
PRIVILEGE_EXIT=$?

[ "$PRIVILEGE_EXIT" -ne 0 ] && pass "no-override/no-adb install exits nonzero" \
  || fail "no-override/no-adb install exits nonzero" "expected nonzero exit"

assert_contains "no-override/no-adb install reaches the apt-get install attempt" "$PRIVILEGE_OUTPUT" "installing via apt-get"
assert_not_contains "no-override/no-adb install does not use the UI_DIFF_ADB_BIN override message" "$PRIVILEGE_OUTPUT" "UI_DIFF_ADB_BIN"
echo "$PRIVILEGE_OUTPUT" | grep -qiE "root|sudo|privilege" && pass "no-override/no-adb install mentions root/sudo/privilege" \
  || fail "no-override/no-adb install mentions root/sudo/privilege" "no privilege remediation in output: $PRIVILEGE_OUTPUT"
assert_file_empty "no-override/no-adb privilege failure never invokes apt-get" "$APT_CALL_LOG"

# =====================================================================
# GROUP 11: ReDroid image defaults pinning
# =====================================================================
echo ""
echo "=== Group 11: ReDroid image defaults ==="

(
  source "$COMMON_SH"
  echo "$UI_DIFF_REDROID_IMAGE"
) | grep -q "sha256:" && pass "ReDroid image has sha256 pin" \
  || fail "ReDroid image has sha256 pin" "no sha256 in image"

(
  source "$COMMON_SH"
  echo "$UI_DIFF_REDROID_ADB_HOST"
) | grep -q "127.0.0.1" && pass "ADB host is 127.0.0.1" \
  || fail "ADB host is 127.0.0.1" "wrong host"

(
  source "$COMMON_SH"
  echo "$UI_DIFF_REDROID_ADB_PORT"
) | grep -q "5555" && pass "ADB port is 5555" \
  || fail "ADB port is 5555" "wrong port"

# =====================================================================
# GROUP 12: resolve_adb_bin / try_resolve_adb_bin override semantics
# =====================================================================
echo ""
echo "=== Group 12: resolve_adb_bin override semantics ==="

# UI_DIFF_ADB_BIN wins over a genuinely different, competing PATH adb.
(
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export PATH="$WRONG_ADB_BIN:$BASE_PATH_NO_ADB"
  source "$COMMON_SH"
  resolve_adb_bin
  if [ "$ADB_BIN" = "$FAKE_ADB_FULL" ] && [ "$ADB_BIN" != "$FAKE_ADB_WRONG" ]; then
    echo "CORRECT_OVERRIDE"
  else
    echo "WRONG_ADB: $ADB_BIN"
  fi
) | grep -q "CORRECT_OVERRIDE" && pass "UI_DIFF_ADB_BIN wins over a competing PATH adb" \
  || fail "UI_DIFF_ADB_BIN wins over a competing PATH adb" "override did not win"

# resolve_adb_bin (fatal): nonexistent override fails closed, no PATH fallback.
(
  export UI_DIFF_ADB_BIN="$_CONTRACT_TMP/nonexistent-adb-for-real"
  export PATH="$FAKE_BIN:$BASE_PATH_NO_ADB"
  source "$COMMON_SH"
  resolve_adb_bin 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "nonexistent UI_DIFF_ADB_BIN fails closed" "fell through to PATH" \
  || pass "nonexistent UI_DIFF_ADB_BIN fails closed"

# try_resolve_adb_bin (nonfatal): same override also fails closed, no PATH fallback,
# but returns 1 rather than exiting the process.
(
  export UI_DIFF_ADB_BIN="$_CONTRACT_TMP/nonexistent-adb-for-real"
  export PATH="$FAKE_BIN:$BASE_PATH_NO_ADB"
  source "$COMMON_SH"
  if try_resolve_adb_bin; then
    echo "UNEXPECTED_SUCCESS"
  else
    echo "CORRECTLY_FAILED_NONFATAL"
  fi
) | grep -q "CORRECTLY_FAILED_NONFATAL" && pass "try_resolve_adb_bin: nonexistent override fails closed, nonfatal" \
  || fail "try_resolve_adb_bin: nonexistent override fails closed, nonfatal" "did not fail closed nonfatally"

ERR_OUTPUT=$( (
  export UI_DIFF_ADB_BIN="$_CONTRACT_TMP/nonexistent-adb-for-real"
  source "$COMMON_SH"
  resolve_adb_bin 2>&1 || true
) 2>&1 )
echo "$ERR_OUTPUT" | grep -q "UI_DIFF_ADB_BIN" && pass "nonexistent override error mentions variable" \
  || fail "nonexistent override error mentions variable" "UI_DIFF_ADB_BIN not in error"

_NONEXEC="$_CONTRACT_TMP/nonexec-adb"
touch "$_NONEXEC"
chmod -x "$_NONEXEC"
(
  export UI_DIFF_ADB_BIN="$_NONEXEC"
  source "$COMMON_SH"
  resolve_adb_bin 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "non-executable UI_DIFF_ADB_BIN fails closed" "accepted non-executable" \
  || pass "non-executable UI_DIFF_ADB_BIN fails closed"

_BAD_VERSION_ADB="$_CONTRACT_TMP/bad-version-adb"
cat > "$_BAD_VERSION_ADB" <<'ADBEOF'
#!/usr/bin/env bash
echo "NOT_AN_ADB_VERSION_STRING"
exit 0
ADBEOF
chmod +x "$_BAD_VERSION_ADB"
(
  export UI_DIFF_ADB_BIN="$_BAD_VERSION_ADB"
  source "$COMMON_SH"
  resolve_adb_bin 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "bad version UI_DIFF_ADB_BIN fails closed" "accepted bad version output" \
  || pass "bad version UI_DIFF_ADB_BIN fails closed"

# install script with a usable override reports the exact resolved path and
# version - not adb devices output, which is check-adb.sh's responsibility.
OVERRIDE_INSTALL_OUTPUT_2=$(
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  bash "$INSTALL_SH" 2>&1 || true
)
assert_contains "install with override reports exact resolved binary path" "$OVERRIDE_INSTALL_OUTPUT_2" "$FAKE_ADB_FULL"
assert_contains "install with override reports exact resolved version" "$OVERRIDE_INSTALL_OUTPUT_2" "1.0.41"
assert_not_contains "install output does not include adb devices output" "$OVERRIDE_INSTALL_OUTPUT_2" "List of devices attached"

(
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  bash "$CHECK_ADB_SH" 2>&1 || true
) | grep -q "127.0.0.1:5555" && pass "check-adb uses resolved override binary (shows devices)" \
  || fail "check-adb uses resolved override binary" "device info not from resolved binary"

# =====================================================================
# Summary
# =====================================================================
echo ""
echo "================================================================"
printf "Shell contract tests: %d run, %d passed, %d failed\n" "$TESTS_RUN" "$PASS" "$FAIL"
echo "================================================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
