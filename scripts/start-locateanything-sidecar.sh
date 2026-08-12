#!/usr/bin/env bash
# Start the LocateAnything sidecar on loopback only.
#
# Public startup-readiness overrides (optional):
#   LOCATEANYTHING_STARTUP_TIMEOUT_MS  (architecture default: 600000 on
#     aarch64/ARM64, 120000 on all other supported arches; max 600000)
#   LOCATEANYTHING_STARTUP_POLL_MS     (default 500, max 10000)
# These control only how long the launcher waits for /health to report
# ready; they are unrelated to LOCATEANYTHING_TIMEOUT_MS, which is the
# separate Node-side inference-request timeout consumed by the MCP client.
# Measured Pi ARM64 Q4 cold start is ~473s, so a 120s default would kill a
# healthy ARM load. Architecture defaults use resolve_arch (not raw uname).
#
# Internal test hooks, never required in production:
#   UI_DIFF_LOCATEANYTHING_KNOWN_PYTHON_INTERNAL
#   UI_DIFF_LOCATEANYTHING_EAGLE_DIR_INTERNAL
#   UI_DIFF_LOCATEANYTHING_PORT_INTERNAL
#   UI_DIFF_LOCATEANYTHING_LOG_DIR_INTERNAL
#   UI_DIFF_LOCATEANYTHING_METRICS_DIR_INTERNAL
#   UI_DIFF_LOCATEANYTHING_TIMEOUT_MS          (takes precedence over LOCATEANYTHING_STARTUP_TIMEOUT_MS)
#   UI_DIFF_LOCATEANYTHING_POLL_MS             (takes precedence over LOCATEANYTHING_STARTUP_POLL_MS)
#   UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL
#   UI_DIFF_LOCATEANYTHING_MEMINFO_INTERNAL
#   UI_DIFF_LOCATEANYTHING_MUTATE_MEMINFO_INTERNAL
#   UI_DIFF_LOCATEANYTHING_PROC_STATUS_FILE_INTERNAL
#   UI_DIFF_LOCATEANYTHING_REDROID_NAME_INTERNAL
#   UI_DIFF_LOCATEANYTHING_COLOCATION_EVIDENCE_INTERNAL
#   UI_DIFF_LOCATEANYTHING_CPP_CHECKOUT_INTERNAL
#   UI_DIFF_LOCATEANYTHING_CPP_LIBRARY_INTERNAL
#   UI_DIFF_LOCATEANYTHING_CPP_MODEL_INTERNAL
#   UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST="127.0.0.1"
DEFAULT_PORT="39731"
# Architecture-aware startup-readiness defaults (resolved after resolve_arch is
# defined, before validate_settings). ARM64/Pi Q4 cold start measured ~473s.
DEFAULT_TIMEOUT_MS_ARM="600000"
DEFAULT_TIMEOUT_MS_NON_ARM="120000"
DEFAULT_POLL_MS="500"
KNOWN_PYTHON="${UI_DIFF_LOCATEANYTHING_KNOWN_PYTHON_INTERNAL:-/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin/python}"
DEFAULT_EAGLE_DIR="${UI_DIFF_LOCATEANYTHING_EAGLE_DIR_INTERNAL:-/home/agent-runner/projects/Eagle/Embodied}"
LOG_DIR="${UI_DIFF_LOCATEANYTHING_LOG_DIR_INTERNAL:-${XDG_STATE_HOME:-$HOME/.local/state}/ui-diff-mcp}"
PORT="${UI_DIFF_LOCATEANYTHING_PORT_INTERNAL:-$DEFAULT_PORT}"
# TIMEOUT_MS is deferred until resolve_arch / default_startup_timeout_ms exist.
POLL_MS="${UI_DIFF_LOCATEANYTHING_POLL_MS:-${LOCATEANYTHING_STARTUP_POLL_MS:-$DEFAULT_POLL_MS}}"
CHECK_ONLY=0
HELP=0

# Stage4 constants and defaults
STAGE4_METRICS_DIR="${UI_DIFF_LOCATEANYTHING_METRICS_DIR_INTERNAL:-${XDG_STATE_HOME:-$HOME/.local/state}/ui-diff-mcp/metrics}"
STAGE4_ENGINE_COMMIT="77376ab332de918220f7a7e391542eefb5407c9f"
STAGE4_MODEL_SHA="894088a00a2cd2bbb7f34b12893988dd0376c8ed92213a9f2cf6420f1e3901da"
STAGE4_ABI=1
STAGE4_REQUIRED_MEM_AVAIL_KB=5322268

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: bash scripts/start-locateanything-sidecar.sh [--check-only|--help]

Starts the LocateAnything sidecar only on 127.0.0.1:39731. --check-only
validates the interpreter and Eagle Embodied checkout without a network call
or process start.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --help)
      [ "$HELP" -eq 0 ] && [ "$CHECK_ONLY" -eq 0 ] || fail "Only one option may be supplied."
      HELP=1
      ;;
    --check-only)
      [ "$CHECK_ONLY" -eq 0 ] && [ "$HELP" -eq 0 ] || fail "Only one option may be supplied."
      CHECK_ONLY=1
      ;;
    *) fail "Unknown option '$1'. Use --help for usage." ;;
  esac
  shift
done

