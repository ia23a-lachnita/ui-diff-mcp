#!/usr/bin/env bash
# Start the pinned ARM64 ReDroid container for local UI validation.
#
# Source image tag: redroid/redroid:14.0.0_64only-latest
# Manifest-list digest: sha256:0a611199ba2e0b5d60af39b3327a517f6407231f4352114ed3bd3cbfe2be69aa
# Runtime image: UI_DIFF_REDROID_IMAGE from android-env-common.sh, pinned to
# an ARM64 manifest digest. The container restarts unless stopped and maps
# the validated persistent data directory to /data.
#
# Representative launch shape (the optional KVM mapping is included only when
# /dev/kvm is a character device):
#   docker run -d --name ui-diff-redroid --restart unless-stopped \
#     --privileged --publish 127.0.0.1:5555:5555 \
#     --volume <data-dir>:/data \
#     --device /dev/binder:/dev/binder \
#     --device /dev/hwbinder:/dev/hwbinder \
#     --device /dev/vndbinder:/dev/vndbinder \
#     [--device /dev/kvm:/dev/kvm] \
#     redroid/redroid@sha256:46478a567194aed24cd0877d4434a9e58b534d4aad30931eb21999a52f2ce131 \
#     androidboot.redroid_gpu_mode=guest androidboot.use_memfd=1
#
# SECURITY: ReDroid needs --privileged to use Android binder devices. That
# grants broad host device access. Binding ADB only to 127.0.0.1 reduces
# network exposure, but it does not reduce this host-device-access risk.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/android-env-common.sh
source "$SCRIPT_DIR/lib/android-env-common.sh"

if [ "$#" -ne 0 ]; then
  fail "Usage: $(basename "$0")"
fi

ADB_SERIAL="${UI_DIFF_REDROID_ADB_HOST}:${UI_DIFF_REDROID_ADB_PORT}"
ADB_TIMEOUT_SECS="${UI_DIFF_REDROID_ADB_TIMEOUT_SECS:-90}"
case "$ADB_TIMEOUT_SECS" in
  ''|*[!0-9]*|0) fail "UI_DIFF_REDROID_ADB_TIMEOUT_SECS must be a positive integer." ;;
esac

adb_is_ready() {
  local state
  "$ADB_BIN" connect "$ADB_SERIAL" >/dev/null 2>&1 || return 1
  state="$("$ADB_BIN" -s "$ADB_SERIAL" get-state 2>/dev/null)" || return 1
  [ "$state" = "device" ]
}

wait_for_adb() {
  local deadline=$((SECONDS + ADB_TIMEOUT_SECS))
  while ! adb_is_ready; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      fail "Timed out after ${ADB_TIMEOUT_SECS}s waiting for ReDroid ADB at $ADB_SERIAL. Inspect 'docker logs $UI_DIFF_REDROID_NAME'."
    fi
    sleep 1
  done
}

require_docker
require_arm64_host
check_binder_kernel_config
resolve_adb_bin

container_state="$(docker_container_state "$UI_DIFF_REDROID_NAME")"
if [ "$container_state" = "running" ] && adb_is_ready; then
  printf 'ReDroid container %s is already running and healthy at %s.\n' "$UI_DIFF_REDROID_NAME" "$ADB_SERIAL"
  exit 0
fi

if [ "$container_state" != "absent" ]; then
  printf 'Removing stale or unhealthy ReDroid container %s.\n' "$UI_DIFF_REDROID_NAME"
  docker rm -f "$UI_DIFF_REDROID_NAME" >/dev/null
fi

validate_safe_data_dir "$UI_DIFF_REDROID_DATA_DIR"
mkdir -p "$UI_DIFF_REDROID_DATA_DIR"

for binder_device in "${UI_DIFF_BINDER_DEVICE_NAMES[@]}"; do
  ensure_binder_device "$binder_device"
done

publish_spec="${UI_DIFF_REDROID_ADB_HOST}:${UI_DIFF_REDROID_ADB_PORT}:5555"
assert_loopback_publish "$publish_spec"

docker_args=(
  run -d
  --name "$UI_DIFF_REDROID_NAME"
  --restart unless-stopped
  --privileged
  --publish "$publish_spec"
  --volume "${UI_DIFF_REDROID_DATA_DIR}:/data"
  --device "${UI_DIFF_DEV_ROOT}/binder:/dev/binder"
  --device "${UI_DIFF_DEV_ROOT}/hwbinder:/dev/hwbinder"
  --device "${UI_DIFF_DEV_ROOT}/vndbinder:/dev/vndbinder"
)

if [ -c "${UI_DIFF_DEV_ROOT}/kvm" ]; then
  docker_args+=(--device "${UI_DIFF_DEV_ROOT}/kvm:/dev/kvm")
  printf 'Using optional KVM device %s.\n' "${UI_DIFF_DEV_ROOT}/kvm"
else
  printf 'Optional KVM device %s is absent; starting without KVM acceleration.\n' "${UI_DIFF_DEV_ROOT}/kvm"
fi

docker_args+=(
  "$UI_DIFF_REDROID_IMAGE"
  androidboot.redroid_gpu_mode=guest
  androidboot.use_memfd=1
)

docker "${docker_args[@]}" >/dev/null
wait_for_adb
printf 'ReDroid container %s is ready at %s.\n' "$UI_DIFF_REDROID_NAME" "$ADB_SERIAL"
