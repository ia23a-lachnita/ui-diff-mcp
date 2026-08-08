#!/usr/bin/env bash
# Wipe the validated ReDroid data directory and start a clean container.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/android-env-common.sh
source "$SCRIPT_DIR/lib/android-env-common.sh"

if [ "$#" -ne 1 ] || [ "$1" != "--yes" ]; then
  fail "Refusing to wipe ReDroid data without explicit confirmation. Usage: $(basename "$0") --yes"
fi

validate_safe_data_dir "$UI_DIFF_REDROID_DATA_DIR"
"$SCRIPT_DIR/stop-redroid.sh"
rm -rf -- "$UI_DIFF_REDROID_DATA_DIR"
mkdir -p "$UI_DIFF_REDROID_DATA_DIR"
exec "$SCRIPT_DIR/start-redroid.sh"