[ "$HELP" -eq 0 ] || { usage; exit 0; }

is_positive_bounded_int() {
  local value="$1" maximum="$2"
  [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le "$maximum" ]
}

is_python_usable() {
  local candidate="$1" version=""
  [ -x "$candidate" ] || return 1
  version="$("$candidate" --version 2>&1)" || return 1
  [[ "$version" =~ ^Python[[:space:]][0-9]+\.[0-9]+ ]]
}

resolve_python() {
  if [ -n "${LOCATEANYTHING_PYTHON:-}" ]; then
    if ! is_python_usable "$LOCATEANYTHING_PYTHON"; then
      fail "LOCATEANYTHING_PYTHON is set to '$LOCATEANYTHING_PYTHON' but is not an executable usable Python interpreter. Fix or unset LOCATEANYTHING_PYTHON; no fallback is used for an explicit override."
    fi
    PYTHON_BIN="$LOCATEANYTHING_PYTHON"
  elif is_python_usable "$KNOWN_PYTHON"; then
    PYTHON_BIN="$KNOWN_PYTHON"
  else
    local system_python=""
    system_python="$(command -v python3 2>/dev/null || true)"
    if ! is_python_usable "$system_python"; then
      fail "No usable Python interpreter found. Set LOCATEANYTHING_PYTHON, create '$KNOWN_PYTHON', or install python3."
    fi
    PYTHON_BIN="$system_python"
  fi
  export LOCATEANYTHING_PYTHON="$PYTHON_BIN"
}

preflight_python_launch_surface() {
  local backend="${1:-official}" detail="" error_line=""
  if [ "$backend" = "official" ]; then
    if ! detail="$(cd "$REPO_ROOT" && "$PYTHON_BIN" -c 'import uvicorn; import sidecars.locateanything.server' 2>&1)"; then
      error_line="${detail##*$'\n'}"
      fail "Selected Python interpreter '$PYTHON_BIN' cannot import uvicorn and sidecars.locateanything.server from '$REPO_ROOT'. Install the required packages with: '$PYTHON_BIN' -m pip install -r '$REPO_ROOT/sidecars/locateanything/requirements.txt'. Import error: ${error_line:-unknown import failure}"
    fi
  else
    if ! detail="$(cd "$REPO_ROOT" && "$PYTHON_BIN" -c 'import uvicorn; import fastapi; from PIL import Image; import sidecars.locateanything.server; import sidecars.locateanything.cpp_worker' 2>&1)"; then
      error_line="${detail##*$'\n'}"
      fail "C++ sidecar modules: '$PYTHON_BIN' cannot import required packages from '$REPO_ROOT' (uvicorn, fastapi, PIL, sidecars.locateanything.server, sidecars.locateanything.cpp_worker). Ensure locate-anything.cpp ABI $STAGE4_ABI is installed and compatible. No Eagle or Torch is required for the C++ backend. Import error: ${error_line:-unknown import failure}"
    fi
  fi
}

verify_cpp_abi() {
  local lib_path py_out actual
  lib_path="${1:-}"
  [ -n "$lib_path" ] || fail "verify_cpp_abi requires a library path argument."
  [ -f "$lib_path" ] || fail "C++ shared library '$lib_path' does not exist; cannot verify ABI."
  py_out="$("$PYTHON_BIN" -c "import ctypes,sys; lib=ctypes.CDLL(sys.argv[1]); lib.la_capi_abi_version.argtypes=[]; lib.la_capi_abi_version.restype=ctypes.c_int; print(lib.la_capi_abi_version())" "$lib_path" 2>&1)" || fail "Failed to load or probe C++ library '$lib_path' via ctypes. Ensure the shared library is built and loadable. Error: ${py_out##*$'\n'}"
  actual="${py_out##*$'\n'}"
  actual="${actual##[[:space:]]}"
  actual="${actual%%[[:space:]]*}"
  [ "$actual" = "$STAGE4_ABI" ] || fail "C++ ABI mismatch: expected $STAGE4_ABI but library reports '$actual'. Rebuild locate-anything.cpp at pinned commit $STAGE4_ENGINE_COMMIT."
}

preflight_cpp_provenance() {
  local checkout_dir="${1:-}" lib_path="${2:-}" model_path="${3:-}" actual_commit="" actual_model="" lib_machine="" host_arch=""
  [ -n "$checkout_dir" ] || fail "preflight_cpp_provenance requires a checkout directory."
  actual_commit="$(git -C "$checkout_dir" rev-parse HEAD 2>/dev/null)" || fail "Could not read git HEAD from '$checkout_dir'."
  [ "$actual_commit" = "$STAGE4_ENGINE_COMMIT" ] || fail "C++ engine commit mismatch: expected $STAGE4_ENGINE_COMMIT but HEAD is '$actual_commit'. Check out the pinned commit and rebuild."
  [ -n "$model_path" ] || fail "preflight_cpp_provenance requires a model path."
  [ -f "$model_path" ] || fail "C++ model '$model_path' does not exist."
  actual_model="$(sha256sum "$model_path" | cut -d' ' -f1)" || fail "Could not compute sha256sum of '$model_path'."
  [ "$actual_model" = "$STAGE4_MODEL_SHA" ] || fail "C++ model hash mismatch: expected $STAGE4_MODEL_SHA but got '$actual_model' for '$model_path'. Re-download the GGUF Q4_K model."
  [ -n "$lib_path" ] || fail "preflight_cpp_provenance requires a library path."
  host_arch="$(resolve_arch)"
  lib_machine="$(detect_cpp_library_machine "$lib_path")"
  [ "$lib_machine" = "$host_arch" ] || fail "C++ library architecture mismatch: host is '$host_arch' but library is '$lib_machine'. Rebuild locate-anything.cpp for the correct target."
}

