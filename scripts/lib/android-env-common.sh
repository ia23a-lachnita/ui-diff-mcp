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
: "${UI_DIFF_REDROID_DATA_DIR:=${XDG_STATE_HOME:-$HOME/.local/state}/ui-diff-mcp/redroid-data}"
export UI_DIFF_REDROID_DATA_DIR

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

# --- ReDroid lifecycle shared helpers (Task 4) -----------------------

# UI_DIFF_DEV_ROOT / UI_DIFF_SYS_ROOT let contract tests point binder
# device/sysfs discovery at a fake filesystem tree instead of the real
# /dev and /sys. Production callers must never set these; they default
# to the real filesystem roots.
: "${UI_DIFF_DEV_ROOT:=/dev}"
: "${UI_DIFF_SYS_ROOT:=/sys}"
export UI_DIFF_DEV_ROOT UI_DIFF_SYS_ROOT

UI_DIFF_BINDER_DEVICE_NAMES=(binder hwbinder vndbinder)

# --- require_arm64_host -------------------------------------------------
# The pinned ReDroid image is ARM64-only. Keep this check before any launch
# work while allowing Docker's own preflight to produce its useful message.
require_arm64_host() {
  local machine
  machine="$(uname -m 2>/dev/null)" || fail "Unable to determine the host architecture with 'uname -m'."
  case "$machine" in
    aarch64|arm64) ;;
    *) fail "Unsupported host architecture '$machine'. ReDroid requires an ARM64 host (aarch64 or arm64); refusing to launch." ;;
  esac
}

# --- check_binder_kernel_config -----------------------------------------
# Validate the kernel configuration before attempting binder node creation
# or container launch. UI_DIFF_KERNEL_CONFIG is intentionally an escape hatch
# for test/diagnostic fixtures; production defaults to the running kernel's
# conventional config file.
check_binder_kernel_config() {
  local config_path="${UI_DIFF_KERNEL_CONFIG:-/boot/config-$(uname -r)}"
  [ -r "$config_path" ] || fail "Kernel config '$config_path' is missing or unreadable. Set UI_DIFF_KERNEL_CONFIG to a readable config file, or enable the running kernel config at /boot/config-$(uname -r), then retry."

  if ! grep -Eq '^CONFIG_ANDROID_BINDER_IPC=y$' "$config_path"; then
    fail "Kernel config '$config_path' must enable CONFIG_ANDROID_BINDER_IPC=y. Enable Android binder IPC in the kernel and retry."
  fi

  local devices_line devices
  devices_line="$(grep -E '^CONFIG_ANDROID_BINDER_DEVICES=' "$config_path" | tail -n 1 || true)"
  devices="$(printf '%s' "${devices_line#*=}" | tr -d '[:space:]\042')"
  case ",$devices," in
    *,binder,*) ;;
    *) fail "Kernel config '$config_path' must set CONFIG_ANDROID_BINDER_DEVICES to include binder, hwbinder, and vndbinder; binder is missing." ;;
  esac
  case ",$devices," in
    *,hwbinder,*) ;;
    *) fail "Kernel config '$config_path' must set CONFIG_ANDROID_BINDER_DEVICES to include binder, hwbinder, and vndbinder; hwbinder is missing." ;;
  esac
  case ",$devices," in
    *,vndbinder,*) ;;
    *) fail "Kernel config '$config_path' must set CONFIG_ANDROID_BINDER_DEVICES to include binder, hwbinder, and vndbinder; vndbinder is missing." ;;
  esac
}

# --- require_docker ----------------------------------------------------
# Fatal check that the docker CLI is present and the daemon is reachable.
# Fails closed with remediation when docker is absent or `docker info`
# fails (permission denied, daemon not running, etc).
require_docker() {
  require_cmd docker
  if ! docker info >/dev/null 2>&1; then
    fail "Docker is installed but not usable (daemon unreachable or permission denied running 'docker info'). Ensure the Docker service is running and this user is in the docker group (or has sudo access), then retry."
  fi
}

# --- docker_container_state --------------------------------------------
# Prints "absent", "running", or "stopped" for the named container.
docker_container_state() {
  local name="$1" out
  if ! out=$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null); then
    printf 'absent'
    return 0
  fi
  case "$out" in
    true) printf 'running' ;;
    *) printf 'stopped' ;;
  esac
}

# --- resolve_privileged_prefix ------------------------------------------
# Determines whether privileged commands can run without an interactive
# prompt. Sets PRIVILEGED_CMD_PREFIX to "" (already root) or "sudo"
# (noninteractive sudo access confirmed) and returns 0, or leaves
# PRIVILEGED_CMD_PREFIX unset and returns 1 when neither is available.
resolve_privileged_prefix() {
  PRIVILEGED_CMD_PREFIX=""
  if [ "$(id -u)" -eq 0 ]; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    PRIVILEGED_CMD_PREFIX="sudo"
    return 0
  fi
  unset PRIVILEGED_CMD_PREFIX
  return 1
}

