#!/usr/bin/env bash
# Start the LocateAnything sidecar on loopback only.
#
# Internal test hooks, never required in production:
#   UI_DIFF_LOCATEANYTHING_KNOWN_PYTHON_INTERNAL
#   UI_DIFF_LOCATEANYTHING_EAGLE_DIR_INTERNAL
#   UI_DIFF_LOCATEANYTHING_PORT_INTERNAL
#   UI_DIFF_LOCATEANYTHING_LOG_DIR_INTERNAL
#   UI_DIFF_LOCATEANYTHING_CPP_CHECKOUT_INTERNAL
#   UI_DIFF_LOCATEANYTHING_CPP_LIBRARY_INTERNAL
#   UI_DIFF_LOCATEANYTHING_CPP_MODEL_INTERNAL
#   UI_DIFF_LOCATEANYTHING_CPP_LIB_MACHINE_INTERNAL
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST="127.0.0.1"
DEFAULT_PORT="39731"
DEFAULT_TIMEOUT_MS="120000"
DEFAULT_POLL_MS="500"
KNOWN_PYTHON="${UI_DIFF_LOCATEANYTHING_KNOWN_PYTHON_INTERNAL:-/home/agent-runner/projects/.venvs/ui-diff-mcp-locateanything/bin/python}"
DEFAULT_EAGLE_DIR="${UI_DIFF_LOCATEANYTHING_EAGLE_DIR_INTERNAL:-/home/agent-runner/projects/Eagle/Embodied}"
LOG_DIR="${UI_DIFF_LOCATEANYTHING_LOG_DIR_INTERNAL:-${XDG_STATE_HOME:-$HOME/.local/state}/ui-diff-mcp}"
PORT="${UI_DIFF_LOCATEANYTHING_PORT_INTERNAL:-$DEFAULT_PORT}"
TIMEOUT_MS="${UI_DIFF_LOCATEANYTHING_TIMEOUT_MS:-$DEFAULT_TIMEOUT_MS}"
POLL_MS="${UI_DIFF_LOCATEANYTHING_POLL_MS:-$DEFAULT_POLL_MS}"
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
  is_positive_bounded_int "$TIMEOUT_MS" 600000 || fail "LOCATEANYTHING_TIMEOUT_MS must be an integer from 1 through 600000 milliseconds; got '$TIMEOUT_MS'."
  is_positive_bounded_int "$POLL_MS" 10000 || fail "LOCATEANYTHING_POLL_MS must be an integer from 1 through 10000 milliseconds; got '$POLL_MS'."
  [ "$POLL_MS" -le "$TIMEOUT_MS" ] || fail "LOCATEANYTHING_POLL_MS must not exceed LOCATEANYTHING_TIMEOUT_MS."
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
  else
    preflight_python_launch_surface "$BACKEND"
    resolve_eagle_dir
  fi
  require_startup_dependencies
  if [ "$BACKEND" = "cpp" ]; then
    printf 'LocateAnything sidecar check passed: backend=cpp Python=%s host=%s port=%s library=%s model=%s\n' "$PYTHON_BIN" "$HOST" "$PORT" "$CPP_LIB_PATH" "$CPP_MODEL_PATH"
  else
    printf 'LocateAnything sidecar check passed: backend=official Python=%s Eagle=%s host=%s port=%s\n' "$PYTHON_BIN" "$EAGLE_DIR" "$HOST" "$PORT"
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
resolve_python
preflight_python_launch_surface ""
resolve_eagle_dir
require_startup_dependencies

: "${LOCATEANYTHING_IN_TOKEN_LIMIT:=4096}"
: "${LOCATEANYTHING_GENERATION_MODE:=hybrid}"
: "${LOCATEANYTHING_MAX_NEW_TOKENS:=512}"
export LOCATEANYTHING_IN_TOKEN_LIMIT LOCATEANYTHING_GENERATION_MODE LOCATEANYTHING_MAX_NEW_TOKENS

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
      exit 0
      ;;
    error:*)
      cleanup_child "$CHILD_PID"
      fail "LocateAnything sidecar reported a load error: ${status#error:}. Inspect '$LOG_FILE', repair Eagle/Python/model dependencies, then retry."
      ;;
  esac
  [ "$attempt" -lt "$attempts" ] && sleep_for_poll
done

cleanup_child "$CHILD_PID"
fail "LocateAnything sidecar did not become ready within ${TIMEOUT_MS}ms. Inspect '$LOG_FILE', confirm 127.0.0.1:${PORT} is free, and retry."