preflight_cpp_memory() {
  local meminfo_path="${UI_DIFF_LOCATEANYTHING_MEMINFO_INTERNAL:-/proc/meminfo}" avail_kb=""
  if [ -f "$meminfo_path" ]; then
    avail_kb="$(awk '/^MemAvailable:/{print $2; exit}' "$meminfo_path" 2>/dev/null || true)"
  fi
  if [ -z "$avail_kb" ] || ! [[ "$avail_kb" =~ ^[0-9]+$ ]]; then
    fail "memory: could not parse MemAvailable from '$meminfo_path'. Ensure the file exists and contains a MemAvailable line."
  fi
  [ "$avail_kb" -ge "$STAGE4_REQUIRED_MEM_AVAIL_KB" ] || fail "Insufficient memory: ${avail_kb}kB available, ${STAGE4_REQUIRED_MEM_AVAIL_KB}kB required. Free memory or increase the threshold."
  printf 'Memory preflight passed: %s kB available, %s kB required.\n' "$avail_kb" "$STAGE4_REQUIRED_MEM_AVAIL_KB"
}

has_eagle_marker() {
  local directory="$1"
  [ -d "$directory" ] && { [ -f "$directory/locateanything_worker/__init__.py" ] || [ -f "$directory/locateanything_worker.py" ]; }
}

resolve_eagle_dir() {
  if [ -n "${LOCATEANYTHING_EAGLE_EMBODIED_DIR:-}" ]; then
    if ! has_eagle_marker "$LOCATEANYTHING_EAGLE_EMBODIED_DIR"; then
      fail "LOCATEANYTHING_EAGLE_EMBODIED_DIR='$LOCATEANYTHING_EAGLE_EMBODIED_DIR' is invalid. It must contain locateanything_worker/__init__.py or locateanything_worker.py. Fix or unset the explicit override; no fallback is used."
    fi
    EAGLE_DIR="$LOCATEANYTHING_EAGLE_EMBODIED_DIR"
  elif has_eagle_marker "$DEFAULT_EAGLE_DIR"; then
    EAGLE_DIR="$DEFAULT_EAGLE_DIR"
  else
    fail "No valid Eagle Embodied checkout found at '$DEFAULT_EAGLE_DIR'. Clone/install Eagle Embodied so it contains locateanything_worker, or set LOCATEANYTHING_EAGLE_EMBODIED_DIR to that checkout."
  fi
  export LOCATEANYTHING_EAGLE_EMBODIED_DIR="$EAGLE_DIR"
}

validate_settings() {
  is_positive_bounded_int "$PORT" 65535 || fail "LocateAnything port must be an integer from 1 through 65535; got '$PORT'."
  is_positive_bounded_int "$TIMEOUT_MS" 600000 || fail "LOCATEANYTHING_STARTUP_TIMEOUT_MS must be an integer from 1 through 600000 milliseconds; got '$TIMEOUT_MS'."
  is_positive_bounded_int "$POLL_MS" 10000 || fail "LOCATEANYTHING_STARTUP_POLL_MS must be an integer from 1 through 10000 milliseconds; got '$POLL_MS'."
  [ "$POLL_MS" -le "$TIMEOUT_MS" ] || fail "LOCATEANYTHING_STARTUP_POLL_MS must not exceed LOCATEANYTHING_STARTUP_TIMEOUT_MS."
}

require_health_dependencies() {
  command -v curl >/dev/null 2>&1 || fail "curl is required for the sidecar health check. Install curl and retry."
  command -v node >/dev/null 2>&1 || fail "node is required to validate sidecar health JSON. Install Node.js and retry."
  node --version >/dev/null 2>&1 || fail "node is present but not usable for sidecar health JSON validation. Repair Node.js and retry."
}

require_startup_dependencies() {
  command -v nohup >/dev/null 2>&1 || fail "nohup is required to detach the sidecar process. Install coreutils and retry."
}

health_status() {
  local body parsed url="http://${HOST}:${PORT}/health"
  body="$(curl --silent --show-error --fail --max-time 2 "$url" 2>/dev/null || true)"
  [ -n "$body" ] || { printf 'unready'; return 0; }
  parsed="$(printf '%s' "$body" | node -e '
let raw="";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return process.stdout.write("unready");
    if (typeof value.error === "string" && value.error.trim()) return process.stdout.write("error:" + value.error.trim());
    process.stdout.write(value.ready === true ? "ready" : "unready");
  } catch { process.stdout.write("unready"); }
});
' 2>/dev/null || true)"
  case "$parsed" in
    ready|unready|error:*) printf '%s' "$parsed" ;;
    *) printf 'unready' ;;
  esac
}