# --- read_binder_major_minor --------------------------------------------
# Reads and strictly validates the kernel-reported "major:minor" pair for
# a binder misc device from ${UI_DIFF_SYS_ROOT}/class/misc/<name>/dev.
# Prints the exact validated "major:minor" string and returns 0, or
# returns 1 with no output when the sysfs registration is absent,
# unreadable, or does not match exactly one "<digits>:<digits>" pair.
# Never guesses a value.
read_binder_major_minor() {
  local name="$1"
  local sysfs_path="${UI_DIFF_SYS_ROOT}/class/misc/${name}/dev"
  [ -f "$sysfs_path" ] || return 1
  local content
  content="$(cat "$sysfs_path" 2>/dev/null)" || return 1
  content="$(printf '%s' "$content" | tr -d '[:space:]')"
  if [[ ! "$content" =~ ^[0-9]+:[0-9]+$ ]]; then
    return 1
  fi

  printf '%s' "$content"
  return 0
}

# --- ensure_binder_device ------------------------------------------------
# Fatal: ensures a character device node exists at
# ${UI_DIFF_DEV_ROOT}/<name>. If a character device is already present,
# returns immediately. Otherwise, reads the exact major:minor pair from
# the kernel sysfs registration (never guessed) and creates the node with
# mknod, running as root directly or via noninteractive sudo. Fails
# closed with exact remediation when the sysfs registration is absent or
# malformed, or when no privilege is available to create the node. A
# non-device path already existing at the target (e.g. a binderfs mount
# directory) is never mistaken for a usable device node.
ensure_binder_device() {
  local name="$1"
  local devpath="${UI_DIFF_DEV_ROOT}/${name}"

  if [ -c "$devpath" ]; then
    return 0
  fi

  if [ -e "$devpath" ] || [ -L "$devpath" ]; then
    fail "Binder device path '$devpath' exists but is not a character device. Refusing to treat a binderfs directory, file, or symlink as a device node. Remove or repair the occupied path as root, then retry."
  fi

  local majmin
  if ! majmin="$(read_binder_major_minor "$name")"; then
    fail "Binder device '$devpath' is missing and no valid kernel sysfs major:minor registration was found at ${UI_DIFF_SYS_ROOT}/class/misc/${name}/dev (absent or malformed). Ensure CONFIG_ANDROID_BINDER_DEVICES includes '$name' and the kernel binder module/registration is active, then retry. Never guessing a major:minor value."
  fi

  local major="${majmin%%:*}" minor="${majmin#*:}"

  if ! resolve_privileged_prefix; then
    fail "No privilege to create device node '$devpath' (major:minor $major:$minor). Run as root, or grant this user noninteractive sudo access, then retry."
  fi

  if [ -n "$PRIVILEGED_CMD_PREFIX" ]; then
    "$PRIVILEGED_CMD_PREFIX" mknod "$devpath" c "$major" "$minor"
  else
    mknod "$devpath" c "$major" "$minor"
  fi

  if [ ! -c "$devpath" ]; then
    fail "Creating binder device '$devpath' did not produce a character device. Refusing to start ReDroid with an invalid binder mapping."
  fi
}

# --- validate_safe_data_dir ------------------------------------------
# Fatal: guards against wiping an unintended directory. Rejects empty,
# root ("/"), relative, non-canonical, symlinked, or overly shallow paths,
# and requires the exact
# basename "redroid-data" as a defense-in-depth check that the resolved
# path really is the ReDroid persistent-data directory before any caller
# is permitted to `rm -rf` it.
validate_safe_data_dir() {
  local dir="$1"

  [ -n "$dir" ] || fail "Data directory path is empty; refusing to wipe."
  [ "$dir" = "/" ] && fail "Refusing to wipe root directory '/'."

  case "$dir" in
    /*) ;;
    *) fail "Data directory path '$dir' must be absolute; refusing to wipe." ;;
  esac

  case "$dir" in
    */|*//*|*/./*|*/.|*/..|*/../*|../*) fail "Data directory path '$dir' is not canonical; refusing to wipe." ;;
  esac

  local depth
  depth=$(printf '%s' "$dir" | tr -cd '/' | wc -c)
  if [ "$depth" -lt 3 ]; then
    fail "Data directory path '$dir' is too shallow to safely wipe (expected a nested state directory)."
  fi

  local base
  base="$(basename "$dir")"
  if [ "$base" != "redroid-data" ]; then
    fail "Data directory basename must be 'redroid-data' as a safety guard; got '$base'. Refusing to wipe."
  fi

  local remaining="${dir#/}" current="" component
  while [ -n "$remaining" ]; do
    component="${remaining%%/*}"
    current="${current}/${component}"
    if [ -L "$current" ]; then
      fail "Data directory path '$dir' traverses symlink '$current'; refusing to wipe."
    fi
    case "$remaining" in
      */*) remaining="${remaining#*/}" ;;
      *) break ;;
    esac
  done
}
