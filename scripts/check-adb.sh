#!/usr/bin/env bash
# scripts/check-adb.sh - verify adb binary and optional ReDroid device presence
# Usage:
#   check-adb.sh [--expect-redroid]
#
# Prints adb version and device list.
# --expect-redroid: requires a "device" state line for serial 127.0.0.1:5555; fails if absent.
# Never attempts to bind or rebind ADB to a public interface.
set -euo pipefail

# --- Resolve repo root from own location ----------------------------
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$_SCRIPT_DIR/.." && pwd)"

# Source shared helpers
# shellcheck source=scripts/lib/android-env-common.sh
source "$_SCRIPT_DIR/lib/android-env-common.sh"

# --- Parse arguments ------------------------------------------------
EXPECT_REDROID=false
for arg in "$@"; do
  case "$arg" in
    --expect-redroid) EXPECT_REDROID=true ;;
    *) fail "Unknown argument: $arg" ;;
  esac
done

# --- Resolve adb binary --------------------------------------------
if ! resolve_adb_bin; then
  exit 1
fi

# --- Print version --------------------------------------------------
printf '=== adb version ===\n'
"$ADB_BIN" version

# --- Print devices --------------------------------------------------
printf '\n=== adb devices ===\n'
"$ADB_BIN" devices

# --- Expect-redroid check ------------------------------------------
if [ "$EXPECT_REDROID" = true ]; then
  DEVICES_OUTPUT="$("$ADB_BIN" devices 2>&1)"

  # Look for a device line with serial 127.0.0.1:5555 and state "device"
  REDROID_FOUND=false
  while IFS= read -r line; do
    case "$line" in
      "127.0.0.1:5555"$'\t'"device"*) REDROID_FOUND=true; break ;;
    esac
  done <<< "$DEVICES_OUTPUT"

  if [ "$REDROID_FOUND" = false ]; then
    fail "Expected ReDroid device at 127.0.0.1:5555 but not found. Start ReDroid first: bash scripts/start-redroid.sh"
  fi

  printf '\nReDroid device found at 127.0.0.1:5555\n'
fi

exit 0