sleep_for_poll() {
  local whole=$((POLL_MS / 1000)) fraction=$((POLL_MS % 1000))
  sleep "$(printf '%d.%03d' "$whole" "$fraction")"
}

cleanup_child() {
  local child="$1"
  if kill -0 "$child" 2>/dev/null; then
    kill "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
}

resolve_arch() {
  if [ -n "${UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL:-}" ]; then
    printf '%s' "$UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL"
    return 0
  fi
  local raw
  raw="$(uname -m)"
  case "$raw" in
    aarch64|arm64) printf 'aarch64' ;;
    x86_64|amd64)  printf 'x86_64' ;;
    *) fail "Unrecognised host architecture '$raw'. Set UI_DIFF_LOCATEANYTHING_MACHINE_INTERNAL to override." ;;
  esac
}

# Architecture-aware startup-readiness default. Uses resolve_arch so ARM aliases
# (aarch64/arm64) share one branch; public/internal env overrides are applied
# by the caller after this returns.
default_startup_timeout_ms() {
  local arch
  arch="$(resolve_arch)"
  case "$arch" in
    aarch64) printf '%s' "$DEFAULT_TIMEOUT_MS_ARM" ;;
    *)       printf '%s' "$DEFAULT_TIMEOUT_MS_NON_ARM" ;;
  esac
}

resolve_backend() {
  local arch="$1" backend="${LOCATEANYTHING_BACKEND:-}"
  case "$backend" in
    cpp|official) ;;
    "") case "$arch" in
          aarch64) backend="cpp" ;;
          *)       backend="official" ;;
        esac ;;
    *) fail "LOCATEANYTHING_BACKEND='$backend' is invalid. Accepted values: cpp, official." ;;
  esac
  printf '%s' "$backend"
}

resolve_cpp_paths() {
  local checkout_dir
  if [ -n "${UI_DIFF_LOCATEANYTHING_CPP_CHECKOUT_INTERNAL:-}" ]; then
    checkout_dir="$UI_DIFF_LOCATEANYTHING_CPP_CHECKOUT_INTERNAL"
  elif [ -n "${LOCATEANYTHING_CPP_CHECKOUT_DIR:-}" ]; then
    checkout_dir="$LOCATEANYTHING_CPP_CHECKOUT_DIR"
  else
    checkout_dir="/home/agent-runner/projects/locate-anything.cpp"
  fi
  [ -d "$checkout_dir" ] || fail "locate-anything.cpp checkout directory '$checkout_dir' does not exist. Clone or set LOCATEANYTHING_CPP_CHECKOUT_DIR."

  local lib_path
  if [ -n "${UI_DIFF_LOCATEANYTHING_CPP_LIBRARY_INTERNAL:-}" ]; then
    lib_path="$UI_DIFF_LOCATEANYTHING_CPP_LIBRARY_INTERNAL"
  elif [ -n "${LOCATEANYTHING_CPP_LIBRARY_PATH:-}" ]; then
    lib_path="$LOCATEANYTHING_CPP_LIBRARY_PATH"
  else
    lib_path="$checkout_dir/build-shared/liblocate_anything.so"
  fi
  [ -f "$lib_path" ] || fail "C++ shared library '$lib_path' not found. Build locate-anything.cpp with cmake at pinned commit $STAGE4_ENGINE_COMMIT or set LOCATEANYTHING_CPP_LIBRARY_PATH."

  local model_path
  if [ -n "${UI_DIFF_LOCATEANYTHING_CPP_MODEL_INTERNAL:-}" ]; then
    model_path="$UI_DIFF_LOCATEANYTHING_CPP_MODEL_INTERNAL"
  elif [ -n "${LOCATEANYTHING_CPP_MODEL_PATH:-}" ]; then
    model_path="$LOCATEANYTHING_CPP_MODEL_PATH"
  else
    model_path="$checkout_dir/models/locate-anything-q4_k.gguf"
  fi
  [ -f "$model_path" ] || fail "C++ model file '$model_path' not found. Download the GGUF Q4_K model or set LOCATEANYTHING_CPP_MODEL_PATH."

  CPP_CHECKOUT_DIR="$checkout_dir"
  CPP_LIB_PATH="$lib_path"
  CPP_MODEL_PATH="$model_path"
}

detect_cpp_library_machine() {
  local lib_path="${1:-}"
  [ -n "$lib_path" ] || fail "detect_cpp_library_machine requires a library path argument."
  [ -f "$lib_path" ] || fail "detect_cpp_library_machine: library '$lib_path' does not exist."

  if [ -n "${UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL:-}" ]; then
    normalize_machine "$UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL"
    return 0
  fi

  local line
  if command -v readelf >/dev/null 2>&1; then
    line="$(readelf -h "$lib_path" 2>/dev/null | grep -i 'Machine' | head -1 || true)"
    if [ -n "$line" ]; then
      local machine="${line##*:}"
      machine="$(printf '%s' "$machine" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')"
      if [ -n "$machine" ]; then
        normalize_machine "$machine"
        return 0
      fi
    fi
  fi

  if command -v file >/dev/null 2>&1; then
    line="$(file "$lib_path" 2>/dev/null || true)"
    if printf '%s' "$line" | grep -qi 'aarch64\|arm64'; then
      normalize_machine "aarch64"
      return 0
    elif printf '%s' "$line" | grep -qi 'x86-64\|x86_64'; then
      normalize_machine "x86_64"
      return 0
    fi
  fi

  fail "architecture unknown: could not detect machine architecture of '$lib_path'. readelf is not available and file(1) did not recognise the binary. Install binutils or set UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL."
}

