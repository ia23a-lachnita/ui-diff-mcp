#!/usr/bin/env bash
# Start the LocateAnything sidecar on loopback only.
#
# Internal test hooks, never required in production:
#   UI_DIFF_LOCATEANYTHING_KNOWN_PYTHON_INTERNAL
#   UI_DIFF_LOCATEANYTHING_EAGLE_DIR_INTERNAL
#   UI_DIFF_LOCATEANYTHING_PORT_INTERNAL
#   UI_DIFF_LOCATEANYTHING_LOG_DIR_INTERNAL
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
  local detail="" error_line=""
  if ! detail="$(cd "$REPO_ROOT" && "$PYTHON_BIN" -c 'import uvicorn; import sidecars.locateanything.server' 2>&1)"; then
    error_line="${detail##*$'\n'}"
    fail "Selected Python interpreter '$PYTHON_BIN' cannot import uvicorn and sidecars.locateanything.server from '$REPO_ROOT'. Install the required packages with: '$PYTHON_BIN' -m pip install -r '$REPO_ROOT/sidecars/locateanything/requirements.txt'. Import error: ${error_line:-unknown import failure}"
  fi
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

validate_settings

if [ "$CHECK_ONLY" -eq 1 ]; then
  resolve_python
  preflight_python_launch_surface
  resolve_eagle_dir
  require_health_dependencies
  require_startup_dependencies
  printf 'LocateAnything sidecar check passed: Python=%s Eagle=%s host=%s port=%s\n' "$PYTHON_BIN" "$EAGLE_DIR" "$HOST" "$PORT"
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

resolve_python
preflight_python_launch_surface
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
