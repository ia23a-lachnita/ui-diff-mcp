#!/usr/bin/env bash
# Stop and remove the ReDroid container while preserving its host data dir.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/android-env-common.sh
source "$SCRIPT_DIR/lib/android-env-common.sh"

if [ "$#" -ne 0 ]; then
  fail "Usage: $(basename "$0")"
fi

require_docker
container_state="$(docker_container_state "$UI_DIFF_REDROID_NAME")"
if [ "$container_state" = "absent" ]; then
  printf 'ReDroid container %s is already absent; preserving %s.\n' "$UI_DIFF_REDROID_NAME" "$UI_DIFF_REDROID_DATA_DIR"
  exit 0
fi

if [ "$container_state" = "running" ]; then
  docker stop "$UI_DIFF_REDROID_NAME" >/dev/null
fi
docker rm "$UI_DIFF_REDROID_NAME" >/dev/null
printf 'Stopped and removed ReDroid container %s; preserved %s.\n' "$UI_DIFF_REDROID_NAME" "$UI_DIFF_REDROID_DATA_DIR"