normalize_machine() {
  local raw="${1:-}"
  [ -n "$raw" ] || fail "normalize_machine received empty input."
  case "$raw" in
    aarch64|AArch64|ARM64) printf 'aarch64' ;;
    x86-64|x86_64|amd64|"Advanced Micro Devices X86-64") printf 'x86_64' ;;
    *) fail "Unrecognised machine '$raw'. Accepted values: aarch64, x86-64, x86_64, amd64, ARM64, AArch64. Set UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL to override." ;;
  esac
}

detect_running_container() {
  local name="${1:-ui-diff-redroid}" out
  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi
  out="$(docker inspect --format='{{.State.Running}}' "$name" 2>/dev/null || true)"
  [ "$out" = "true" ]
}

validate_colocation_evidence() {
  local file="${1:-}" line="" key="" value="" seen_schema="" seen_commit="" seen_model=""
  local seen_abi="" seen_quant="" seen_machine="" seen_peak="" seen_swap="" seen_status=""
  local val_schema="" val_commit="" val_model="" val_abi="" val_quant="" val_machine=""
  local val_peak="" val_swap="" val_status=""
  [ -n "$file" ] || fail "co-location evidence: file path is empty."
  [ -f "$file" ] || fail "co-location evidence: file '$file' does not exist."

  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    # Reject lines containing shell metacharacters.
    case "$line" in
      *'$('*|*'`'*|*';'*|*'|'*|*'&'*|*'>'*|*'<'*)
        fail "co-location evidence: line contains shell metacharacters: '$line'. Reject and never evaluate." ;;
    esac
    if printf '%s' "$line" | grep -q "[\"']" 2>/dev/null; then
      fail "co-location evidence: line contains shell metacharacters: '$line'. Reject and never evaluate."
    fi
    case "$line" in
      *=*) ;;
      *) fail "co-location evidence: malformed line (expected key=value): '$line'." ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    # Reject unknown keys.
    case "$key" in
      schema_version|engine_commit|model_sha256|abi_version|quantization|host_machine|concurrent_peak_rss_kib|concurrent_swap_delta_kib|status) ;;
      *) fail "co-location evidence: unknown key '$key' in '$file'." ;;
    esac
    # Reject duplicate keys and capture first value.
    case "$key" in
      schema_version)
        [ -z "$seen_schema" ] || fail "co-location evidence: duplicate key 'schema_version' in '$file'."
        seen_schema=1; val_schema="$value" ;;
      engine_commit)
        [ -z "$seen_commit" ] || fail "co-location evidence: duplicate key 'engine_commit' in '$file'."
        seen_commit=1; val_commit="$value" ;;
      model_sha256)
        [ -z "$seen_model" ] || fail "co-location evidence: duplicate key 'model_sha256' in '$file'."
        seen_model=1; val_model="$value" ;;
      abi_version)
        [ -z "$seen_abi" ] || fail "co-location evidence: duplicate key 'abi_version' in '$file'."
        seen_abi=1; val_abi="$value" ;;
      quantization)
        [ -z "$seen_quant" ] || fail "co-location evidence: duplicate key 'quantization' in '$file'."
        seen_quant=1; val_quant="$value" ;;
      host_machine)
        [ -z "$seen_machine" ] || fail "co-location evidence: duplicate key 'host_machine' in '$file'."
        seen_machine=1; val_machine="$value" ;;
      concurrent_peak_rss_kib)
        [ -z "$seen_peak" ] || fail "co-location evidence: duplicate key 'concurrent_peak_rss_kib' in '$file'."
        seen_peak=1; val_peak="$value" ;;
      concurrent_swap_delta_kib)
        [ -z "$seen_swap" ] || fail "co-location evidence: duplicate key 'concurrent_swap_delta_kib' in '$file'."
        seen_swap=1; val_swap="$value" ;;
      status)
        [ -z "$seen_status" ] || fail "co-location evidence: duplicate key 'status' in '$file'."
        seen_status=1; val_status="$value" ;;
    esac
  done < "$file"

  # Require all nine fields.
  for pair in "schema_version:$seen_schema" "engine_commit:$seen_commit" "model_sha256:$seen_model" "abi_version:$seen_abi" "quantization:$seen_quant" "host_machine:$seen_machine" "concurrent_peak_rss_kib:$seen_peak" "concurrent_swap_delta_kib:$seen_swap" "status:$seen_status"; do
    local fname="${pair%%:*}" fval="${pair#*:}"
    [ -n "$fval" ] || fail "co-location evidence: missing required key '$fname' in '$file'."
  done

  # Validate captured field values.
  [ "$val_schema" = "1" ] || fail "co-location evidence: schema_version must be 1, got '$val_schema'."
  [ "$val_commit" = "$STAGE4_ENGINE_COMMIT" ] || fail "co-location evidence: engine_commit must be '$STAGE4_ENGINE_COMMIT', got '$val_commit'."
  [ "$val_model" = "$STAGE4_MODEL_SHA" ] || fail "co-location evidence: model_sha256 must be '$STAGE4_MODEL_SHA', got '$val_model'."
  [ "$val_abi" = "1" ] || fail "co-location evidence: abi_version must be 1, got '$val_abi'."
  [ "$val_quant" = "Q4_K" ] || fail "co-location evidence: quantization must be Q4_K, got '$val_quant'."

  local host_arch
  host_arch="$(resolve_arch)"
  [ "$val_machine" = "$host_arch" ] || fail "co-location evidence: host_machine must be '$host_arch', got '$val_machine'."

  [ -n "$val_peak" ] && [[ "$val_peak" =~ ^[0-9]+$ ]] && [ "$val_peak" -ge 1 ] || fail "co-location evidence: concurrent_peak_rss_kib must be a positive integer, got '$val_peak'."
  [ "$val_swap" = "0" ] || fail "co-location evidence: concurrent_swap_delta_kib must be 0, got '$val_swap'."
  [ "$val_status" = "pass" ] || fail "co-location evidence: status must be pass, got '$val_status'."
}

