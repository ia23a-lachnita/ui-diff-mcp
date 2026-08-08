#!/usr/bin/env bash
# scripts/lib/android-env-common.sh - shared helpers for android env scripts
# Exports ReDroid defaults and utility functions: require_cmd, fail, assert_loopback_publish.
# Source this file; do not execute directly.
# Resolves REPO_ROOT from the script's own location regardless of cwd.
set -euo pipefail

# --- Repo root resolution ------------------------------------------
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$_SCRIPT_DIR/../.." && pwd)"

# --- ReDroid defaults ----------------------------------------------
export UI_DIFF_REDROID_NAME="ui-diff-redroid"
export UI_DIFF_REDROID_IMAGE="redroid/redroid@sha256:46478a567194aed24cd0877d4434a9e58b534d4aad30931eb21999a52f2ce131"
export UI_DIFF_REDROID_ADB_HOST="127.0.0.1"
export UI_DIFF_REDROID_ADB_PORT="5555"
export UI_DIFF_REDROID_DATA_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/ui-diff-mcp/redroid-data"

# --- fail -----------------------------------------------------------
# Print message to stderr and exit 1.
fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

# --- require_cmd ----------------------------------------------------
# Verify that a command is available on PATH; fail with remediation if not.
require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    fail "Required command '$cmd' not found on PATH. Please install it before proceeding."
  fi
}

# --- try_resolve_adb_bin --------------------------------------------
# Nonfatal resolution of the adb binary to use:
#   - If UI_DIFF_ADB_BIN is set, require that exact path to be executable
#     and its `version` command to be usable. Never falls through to
#     PATH adb when the override is set - an invalid override fails
#     this function rather than silently trying a different binary.
#   - Otherwise resolve via `command -v adb` and require a usable version.
# On success, exports ADB_BIN with the resolved path and ADB_VERSION
# with the first line of `adb version` output, and returns 0.
# On failure, returns 1 with no output and no exit - callers decide
# whether a missing/unusable adb is fatal (resolve_adb_bin) or the
# trigger to attempt installation (install-android-platform-tools.sh).
# Avoids piping `adb version` output through head/grep: under
# `set -o pipefail`, a downstream reader (e.g. `grep -q`) that exits
# early can send the upstream writer SIGPIPE, and pipefail then
# reports that upstream failure even though the match succeeded.
try_resolve_adb_bin() {
  local candidate="" raw_version="" first_line=""

  if [ -n "${UI_DIFF_ADB_BIN:-}" ]; then
    candidate="$UI_DIFF_ADB_BIN"
    [ -x "$candidate" ] || return 1
  else
    candidate="$(command -v adb 2>/dev/null || true)"
    [ -n "$candidate" ] || return 1
  fi

  raw_version=$("$candidate" version 2>&1) || return 1
  first_line="${raw_version%%$'\n'*}"
  case "$first_line" in
    *[Aa]ndroid*[Dd]ebug*[Bb]ridge*) ;;
    *) return 1 ;;
  esac

  ADB_BIN="$candidate"
  ADB_VERSION="$first_line"
  export ADB_BIN ADB_VERSION
  return 0
}

# --- resolve_adb_bin -----------------------------------------------
# Fatal wrapper around try_resolve_adb_bin: exits non-zero with a
# remediation message when no usable adb can be resolved. Use this
# only where a missing/unusable adb should hard-stop the script
# (--check-only, an explicit UI_DIFF_ADB_BIN override, or verifying
# a just-completed install). Use try_resolve_adb_bin directly where
# a missing adb should instead trigger installation logic.
resolve_adb_bin() {
  if [ -n "${UI_DIFF_ADB_BIN:-}" ]; then
    if ! try_resolve_adb_bin; then
      fail "UI_DIFF_ADB_BIN is set to '${UI_DIFF_ADB_BIN}' but it is not executable, or 'adb version' failed or returned unexpected output. Fix or unset UI_DIFF_ADB_BIN. No PATH fallback is used when this override is set."
    fi
    return 0
  fi

  if ! try_resolve_adb_bin; then
    fail "adb is not installed or not usable on PATH. Install with: sudo apt-get install adb android-sdk-platform-tools-common"
  fi
  return 0
}

# --- assert_loopback_publish ----------------------------------------
# Accept only exactly "127.0.0.1:5555:5555" as a valid loopback publish spec.
# Reject any other form: 0.0.0.0, missing container port, ambiguous host-port, etc.
# This is intentionally strict; documented equivalent forms can be added here if needed.
assert_loopback_publish() {
  local spec="$1"
  local allowed="127.0.0.1:5555:5555"
  if [ "$spec" != "$allowed" ]; then
    fail "Publish spec '$spec' is not allowed. Only '$allowed' (explicit loopback) is accepted."
  fi
}
