#!/usr/bin/env bash
# scripts/install-android-platform-tools.sh - install and verify adb/udev on Debian/Ubuntu
# Usage:
#   install-android-platform-tools.sh [--check-only]
#
# --check-only, or any explicit UI_DIFF_ADB_BIN override: require an already-usable
#   adb (fatal resolve_adb_bin). Never attempts an install in either case.
# No override, adb already usable on PATH: no-op (reports udev state).
# No override, adb missing/unusable on PATH: installs via apt-get on Debian/Ubuntu
#   only, after requiring root or noninteractive sudo, then verifies the result.
# Uses the distro package manager only; never fetches platform-tools archives directly.
# Safe to re-run (idempotent).
set -euo pipefail

# --- Resolve repo root from own location ----------------------------
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$_SCRIPT_DIR/.." && pwd)"

# Source shared helpers
# shellcheck source=scripts/lib/android-env-common.sh
source "$_SCRIPT_DIR/lib/android-env-common.sh"

# --- Report udev rule state for android/adb rules ------------------
_report_udev_state() {
  local udev_rules_dir="/etc/udev/rules.d"
  local android_rules=""
  if [ -d "$udev_rules_dir" ]; then
    android_rules=$(find "$udev_rules_dir" \( -name '*android*' -o -name '*adb*' \) 2>/dev/null | head -5 || true)
    if [ -n "$android_rules" ]; then
      printf 'udev android/adb rules found:\n'
      echo "$android_rules"
    else
      printf 'No android/adb udev rules found in %s\n' "$udev_rules_dir"
    fi
  else
    printf 'udev rules directory %s does not exist\n' "$udev_rules_dir"
  fi
}

# --- Parse arguments ------------------------------------------------
CHECK_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=true ;;
    *) fail "Unknown argument: $arg" ;;
  esac
done

HAS_OVERRIDE=false
if [ -n "${UI_DIFF_ADB_BIN:-}" ]; then
  HAS_OVERRIDE=true
fi

# --- --check-only or an explicit override: require usable adb, never install --
if [ "$CHECK_ONLY" = true ] || [ "$HAS_OVERRIDE" = true ]; then
  resolve_adb_bin
  printf 'adb found: %s (%s)\n' "$ADB_BIN" "$ADB_VERSION"
  exit 0
fi

# --- No override: if adb is already usable on PATH, no-op ----------
if try_resolve_adb_bin; then
  printf 'adb already installed: %s (%s)\n' "$ADB_BIN" "$ADB_VERSION"
  _report_udev_state
  exit 0
fi

# --- No override, adb missing/unusable on PATH: install via apt-get ----
printf 'adb not found on PATH; installing via apt-get...\n'

if ! command -v apt-get >/dev/null 2>&1; then
  fail "apt-get not found. This script only supports Debian/Ubuntu. Install adb manually."
fi

IS_ROOT=false
if [ "$(id -u)" -eq 0 ]; then
  IS_ROOT=true
fi

SUDO_CMD=""
if [ "$IS_ROOT" = false ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    SUDO_CMD="sudo"
  else
    fail "Root privileges required to install adb. Run as root or provide noninteractive sudo access. Example: sudo apt-get install adb android-sdk-platform-tools-common"
  fi
fi

$SUDO_CMD apt-get update -qq
$SUDO_CMD apt-get install -y --no-install-recommends adb android-sdk-platform-tools-common

# --- Verify installation --------------------------------------------
resolve_adb_bin
printf 'adb installed successfully: %s (%s)\n' "$ADB_BIN" "$ADB_VERSION"
_report_udev_state

exit 0