check_redroid_colocation() {
  local redroid_name="${UI_DIFF_LOCATEANYTHING_REDROID_NAME_INTERNAL:-ui-diff-redroid}"
  if ! detect_running_container "$redroid_name"; then
    return 0
  fi
  # Container is running; require evidence.
  local evidence_file="${UI_DIFF_LOCATEANYTHING_COLOCATION_EVIDENCE_INTERNAL:-${LOCATEANYTHING_COLOCATION_EVIDENCE:-}}"
  if [ -z "$evidence_file" ] || [ ! -f "$evidence_file" ]; then
    fail "co-location evidence: ReDroid container '$redroid_name' is running but no co-location evidence file was provided. Set UI_DIFF_LOCATEANYTHING_COLOCATION_EVIDENCE_INTERNAL or provide evidence via LOCATEANYTHING_COLOCATION_EVIDENCE."
  fi
  validate_colocation_evidence "$evidence_file"
}

read_swap_free_kb() {
  local meminfo_path="${1:-/proc/meminfo}" line=""
  if [ ! -f "$meminfo_path" ]; then
    return 1
  fi
  line="$(awk '/^SwapFree:/{print $2; exit}' "$meminfo_path" 2>/dev/null || true)"
  if [ -n "$line" ] && [[ "$line" =~ ^[0-9]+$ ]]; then
    printf '%s' "$line"
    return 0
  fi
  return 1
}

read_child_proc_metrics() {
  local proc_file="${1:-}"
  [ -n "$proc_file" ] || return 1
  [ -f "$proc_file" ] || return 1
  awk '
    /^VmRSS:/ { if ($2 ~ /^[0-9]+$/) { rss=$2 } }
    /^VmHWM:/ { if ($2 ~ /^[0-9]+$/) { hwm=$2 } }
    /^VmSwap:/ { if ($2 ~ /^[0-9]+$/) { swap=$2 } }
    END {
      if (rss == "" || hwm == "" || swap == "") exit 1
      print rss
      print hwm
      print swap
    }
  ' "$proc_file" || return 1
}

write_metrics_file() {
  local metrics_dir="${1:-}" backend="${2:-}" engine_commit="${3:-}" model_sha256="${4:-}"
  local abi_version="${5:-}" quantization="${6:-}" host_machine="${7:-}"
  local baseline_swap_kb="${8:-}" post_swap_kb="${9:-}" child_rss="${10:-}"
  local child_hwm="${11:-}" child_swap="${12:-}"
  local swap_delta="" peak_rss="" status="pass"

  # Never call fail() here: fail() exits the whole shell, which would skip the
  # caller's child cleanup and its diagnostic. Return nonzero instead and let
  # the caller clean up and report.
  [ -n "$metrics_dir" ] || return 1
  mkdir -p "$metrics_dir" 2>/dev/null || return 1

  # A SwapFree increase means swap was freed, not consumed; clamp to zero to
  # match the caller's system-swap-delta handling.
  swap_delta=$((baseline_swap_kb - post_swap_kb))
  [ "$swap_delta" -ge 0 ] || swap_delta=0
  peak_rss="${child_hwm}"

  # Determine status from constraints.
  if [ "$swap_delta" -gt 0 ]; then
    status="fail"
  fi
  if [ -n "$child_swap" ] && [ "$child_swap" -gt 0 ]; then
    status="fail"
  fi

  local tmp_file metrics_file
  metrics_file="$metrics_dir/locateanything-startup.metrics"
  tmp_file="${metrics_file}.tmp.$$"

  if ! cat > "$tmp_file" 2>/dev/null <<METRICS
backend=${backend}
engine_commit=${engine_commit}
model_sha256=${model_sha256}
abi_version=${abi_version}
quantization=${quantization}
host_machine=${host_machine}
concurrent_peak_rss_kib=${peak_rss}
concurrent_swap_delta_kib=${swap_delta}
VmRSS=${child_rss}
VmHWM=${child_hwm}
VmSwap=${child_swap}
status=${status}
METRICS
  then
    rm -f "$tmp_file" 2>/dev/null || true
    return 1
  fi

  mv -f "$tmp_file" "$metrics_file" 2>/dev/null || { rm -f "$tmp_file" 2>/dev/null || true; return 1; }
  printf '%s' "$metrics_file"
}

# Resolve TIMEOUT_MS after functions exist so the architecture default can use
# resolve_arch. Precedence (highest first):
#   1. UI_DIFF_LOCATEANYTHING_TIMEOUT_MS (internal test hook)
#   2. LOCATEANYTHING_STARTUP_TIMEOUT_MS (public override)
#   3. architecture default from default_startup_timeout_ms
DEFAULT_TIMEOUT_MS="$(default_startup_timeout_ms)"
TIMEOUT_MS="${UI_DIFF_LOCATEANYTHING_TIMEOUT_MS:-${LOCATEANYTHING_STARTUP_TIMEOUT_MS:-$DEFAULT_TIMEOUT_MS}}"

validate_settings

if [ "$CHECK_ONLY" -eq 1 ]; then
  require_health_dependencies
  ARCH="$(resolve_arch)"
  BACKEND="$(resolve_backend "$ARCH")"
  resolve_python
  if [ "$BACKEND" = "cpp" ]; then
    preflight_python_launch_surface "$BACKEND"
    resolve_cpp_paths
    verify_cpp_abi "$CPP_LIB_PATH"
    preflight_cpp_provenance "$CPP_CHECKOUT_DIR" "$CPP_LIB_PATH" "$CPP_MODEL_PATH"
    preflight_cpp_memory
    check_redroid_colocation
  else
    preflight_python_launch_surface "$BACKEND"
    resolve_eagle_dir
  fi
  require_startup_dependencies
  if [ "$BACKEND" = "cpp" ]; then
    printf 'LocateAnything sidecar check passed: backend=cpp Python=%s host=%s port=%s library=%s model=%s startup_timeout_ms=%s\n' "$PYTHON_BIN" "$HOST" "$PORT" "$CPP_LIB_PATH" "$CPP_MODEL_PATH" "$TIMEOUT_MS"
  else
    printf 'LocateAnything sidecar check passed: backend=official Python=%s Eagle=%s host=%s port=%s startup_timeout_ms=%s\n' "$PYTHON_BIN" "$EAGLE_DIR" "$HOST" "$PORT" "$TIMEOUT_MS"
  fi
  exit 0
fi

require_health_dependencies
status="$(health_status)"
case "$status" in
  ready)
    printf 'LocateAnything sidecar already healthy at http://%s:%s/health; no process started.\n' "$HOST" "$PORT"
    exit 0
    ;;
  error:*) fail "Existing LocateAnything sidecar reported a load error: ${status#error:}. Stop or repair that process, inspect its log, then retry." ;;
esac

ARCH="$(resolve_arch)"
BACKEND="$(resolve_backend "$ARCH")"
printf 'Selected backend: backend=%s\n' "$BACKEND"

resolve_python

# Backend-specific preflights and setup.
if [ "$BACKEND" = "cpp" ]; then
  preflight_python_launch_surface "$BACKEND"
  resolve_cpp_paths
  verify_cpp_abi "$CPP_LIB_PATH"
  preflight_cpp_provenance "$CPP_CHECKOUT_DIR" "$CPP_LIB_PATH" "$CPP_MODEL_PATH"
  preflight_cpp_memory
  check_redroid_colocation
  require_startup_dependencies
  # Capture baseline swap for post-ready delta check.
  BASELINE_SWAP_KB=""
  BASELINE_MEMINFO_PATH="${UI_DIFF_LOCATEANYTHING_MEMINFO_INTERNAL:-/proc/meminfo}"
  BASELINE_SWAP_KB="$(read_swap_free_kb "$BASELINE_MEMINFO_PATH" 2>/dev/null || true)"
  [ -n "$BASELINE_SWAP_KB" ] || fail "baseline swap: could not read SwapFree from '$BASELINE_MEMINFO_PATH'."
else
  preflight_python_launch_surface "$BACKEND"
  resolve_eagle_dir
  require_startup_dependencies
  printf 'Backend preflight passed: backend=official Eagle=%s\n' "$EAGLE_DIR"
fi

: "${LOCATEANYTHING_IN_TOKEN_LIMIT:=4096}"
: "${LOCATEANYTHING_GENERATION_MODE:=hybrid}"
: "${LOCATEANYTHING_MAX_NEW_TOKENS:=512}"
export LOCATEANYTHING_IN_TOKEN_LIMIT LOCATEANYTHING_GENERATION_MODE LOCATEANYTHING_MAX_NEW_TOKENS

# Export backend and backend-specific env for the child.
export LOCATEANYTHING_BACKEND="$BACKEND"
if [ "$BACKEND" = "cpp" ]; then
  export LOCATEANYTHING_CPP_CHECKOUT_DIR="$CPP_CHECKOUT_DIR"
  export LOCATEANYTHING_CPP_LIBRARY_PATH="$CPP_LIB_PATH"
  export LOCATEANYTHING_CPP_MODEL_PATH="$CPP_MODEL_PATH"
fi

mkdir -p "$LOG_DIR" || fail "Cannot create sidecar log directory '$LOG_DIR'. Create it with writable permissions and retry."
LOG_FILE="$LOG_DIR/locateanything-sidecar-${PORT}.log"

(
  cd "$REPO_ROOT"
  exec nohup "$PYTHON_BIN" -m uvicorn sidecars.locateanything.server:app --host "$HOST" --port "$PORT" >>"$LOG_FILE" 2>&1
) &
CHILD_PID=$!

printf 'PID: %s\nLog: %s\n' "$CHILD_PID" "$LOG_FILE"
attempts=$((TIMEOUT_MS / POLL_MS + 1))
for ((attempt = 1; attempt <= attempts; attempt++)); do
  status="$(health_status)"
  case "$status" in
    ready)
      printf 'LocateAnything sidecar ready at http://%s:%s/health\n' "$HOST" "$PORT"
      break
      ;;
    error:*)
      cleanup_child "$CHILD_PID"
      fail "LocateAnything sidecar reported a load error: ${status#error:}. Inspect '$LOG_FILE', repair dependencies, then retry."
      ;;
  esac
  if [ "$attempt" -eq "$attempts" ]; then
    cleanup_child "$CHILD_PID"
    fail "LocateAnything sidecar did not become ready within ${TIMEOUT_MS}ms. Inspect '$LOG_FILE', confirm 127.0.0.1:${PORT} is free, and retry."
  fi
  sleep_for_poll
done

# Post-ready: capture system swap delta and child process metrics (cpp backend only).
if [ "$BACKEND" = "cpp" ]; then
  # Read post-ready swap from meminfo (use mutated fixture when set).
  POST_MEMINFO_PATH="${UI_DIFF_LOCATEANYTHING_MUTATE_MEMINFO_INTERNAL:-$BASELINE_MEMINFO_PATH}"
  POST_SWAP_KB=""
  POST_SWAP_KB="$(read_swap_free_kb "$POST_MEMINFO_PATH" 2>/dev/null || true)"
  [ -n "$POST_SWAP_KB" ] || { cleanup_child "$CHILD_PID"; fail "post-ready swap: could not read SwapFree from '$POST_MEMINFO_PATH'."; }

  SWAP_DELTA=$((BASELINE_SWAP_KB - POST_SWAP_KB))
  [ "$SWAP_DELTA" -ge 0 ] || SWAP_DELTA=0
  if [ "$SWAP_DELTA" -gt 0 ]; then
    cleanup_child "$CHILD_PID"
    fail "positive system swap delta: baseline ${BASELINE_SWAP_KB} KiB, post-ready ${POST_SWAP_KB} KiB (delta ${SWAP_DELTA}). ReDroid co-location may be leaking memory."
  fi

  # Read child process metrics.
  PROC_STATUS_PATH="${UI_DIFF_LOCATEANYTHING_PROC_STATUS_FILE_INTERNAL:-}"
  if [ -z "$PROC_STATUS_PATH" ]; then
    PROC_STATUS_PATH="/proc/${CHILD_PID}/status"
  fi
  CHILD_METRICS=""
  if CHILD_METRICS="$(read_child_proc_metrics "$PROC_STATUS_PATH" 2>/dev/null)"; then
    CHILD_RSS="$(printf '%s' "$CHILD_METRICS" | sed -n '1p')"
    CHILD_HWM="$(printf '%s' "$CHILD_METRICS" | sed -n '2p')"
    CHILD_SWAP="$(printf '%s' "$CHILD_METRICS" | sed -n '3p')"
  else
    cleanup_child "$CHILD_PID"
    fail "child proc metrics: could not read or parse VmRSS/VmHWM/VmSwap from '$PROC_STATUS_PATH'."
  fi

  # Fail on missing or malformed metrics.
  [ -n "$CHILD_RSS" ] && [[ "$CHILD_RSS" =~ ^[0-9]+$ ]] || { cleanup_child "$CHILD_PID"; fail "child proc metrics: VmRSS missing or not an unsigned integer: '${CHILD_RSS:-}'."; }
  [ -n "$CHILD_HWM" ] && [[ "$CHILD_HWM" =~ ^[0-9]+$ ]] || { cleanup_child "$CHILD_PID"; fail "child proc metrics: VmHWM missing or not an unsigned integer: '${CHILD_HWM:-}'."; }
  [ -n "$CHILD_SWAP" ] && [[ "$CHILD_SWAP" =~ ^[0-9]+$ ]] || { cleanup_child "$CHILD_PID"; fail "child proc metrics: VmSwap missing or not an unsigned integer: '${CHILD_SWAP:-}'."; }

  # Fail on positive child VmSwap.
  if [ "$CHILD_SWAP" -gt 0 ]; then
    cleanup_child "$CHILD_PID"
    fail "positive child VmSwap: ${CHILD_SWAP} kB. ReDroid co-location is swapping the worker."
  fi

  # Write atomic metrics file; no temp residue on failure.
  write_metrics_file "$STAGE4_METRICS_DIR" "$BACKEND" "$STAGE4_ENGINE_COMMIT" "$STAGE4_MODEL_SHA" "$STAGE4_ABI" "Q4_K" "$ARCH" "$BASELINE_SWAP_KB" "$POST_SWAP_KB" "$CHILD_RSS" "$CHILD_HWM" "$CHILD_SWAP" >/dev/null 2>&1 || { cleanup_child "$CHILD_PID"; fail "write_metrics_file: atomic write failed. No metrics file written."; }
fi
