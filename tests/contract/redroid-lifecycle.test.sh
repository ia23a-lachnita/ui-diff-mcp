#!/usr/bin/env bash
# tests/contract/redroid-lifecycle.test.sh - shell-contract tests for Task 4
# Covers start-redroid.sh, stop-redroid.sh, reset-redroid.sh: pinned image
# digest/source tag/manifest digest documentation, exact loopback publish,
# software-rendering guest flags, persistent data mount, --privileged
# security contract, all-three binder device mappings plus optional kvm,
# fail-closed behavior for absent/unusable docker, absent/invalid/
# no-privilege binder sysfs, binderfs-directory-is-not-a-device, idempotent
# already-running/healthy short-circuit, stale/stopped and
# running-but-unhealthy container recreation, ADB-ready timeout, stop
# preserving data, and reset --yes/without --yes data-wipe safety.
# All docker/adb/id/sudo/mknod interactions are faked via PATH; no real
# Docker, root, mknod, or network is used. Exact fake command logs (not
# grep-only source assertions) prove behavior wherever the requirement is
# behavioral rather than structural/documentation.
# Note: -e disabled intentionally; tests check exit codes explicitly.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0
TESTS_RUN=0

# --- helpers -------------------------------------------------------
pass() { PASS=$((PASS+1)); TESTS_RUN=$((TESTS_RUN+1)); printf "  PASS %s\n" "$1"; }
fail() { FAIL=$((FAIL+1)); TESTS_RUN=$((TESTS_RUN+1)); printf "  FAIL %s: %s\n" "$1" "$2"; }

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then pass "$label"
  else fail "$label" "output missing '$needle'"; fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then fail "$label" "output contains forbidden '$needle'"
  else pass "$label"; fi
}

assert_file_empty() {
  local label="$1" path="$2"
  if [ ! -s "$path" ]; then pass "$label"
  else fail "$label" "expected empty file but found: $(cat "$path")"; fi
}

assert_file_exists() {
  local label="$1" path="$2"
  if [ -e "$path" ]; then pass "$label"
  else fail "$label" "expected file/dir to exist: $path"; fi
}

assert_file_absent() {
  local label="$1" path="$2"
  if [ ! -e "$path" ]; then pass "$label"
  else fail "$label" "expected path to be absent: $path"; fi
}

assert_exit_zero() {
  local label="$1" status="$2" output="$3"
  if [ "$status" -eq 0 ]; then pass "$label"
  else fail "$label" "nonzero exit: $status / $output"; fi
}

assert_log_order() {
  local label="$1" path="$2"
  shift 2
  local previous_line=0 needle line
  for needle in "$@"; do
    line="$(awk -v needle="$needle" 'index($0, needle) { print NR; exit }' "$path")"
    if [ -z "$line" ]; then
      fail "$label" "missing '$needle' in $(cat "$path")"
      return
    fi
    if [ "$line" -le "$previous_line" ]; then
      fail "$label" "'$needle' did not occur after the preceding lifecycle command"
      return
    fi
    previous_line="$line"
  done
  pass "$label"
}

# --- single shared temp dir for the whole suite ---------------------
_CONTRACT_TMP=$(mktemp -d)
cleanup_tmp() { [ -d "${_CONTRACT_TMP:-}" ] && rm -rf "$_CONTRACT_TMP"; }
trap cleanup_tmp EXIT

# --- Resolve scripts (must exist for GREEN) -------------------------
COMMON_SH="$REPO_ROOT/scripts/lib/android-env-common.sh"
START_SH="$REPO_ROOT/scripts/start-redroid.sh"
STOP_SH="$REPO_ROOT/scripts/stop-redroid.sh"
RESET_SH="$REPO_ROOT/scripts/reset-redroid.sh"

# --- PATH fixture: real shell utilities retained, host adb/docker hidden --
# Filtering out whole PATH directories (like Task 3's fixture) is unsafe
# here because docker and bash/coreutils commonly live in the same real
# directory (e.g. /usr/bin) - dropping that directory would also hide
# bash itself. Instead, build one shadow directory containing symlinks to
# every real command except the named victims, so only those specific
# binary names are hidden while everything else real scripts need
# (bash, cat, grep, mkdir, rm, uname, id, sudo, ...) remains resolvable.
_build_shadow_path() {
  local shadow="$1"; shift
  local victims=("$@")
  mkdir -p "$shadow"
  local dir f name is_victim v
  local saved_ifs="$IFS"
  IFS=':'
  for dir in $PATH; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    for f in "$dir"/*; do
      [ -e "$f" ] || continue
      name="$(basename "$f")"
      is_victim=false
      for v in "${victims[@]}"; do
        if [ "$name" = "$v" ]; then is_victim=true; break; fi
      done
      [ "$is_victim" = true ] && continue
      [ -e "$shadow/$name" ] && continue
      ln -s "$f" "$shadow/$name" 2>/dev/null || true
    done
  done
  IFS="$saved_ifs"
  printf '%s' "$shadow"
}

FAKE_BIN="$_CONTRACT_TMP/fakebin"
mkdir -p "$FAKE_BIN"

# --- Fake uname: deterministic architecture and kernel-release inputs --
FAKE_UNAME="$FAKE_BIN/uname_helper"
cat > "$FAKE_UNAME" <<'UNAMEEOF'
#!/usr/bin/env bash
case "$1" in
  -m) printf '%s\n' "${FAKE_UNAME_MACHINE:-aarch64}" ;;
  -r) printf '%s\n' "${FAKE_UNAME_RELEASE:-contract-kernel}" ;;
  *) echo "FAKE_UNAME: unsupported: $*" >&2; exit 1 ;;
esac
UNAMEEOF
chmod +x "$FAKE_UNAME"
ARCH_BIN="$_CONTRACT_TMP/archbin"
mkdir -p "$ARCH_BIN"
ln -s "$FAKE_UNAME" "$ARCH_BIN/uname"

BASE_PATH_NO_ADB_NO_DOCKER="$(_build_shadow_path "$_CONTRACT_TMP/shadowbin" adb docker)"

# --- Fake adb: full support (version, devices, -s <serial> get-state, connect) --
FAKE_ADB_FULL="$FAKE_BIN/adb_full"
cat > "$FAKE_ADB_FULL" <<'ADBEOF'
#!/usr/bin/env bash
case "$1" in
  version) echo "Android Debug Bridge version 1.0.41"; exit 0 ;;
  devices)
    echo "List of devices attached"
    echo "127.0.0.1:5555	device"
    echo ""
    exit 0
    ;;
  -s)
    shift
    serial="$1"; shift
    case "$1" in
      get-state) echo "device"; exit 0 ;;
      *) echo "FAKE_ADB: unsupported -s command: $*" >&2; exit 1 ;;
    esac
    ;;
  connect) echo "connected to $2"; exit 0 ;;
  *) echo "FAKE_ADB: unsupported: $*" >&2; exit 1 ;;
esac
ADBEOF
chmod +x "$FAKE_ADB_FULL"

# --- Fake adb: never becomes ready (connect/get-state always fail) ---
FAKE_ADB_NEVER_READY="$FAKE_BIN/adb_never_ready"
cat > "$FAKE_ADB_NEVER_READY" <<'ADBEOF'
#!/usr/bin/env bash
case "$1" in
  version) echo "Android Debug Bridge version 1.0.41"; exit 0 ;;
  devices) echo "List of devices attached"; echo ""; exit 0 ;;
  -s)
    shift; shift
    case "$1" in
      get-state) echo "offline"; exit 1 ;;
      *) exit 1 ;;
    esac
    ;;
  connect) echo "failed to connect"; exit 1 ;;
  *) exit 1 ;;
esac
ADBEOF
chmod +x "$FAKE_ADB_NEVER_READY"

# --- Fake docker: behavior controlled by env vars, logs every call ---
# FAKE_DOCKER_INFO_FAIL=1            -> `docker info` exits 1 (permission denied)
# FAKE_DOCKER_CONTAINER_STATE        -> absent | running | stopped (default absent)
# FAKE_DOCKER_STATE_FILE             -> optional mutable state for lifecycle tests
# FAKE_DOCKER_RUN_EXIT / _STOP_EXIT / _RM_EXIT -> override subcommand exit codes
FAKE_DOCKER="$FAKE_BIN/docker"
cat > "$FAKE_DOCKER" <<'DOCKEREOF'
#!/usr/bin/env bash
echo "$*" >> "${DOCKER_CALL_LOG:-/dev/null}"
case "$1" in
  info)
    if [ "${FAKE_DOCKER_INFO_FAIL:-0}" = "1" ]; then
      echo "Cannot connect to the Docker daemon: permission denied" >&2
      exit 1
    fi
    echo "Docker info OK"
    exit 0
    ;;
  inspect)
    if [ -n "${FAKE_DOCKER_STATE_FILE:-}" ] && [ -f "$FAKE_DOCKER_STATE_FILE" ]; then
      state="$(cat "$FAKE_DOCKER_STATE_FILE")"
    else
      state="${FAKE_DOCKER_CONTAINER_STATE:-absent}"
    fi
    if [ "$state" = "absent" ]; then
      echo "Error: No such object" >&2
      exit 1
    elif [ "$state" = "running" ]; then
      echo "true"
      exit 0
    else
      echo "false"
      exit 0
    fi
    ;;
  run)
    exit_code="${FAKE_DOCKER_RUN_EXIT:-0}"
    if [ "$exit_code" -eq 0 ] && [ -n "${FAKE_DOCKER_STATE_FILE:-}" ]; then printf 'running' > "$FAKE_DOCKER_STATE_FILE"; fi
    exit "$exit_code"
    ;;
  stop)
    exit_code="${FAKE_DOCKER_STOP_EXIT:-0}"
    if [ "$exit_code" -eq 0 ] && [ -n "${FAKE_DOCKER_STATE_FILE:-}" ]; then printf 'stopped' > "$FAKE_DOCKER_STATE_FILE"; fi
    exit "$exit_code"
    ;;
  rm)
    exit_code="${FAKE_DOCKER_RM_EXIT:-0}"
    if [ "$exit_code" -eq 0 ] && [ -n "${FAKE_DOCKER_STATE_FILE:-}" ]; then printf 'absent' > "$FAKE_DOCKER_STATE_FILE"; fi
    exit "$exit_code"
    ;;
  *) echo "FAKE_DOCKER: unsupported: $*" >&2; exit 1 ;;
esac
DOCKEREOF
chmod +x "$FAKE_DOCKER"

# --- Fake mknod: logs invocation, always succeeds ---------------------
FAKE_MKNOD="$FAKE_BIN/mknod"
cat > "$FAKE_MKNOD" <<'MKNODEOF'
#!/usr/bin/env bash
echo "$*" >> "${MKNOD_CALL_LOG:-/dev/null}"
ln -s /dev/null "$1"
exit 0
MKNODEOF
chmod +x "$FAKE_MKNOD"

# --- Fake id: root vs non-root -----------------------------------------
FAKE_ID_ROOT="$FAKE_BIN/id_root_helper"
cat > "$FAKE_ID_ROOT" <<'IDEOF'
#!/usr/bin/env bash
case "$1" in
  -u) echo "0" ;;
  *) echo "uid=0(root) gid=0(root) groups=0(root)" ;;
esac
exit 0
IDEOF
chmod +x "$FAKE_ID_ROOT"

FAKE_ID_NONROOT="$FAKE_BIN/id_nonroot_helper"
cat > "$FAKE_ID_NONROOT" <<'IDEOF'
#!/usr/bin/env bash
case "$1" in
  -u) echo "1000" ;;
  *) echo "uid=1000(agent-runner) gid=1000(agent-runner) groups=1000(agent-runner)" ;;
esac
exit 0
IDEOF
chmod +x "$FAKE_ID_NONROOT"

# --- Fake sudo: deny vs allow ------------------------------------------
FAKE_SUDO_DENY="$FAKE_BIN/sudo_deny_helper"
cat > "$FAKE_SUDO_DENY" <<'SUDOEOF'
#!/usr/bin/env bash
echo "FAKE_SUDO_DENY called: $*" >&2
exit 1
SUDOEOF
chmod +x "$FAKE_SUDO_DENY"

FAKE_SUDO_ALLOW="$FAKE_BIN/sudo_allow_helper"
cat > "$FAKE_SUDO_ALLOW" <<'SUDOEOF'
#!/usr/bin/env bash
echo "sudo $*" >> "${SUDO_CALL_LOG:-/dev/null}"
exit 0
SUDOEOF
chmod +x "$FAKE_SUDO_ALLOW"

# --- root-fixture bin dir: real `id`/`sudo` binaries the scripts call,
# with fake basenames symlinked to the reserved command names -----------
ROOT_PRIV_BIN="$_CONTRACT_TMP/rootprivbin"
mkdir -p "$ROOT_PRIV_BIN"
ln -s "$FAKE_ID_ROOT" "$ROOT_PRIV_BIN/id"
ROOT_PRIV_PATH="$ARCH_BIN:$ROOT_PRIV_BIN:$FAKE_BIN:$BASE_PATH_NO_ADB_NO_DOCKER"

NO_PRIV_BIN="$_CONTRACT_TMP/noprivbin"
mkdir -p "$NO_PRIV_BIN"
ln -s "$FAKE_ID_NONROOT" "$NO_PRIV_BIN/id"
ln -s "$FAKE_SUDO_DENY" "$NO_PRIV_BIN/sudo"
NO_PRIV_PATH="$ARCH_BIN:$NO_PRIV_BIN:$FAKE_BIN:$BASE_PATH_NO_ADB_NO_DOCKER"

SUDO_PRIV_BIN="$_CONTRACT_TMP/sudoprivbin"
mkdir -p "$SUDO_PRIV_BIN"
ln -s "$FAKE_ID_NONROOT" "$SUDO_PRIV_BIN/id"
ln -s "$FAKE_SUDO_ALLOW" "$SUDO_PRIV_BIN/sudo"
SUDO_PRIV_PATH="$ARCH_BIN:$SUDO_PRIV_BIN:$FAKE_BIN:$BASE_PATH_NO_ADB_NO_DOCKER"

# Keep all existing launch tests independent of the host kernel config.
VALID_KERNEL_CONFIG="$_CONTRACT_TMP/kernel-config-valid"
cat > "$VALID_KERNEL_CONFIG" <<'CONFIGEOF'
CONFIG_ANDROID_BINDER_IPC=y
CONFIG_ANDROID_BINDER_DEVICES="binder,hwbinder,vndbinder"
CONFIGEOF
export UI_DIFF_KERNEL_CONFIG="$VALID_KERNEL_CONFIG"

# --- Sysfs fixture builder ---------------------------------------------
_make_valid_sysfs() {
  local sysroot="$1"
  mkdir -p "$sysroot/class/misc/binder" "$sysroot/class/misc/hwbinder" "$sysroot/class/misc/vndbinder"
  printf '10:64\n' > "$sysroot/class/misc/binder/dev"
  printf '10:65\n' > "$sysroot/class/misc/hwbinder/dev"
  printf '10:66\n' > "$sysroot/class/misc/vndbinder/dev"
}

# =====================================================================
# GROUP 1: pinned image digest / source tag / manifest digest
# =====================================================================
echo "=== Group 1: pinned ReDroid image digest documentation ==="

(
  source "$COMMON_SH"
  echo "$UI_DIFF_REDROID_IMAGE"
) | grep -qF "redroid/redroid@sha256:46478a567194aed24cd0877d4434a9e58b534d4aad30931eb21999a52f2ce131" \
  && pass "UI_DIFF_REDROID_IMAGE pins the exact arm64 digest" \
  || fail "UI_DIFF_REDROID_IMAGE pins the exact arm64 digest" "digest mismatch or missing"

grep -qF "redroid/redroid:14.0.0_64only-latest" "$START_SH" \
  && pass "start-redroid.sh documents the source tag" \
  || fail "start-redroid.sh documents the source tag" "source tag string missing"

grep -qF "sha256:0a611199ba2e0b5d60af39b3327a517f6407231f4352114ed3bd3cbfe2be69aa" "$START_SH" \
  && pass "start-redroid.sh documents the manifest-list digest" \
  || fail "start-redroid.sh documents the manifest-list digest" "manifest digest string missing"

# =====================================================================
# GROUP 2: exact loopback publish; reject 0.0.0.0/ambiguous bind
# =====================================================================
echo ""
echo "=== Group 2: exact loopback ADB publish ==="

NOT_PUB_START=$(grep -c "0\.0\.0\.0:5555" "$START_SH" || true)
[ "${NOT_PUB_START:-0}" -eq 0 ] && pass "start-redroid.sh has no 0.0.0.0 publish string" \
  || fail "start-redroid.sh has no 0.0.0.0 publish string" "found 0.0.0.0:5555 reference"

DOCKER_CALL_LOG="$_CONTRACT_TMP/docker-calls-publish.log"
: > "$DOCKER_CALL_LOG"
SYSROOT_PUB="$_CONTRACT_TMP/sys-publish"
DEVROOT_PUB="$_CONTRACT_TMP/dev-publish"
DATA_DIR_PUB="$_CONTRACT_TMP/state-publish/ui-diff-mcp/redroid-data"
_make_valid_sysfs "$SYSROOT_PUB"
mkdir -p "$DEVROOT_PUB"
PUBLISH_OUTPUT=$( 
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$SYSROOT_PUB"
  export UI_DIFF_DEV_ROOT="$DEVROOT_PUB"
  export UI_DIFF_REDROID_DATA_DIR="$DATA_DIR_PUB"
  export DOCKER_CALL_LOG MKNOD_CALL_LOG="$_CONTRACT_TMP/mknod-calls-publish.log"
  bash "$START_SH" 2>&1
)
PUBLISH_EXIT=$?
assert_exit_zero "baseline fake ReDroid start succeeds" "$PUBLISH_EXIT" "$PUBLISH_OUTPUT"
assert_contains "docker run publishes exactly 127.0.0.1:5555:5555" "$(cat "$DOCKER_CALL_LOG")" "127.0.0.1:5555:5555"
assert_not_contains "docker run never publishes 0.0.0.0" "$(cat "$DOCKER_CALL_LOG")" "0.0.0.0"

# =====================================================================
# GROUP 3: software-rendering guest flags
# =====================================================================
echo ""
echo "=== Group 3: guest rendering flags ==="

assert_contains "docker run sets androidboot.redroid_gpu_mode=guest" "$(cat "$DOCKER_CALL_LOG")" "androidboot.redroid_gpu_mode=guest"
assert_contains "docker run sets androidboot.use_memfd=1" "$(cat "$DOCKER_CALL_LOG")" "androidboot.use_memfd=1"

# =====================================================================
# GROUP 4: persistent host data mount to /data
# =====================================================================
echo ""
echo "=== Group 4: persistent data mount ==="

assert_contains "docker run mounts data dir to /data" "$(cat "$DOCKER_CALL_LOG")" ":/data"

assert_contains "docker run mounts the exact configured data dir" "$(cat "$DOCKER_CALL_LOG")" "$DATA_DIR_PUB:/data"

# =====================================================================
# GROUP 5: --privileged security contract
# =====================================================================
echo ""
echo "=== Group 5: --privileged security contract ==="

assert_contains "docker run uses --privileged" "$(cat "$DOCKER_CALL_LOG")" "--privileged"

grep -qiE "privileged|full host device access" "$START_SH" \
  && pass "start-redroid.sh documents the --privileged security risk" \
  || fail "start-redroid.sh documents the --privileged security risk" "no security-risk documentation found"

# =====================================================================
# GROUP 6: binder device mappings + optional kvm
# =====================================================================
echo ""
echo "=== Group 6: binder device mappings and optional kvm ==="

assert_contains "docker run maps binder device" "$(cat "$DOCKER_CALL_LOG")" "--device $DEVROOT_PUB/binder:/dev/binder"
assert_contains "docker run maps hwbinder device" "$(cat "$DOCKER_CALL_LOG")" "--device $DEVROOT_PUB/hwbinder:/dev/hwbinder"
assert_contains "docker run maps vndbinder device" "$(cat "$DOCKER_CALL_LOG")" "--device $DEVROOT_PUB/vndbinder:/dev/vndbinder"
assert_not_contains "docker run omits kvm when absent" "$(cat "$DOCKER_CALL_LOG")" "kvm"

# kvm present variant
DOCKER_CALL_LOG_KVM="$_CONTRACT_TMP/docker-calls-kvm.log"
: > "$DOCKER_CALL_LOG_KVM"
SYSROOT_KVM="$_CONTRACT_TMP/sys-kvm"
DEVROOT_KVM="$_CONTRACT_TMP/dev-kvm"
_make_valid_sysfs "$SYSROOT_KVM"
mkdir -p "$DEVROOT_KVM"
ln -s /dev/null "$DEVROOT_KVM/kvm"
(
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$SYSROOT_KVM"
  export UI_DIFF_DEV_ROOT="$DEVROOT_KVM"
  export UI_DIFF_REDROID_DATA_DIR="$_CONTRACT_TMP/state-kvm/ui-diff-mcp/redroid-data"
  export DOCKER_CALL_LOG="$DOCKER_CALL_LOG_KVM" MKNOD_CALL_LOG="$_CONTRACT_TMP/mknod-calls-kvm.log"
  bash "$START_SH" >/dev/null 2>&1
) || true
assert_contains "docker run maps kvm device when present" "$(cat "$DOCKER_CALL_LOG_KVM")" "--device $DEVROOT_KVM/kvm:/dev/kvm"

# =====================================================================
# GROUP 7: fail closed - docker absent
# =====================================================================
echo ""
echo "=== Group 7: fail closed when docker absent ==="

DOCKER_ABSENT_OUTPUT=$(
  export PATH="$BASE_PATH_NO_ADB_NO_DOCKER"
  bash "$START_SH" 2>&1
)
DOCKER_ABSENT_EXIT=$?
[ "$DOCKER_ABSENT_EXIT" -ne 0 ] && pass "start-redroid.sh fails closed when docker is absent" \
  || fail "start-redroid.sh fails closed when docker is absent" "expected nonzero exit"
echo "$DOCKER_ABSENT_OUTPUT" | grep -qi "docker" && pass "docker-absent failure message mentions docker" \
  || fail "docker-absent failure message mentions docker" "no mention of docker"

# =====================================================================
# GROUP 8: fail closed - docker present but unusable (info fails)
# =====================================================================
echo ""
echo "=== Group 8: fail closed when docker API is unusable ==="

DOCKER_UNUSABLE_OUTPUT=$(
  export PATH="$FAKE_BIN:$BASE_PATH_NO_ADB_NO_DOCKER"
  export FAKE_DOCKER_INFO_FAIL=1
  bash "$START_SH" 2>&1
)
DOCKER_UNUSABLE_EXIT=$?
[ "$DOCKER_UNUSABLE_EXIT" -ne 0 ] && pass "start-redroid.sh fails closed when docker info fails" \
  || fail "start-redroid.sh fails closed when docker info fails" "expected nonzero exit"
echo "$DOCKER_UNUSABLE_OUTPUT" | grep -qi "docker" && pass "docker-unusable failure message mentions docker" \
  || fail "docker-unusable failure message mentions docker" "no mention of docker"

# =====================================================================
# GROUP 9: fail closed - binder sysfs absent
# =====================================================================
echo ""
echo "=== Group 9: fail closed when binder sysfs is absent ==="

MKNOD_LOG_G9="$_CONTRACT_TMP/mknod-g9.log"
: > "$MKNOD_LOG_G9"
DOCKER_LOG_G9="$_CONTRACT_TMP/docker-g9.log"
: > "$DOCKER_LOG_G9"
SYSROOT_EMPTY="$_CONTRACT_TMP/sys-empty-g9"
DEVROOT_EMPTY_G9="$_CONTRACT_TMP/dev-empty-g9"
mkdir -p "$SYSROOT_EMPTY" "$DEVROOT_EMPTY_G9"
SYSFS_ABSENT_OUTPUT=$(
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$SYSROOT_EMPTY"
  export UI_DIFF_DEV_ROOT="$DEVROOT_EMPTY_G9"
  export MKNOD_CALL_LOG="$MKNOD_LOG_G9" DOCKER_CALL_LOG="$DOCKER_LOG_G9"
  bash "$START_SH" 2>&1
)
SYSFS_ABSENT_EXIT=$?
[ "$SYSFS_ABSENT_EXIT" -ne 0 ] && pass "start-redroid.sh fails closed when binder sysfs is absent" \
  || fail "start-redroid.sh fails closed when binder sysfs is absent" "expected nonzero exit"
echo "$SYSFS_ABSENT_OUTPUT" | grep -qi "sysfs\|binder" && pass "sysfs-absent failure message mentions binder/sysfs" \
  || fail "sysfs-absent failure message mentions binder/sysfs" "no mention found"
assert_file_empty "sysfs-absent case never invokes mknod" "$MKNOD_LOG_G9"
assert_not_contains "sysfs-absent case never runs docker run" "$(cat "$DOCKER_LOG_G9")" "run"

# =====================================================================
# GROUP 10: fail closed - invalid sysfs major:minor content
# =====================================================================
echo ""
echo "=== Group 10: fail closed on invalid sysfs major:minor ==="

MKNOD_LOG_G10="$_CONTRACT_TMP/mknod-g10.log"
: > "$MKNOD_LOG_G10"
SYSROOT_INVALID="$_CONTRACT_TMP/sys-invalid-g10"
DEVROOT_INVALID_G10="$_CONTRACT_TMP/dev-invalid-g10"
mkdir -p "$SYSROOT_INVALID/class/misc/binder" "$SYSROOT_INVALID/class/misc/hwbinder" "$SYSROOT_INVALID/class/misc/vndbinder"
printf 'not-a-major-minor\n' > "$SYSROOT_INVALID/class/misc/binder/dev"
printf '10:65\n' > "$SYSROOT_INVALID/class/misc/hwbinder/dev"
printf '10:66\n' > "$SYSROOT_INVALID/class/misc/vndbinder/dev"
mkdir -p "$DEVROOT_INVALID_G10"
INVALID_MAJMIN_OUTPUT=$(
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$SYSROOT_INVALID"
  export UI_DIFF_DEV_ROOT="$DEVROOT_INVALID_G10"
  export MKNOD_CALL_LOG="$MKNOD_LOG_G10"
  bash "$START_SH" 2>&1
)
INVALID_MAJMIN_EXIT=$?
[ "$INVALID_MAJMIN_EXIT" -ne 0 ] && pass "start-redroid.sh fails closed on invalid sysfs major:minor" \
  || fail "start-redroid.sh fails closed on invalid sysfs major:minor" "expected nonzero exit"
assert_file_empty "invalid-major:minor case never invokes mknod" "$MKNOD_LOG_G10"

MKNOD_LOG_G10B="$_CONTRACT_TMP/mknod-g10b.log"
: > "$MKNOD_LOG_G10B"
SYSROOT_INVALID_EMBEDDED="$_CONTRACT_TMP/sys-invalid-embedded-g10b"
DEVROOT_INVALID_EMBEDDED="$_CONTRACT_TMP/dev-invalid-embedded-g10b"
mkdir -p "$SYSROOT_INVALID_EMBEDDED/class/misc/binder" "$SYSROOT_INVALID_EMBEDDED/class/misc/hwbinder" "$SYSROOT_INVALID_EMBEDDED/class/misc/vndbinder"
printf '10x:64\n' > "$SYSROOT_INVALID_EMBEDDED/class/misc/binder/dev"
printf '10:65\n' > "$SYSROOT_INVALID_EMBEDDED/class/misc/hwbinder/dev"
printf '10:66\n' > "$SYSROOT_INVALID_EMBEDDED/class/misc/vndbinder/dev"
mkdir -p "$DEVROOT_INVALID_EMBEDDED"
INVALID_EMBEDDED_OUTPUT=$( 
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$SYSROOT_INVALID_EMBEDDED"
  export UI_DIFF_DEV_ROOT="$DEVROOT_INVALID_EMBEDDED"
  export UI_DIFF_REDROID_DATA_DIR="$_CONTRACT_TMP/state-g10b/ui-diff-mcp/redroid-data"
  export MKNOD_CALL_LOG="$MKNOD_LOG_G10B"
  bash "$START_SH" 2>&1
)
INVALID_EMBEDDED_EXIT=$?
[ "$INVALID_EMBEDDED_EXIT" -ne 0 ] && pass "start-redroid.sh rejects embedded nonnumeric sysfs major:minor" \
  || fail "start-redroid.sh rejects embedded nonnumeric sysfs major:minor" "expected nonzero exit: $INVALID_EMBEDDED_OUTPUT"
assert_file_empty "embedded-nonnumeric sysfs case never invokes mknod" "$MKNOD_LOG_G10B"

# =====================================================================
# GROUP 11: fail closed - no privilege to create nodes
# =====================================================================
echo ""
echo "=== Group 11: fail closed with no privilege to create device nodes ==="

MKNOD_LOG_G11="$_CONTRACT_TMP/mknod-g11.log"
: > "$MKNOD_LOG_G11"
SYSROOT_NOPRIV="$_CONTRACT_TMP/sys-nopriv-g11"
DEVROOT_NOPRIV_G11="$_CONTRACT_TMP/dev-nopriv-g11"
_make_valid_sysfs "$SYSROOT_NOPRIV"
mkdir -p "$DEVROOT_NOPRIV_G11"
NO_PRIV_OUTPUT=$(
  export PATH="$NO_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$SYSROOT_NOPRIV"
  export UI_DIFF_DEV_ROOT="$DEVROOT_NOPRIV_G11"
  export MKNOD_CALL_LOG="$MKNOD_LOG_G11"
  bash "$START_SH" 2>&1
)
NO_PRIV_EXIT=$?
[ "$NO_PRIV_EXIT" -ne 0 ] && pass "start-redroid.sh fails closed with no privilege" \
  || fail "start-redroid.sh fails closed with no privilege" "expected nonzero exit"
echo "$NO_PRIV_OUTPUT" | grep -qi "root\|sudo\|privilege" && pass "no-privilege failure message mentions root/sudo/privilege" \
  || fail "no-privilege failure message mentions root/sudo/privilege" "no remediation mentioned"
assert_file_empty "no-privilege case never invokes mknod" "$MKNOD_LOG_G11"

# =====================================================================
# GROUP 12: creates missing binder nodes only from sysfs major:minor
# =====================================================================
echo ""
echo "=== Group 12: binder node creation from exact sysfs major:minor (root) ==="

MKNOD_LOG_G12="$_CONTRACT_TMP/mknod-g12.log"
: > "$MKNOD_LOG_G12"
SYSROOT_G12="$_CONTRACT_TMP/sys-g12"
DEVROOT_G12="$_CONTRACT_TMP/dev-g12"
_make_valid_sysfs "$SYSROOT_G12"
mkdir -p "$DEVROOT_G12"
DOCKER_LOG_G12="$_CONTRACT_TMP/docker-g12.log"
: > "$DOCKER_LOG_G12"
(
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$SYSROOT_G12"
  export UI_DIFF_DEV_ROOT="$DEVROOT_G12"
  export MKNOD_CALL_LOG="$MKNOD_LOG_G12" DOCKER_CALL_LOG="$DOCKER_LOG_G12"
  bash "$START_SH" >/dev/null 2>&1
) || true
MKNOD_CONTENTS_G12="$(cat "$MKNOD_LOG_G12")"
assert_contains "mknod called with exact binder major:minor from sysfs" "$MKNOD_CONTENTS_G12" "$DEVROOT_G12/binder c 10 64"
assert_contains "mknod called with exact hwbinder major:minor from sysfs" "$MKNOD_CONTENTS_G12" "$DEVROOT_G12/hwbinder c 10 65"
assert_contains "mknod called with exact vndbinder major:minor from sysfs" "$MKNOD_CONTENTS_G12" "$DEVROOT_G12/vndbinder c 10 66"

# =====================================================================
# GROUP 13: binderfs directory fails closed and is never treated as a device
# =====================================================================
echo ""
echo "=== Group 13: binderfs directory fails closed ==="

MKNOD_LOG_G13="$_CONTRACT_TMP/mknod-g13.log"
: > "$MKNOD_LOG_G13"
SYSROOT_G13="$_CONTRACT_TMP/sys-g13"
DEVROOT_G13="$_CONTRACT_TMP/dev-g13"
_make_valid_sysfs "$SYSROOT_G13"
mkdir -p "$DEVROOT_G13/binder"
DOCKER_LOG_G13="$_CONTRACT_TMP/docker-g13.log"
: > "$DOCKER_LOG_G13"
BINDERFS_OUTPUT=$( 
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$SYSROOT_G13"
  export UI_DIFF_DEV_ROOT="$DEVROOT_G13"
  export UI_DIFF_REDROID_DATA_DIR="$_CONTRACT_TMP/state-g13/ui-diff-mcp/redroid-data"
  export MKNOD_CALL_LOG="$MKNOD_LOG_G13" DOCKER_CALL_LOG="$DOCKER_LOG_G13"
  bash "$START_SH" 2>&1
)
BINDERFS_EXIT=$?
[ "$BINDERFS_EXIT" -ne 0 ] && pass "binderfs directory fails closed" \
  || fail "binderfs directory fails closed" "expected nonzero exit"
echo "$BINDERFS_OUTPUT" | grep -qi "binder\|device" && pass "binderfs directory failure explains the occupied device path" \
  || fail "binderfs directory failure explains the occupied device path" "no binder-device remediation"
assert_file_empty "binderfs directory never invokes mknod" "$MKNOD_LOG_G13"
assert_not_contains "binderfs directory never starts docker" "$(cat "$DOCKER_LOG_G13")" "run"

# =====================================================================
# GROUP 14: idempotent already-running/healthy path avoids second docker run
# =====================================================================
echo ""
echo "=== Group 14: idempotent already-running/healthy path ==="

DOCKER_LOG_G14="$_CONTRACT_TMP/docker-g14.log"
: > "$DOCKER_LOG_G14"
MKNOD_LOG_G14="$_CONTRACT_TMP/mknod-g14.log"
: > "$MKNOD_LOG_G14"
IDEMPOTENT_OUTPUT=$(
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_REDROID_DATA_DIR="$_CONTRACT_TMP/state-g14/ui-diff-mcp/redroid-data"
  export FAKE_DOCKER_CONTAINER_STATE=running
  export DOCKER_CALL_LOG="$DOCKER_LOG_G14" MKNOD_CALL_LOG="$MKNOD_LOG_G14"
  bash "$START_SH" 2>&1
)
IDEMPOTENT_EXIT=$?
[ "$IDEMPOTENT_EXIT" -eq 0 ] && pass "idempotent running/healthy start exits 0" \
  || fail "idempotent running/healthy start exits 0" "nonzero exit: $IDEMPOTENT_EXIT / $IDEMPOTENT_OUTPUT"
assert_not_contains "idempotent path never runs docker run" "$(cat "$DOCKER_LOG_G14")" "run -d"
assert_not_contains "idempotent path never removes the container" "$(cat "$DOCKER_LOG_G14")" "rm"
assert_file_empty "idempotent path never touches binder devices" "$MKNOD_LOG_G14"

# =====================================================================
# GROUP 15: stale/stopped container is recreated safely
# =====================================================================
echo ""
echo "=== Group 15: stale/stopped container recreated ==="

DOCKER_LOG_G15="$_CONTRACT_TMP/docker-g15.log"
: > "$DOCKER_LOG_G15"
SYSROOT_G15="$_CONTRACT_TMP/sys-g15"
DEVROOT_G15="$_CONTRACT_TMP/dev-g15"
_make_valid_sysfs "$SYSROOT_G15"
mkdir -p "$DEVROOT_G15"
STALE_OUTPUT=$(
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$SYSROOT_G15"
  export UI_DIFF_DEV_ROOT="$DEVROOT_G15"
  export UI_DIFF_REDROID_DATA_DIR="$_CONTRACT_TMP/state-g15/ui-diff-mcp/redroid-data"
  export FAKE_DOCKER_CONTAINER_STATE=stopped
  export DOCKER_CALL_LOG="$DOCKER_LOG_G15" MKNOD_CALL_LOG="$_CONTRACT_TMP/mknod-g15.log"
  bash "$START_SH" 2>&1
)
STALE_EXIT=$?
[ "$STALE_EXIT" -eq 0 ] && pass "stale/stopped container recreate exits 0" \
  || fail "stale/stopped container recreate exits 0" "nonzero exit: $STALE_EXIT / $STALE_OUTPUT"
assert_contains "stale/stopped path removes the old container" "$(cat "$DOCKER_LOG_G15")" "rm"
assert_contains "stale/stopped path runs a new container" "$(cat "$DOCKER_LOG_G15")" "run -d"

# =====================================================================
# GROUP 16: running-but-unhealthy container is recreated
# =====================================================================
echo ""
echo "=== Group 16: running-but-unhealthy container recreated ==="

FAKE_ADB_UNHEALTHY="$FAKE_BIN/adb_unhealthy"
cat > "$FAKE_ADB_UNHEALTHY" <<'ADBEOF'
#!/usr/bin/env bash
case "$1" in
  version) echo "Android Debug Bridge version 1.0.41"; exit 0 ;;
  -s)
    shift; shift
    case "$1" in
      get-state) echo "offline"; exit 1 ;;
      *) exit 1 ;;
    esac
    ;;
  connect) echo "connected"; exit 0 ;;
  devices) echo "List of devices attached"; echo ""; exit 0 ;;
  *) exit 1 ;;
esac
ADBEOF
chmod +x "$FAKE_ADB_UNHEALTHY"

DOCKER_LOG_G16="$_CONTRACT_TMP/docker-g16.log"
: > "$DOCKER_LOG_G16"
SYSROOT_G16="$_CONTRACT_TMP/sys-g16"
DEVROOT_G16="$_CONTRACT_TMP/dev-g16"
_make_valid_sysfs "$SYSROOT_G16"
mkdir -p "$DEVROOT_G16"
UNHEALTHY_OUTPUT=$(
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_UNHEALTHY"
  export UI_DIFF_SYS_ROOT="$SYSROOT_G16"
  export UI_DIFF_DEV_ROOT="$DEVROOT_G16"
  export UI_DIFF_REDROID_DATA_DIR="$_CONTRACT_TMP/state-g16/ui-diff-mcp/redroid-data"
  export UI_DIFF_REDROID_ADB_TIMEOUT_SECS=1
  export FAKE_DOCKER_CONTAINER_STATE=running
  export DOCKER_CALL_LOG="$DOCKER_LOG_G16" MKNOD_CALL_LOG="$_CONTRACT_TMP/mknod-g16.log"
  bash "$START_SH" 2>&1
)
assert_contains "running-but-unhealthy path removes the stale container" "$(cat "$DOCKER_LOG_G16")" "rm"
assert_contains "running-but-unhealthy path runs a replacement container" "$(cat "$DOCKER_LOG_G16")" "run -d"

# =====================================================================
# GROUP 17: timeout/error when ADB never becomes ready
# =====================================================================
echo ""
echo "=== Group 17: ADB-ready timeout ==="

SYSROOT_G17="$_CONTRACT_TMP/sys-g17"
DEVROOT_G17="$_CONTRACT_TMP/dev-g17"
_make_valid_sysfs "$SYSROOT_G17"
mkdir -p "$DEVROOT_G17"
TIMEOUT_OUTPUT=$(
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_NEVER_READY"
  export UI_DIFF_SYS_ROOT="$SYSROOT_G17"
  export UI_DIFF_DEV_ROOT="$DEVROOT_G17"
  export UI_DIFF_REDROID_DATA_DIR="$_CONTRACT_TMP/state-g17/ui-diff-mcp/redroid-data"
  export UI_DIFF_REDROID_ADB_TIMEOUT_SECS=1
  export DOCKER_CALL_LOG="$_CONTRACT_TMP/docker-g17.log" MKNOD_CALL_LOG="$_CONTRACT_TMP/mknod-g17.log"
  timeout 20 bash "$START_SH" 2>&1
)
TIMEOUT_EXIT=$?
[ "$TIMEOUT_EXIT" -ne 0 ] && pass "start-redroid.sh times out and fails when ADB never becomes ready" \
  || fail "start-redroid.sh times out and fails when ADB never becomes ready" "expected nonzero exit"
echo "$TIMEOUT_OUTPUT" | grep -qi "timed out\|timeout" && pass "ADB-ready timeout message mentions timeout" \
  || fail "ADB-ready timeout message mentions timeout" "no timeout wording found"

# =====================================================================
# GROUP 18: stop removes/stops container but preserves data
# =====================================================================
echo ""
echo "=== Group 18: stop preserves data ==="

DOCKER_LOG_G18="$_CONTRACT_TMP/docker-g18.log"
: > "$DOCKER_LOG_G18"
DATA_DIR_G18="$_CONTRACT_TMP/state-g18/ui-diff-mcp/redroid-data"
mkdir -p "$DATA_DIR_G18"
printf 'sentinel' > "$DATA_DIR_G18/SENTINEL"
(
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_REDROID_DATA_DIR="$DATA_DIR_G18"
  export FAKE_DOCKER_CONTAINER_STATE=running
  export DOCKER_CALL_LOG="$DOCKER_LOG_G18"
  bash "$STOP_SH" >/dev/null 2>&1
) || true
assert_contains "stop invokes docker stop" "$(cat "$DOCKER_LOG_G18")" "stop"
assert_contains "stop invokes docker rm" "$(cat "$DOCKER_LOG_G18")" "rm"
assert_file_exists "stop preserves the data directory sentinel" "$DATA_DIR_G18/SENTINEL"

# =====================================================================
# GROUP 19: stop is a safe no-op when the container is already absent
# =====================================================================
echo ""
echo "=== Group 19: stop no-op when container absent ==="

DOCKER_LOG_G19="$_CONTRACT_TMP/docker-g19.log"
: > "$DOCKER_LOG_G19"
(
  export PATH="$ROOT_PRIV_PATH"
  export FAKE_DOCKER_CONTAINER_STATE=absent
  export DOCKER_CALL_LOG="$DOCKER_LOG_G19"
  bash "$STOP_SH" >/dev/null 2>&1
) && pass "stop no-op when container absent exits 0" \
  || fail "stop no-op when container absent exits 0" "nonzero exit"
assert_not_contains "stop no-op never calls docker stop" "$(cat "$DOCKER_LOG_G19")" "stop"
assert_not_contains "stop no-op never calls docker rm" "$(cat "$DOCKER_LOG_G19")" "rm"

# =====================================================================
# GROUP 20: reset without --yes refuses
# =====================================================================
echo ""
echo "=== Group 20: reset without --yes refuses ==="

DOCKER_LOG_G20="$_CONTRACT_TMP/docker-g20.log"
: > "$DOCKER_LOG_G20"
DATA_DIR_G20="$_CONTRACT_TMP/state-g20/ui-diff-mcp/redroid-data"
mkdir -p "$DATA_DIR_G20"
printf 'sentinel' > "$DATA_DIR_G20/SENTINEL"
REFUSE_OUTPUT=$(
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_REDROID_DATA_DIR="$DATA_DIR_G20"
  export DOCKER_CALL_LOG="$DOCKER_LOG_G20"
  bash "$RESET_SH" 2>&1
)
REFUSE_EXIT=$?
[ "$REFUSE_EXIT" -ne 0 ] && pass "reset without --yes exits nonzero" \
  || fail "reset without --yes exits nonzero" "expected nonzero exit"
echo "$REFUSE_OUTPUT" | grep -qi "yes\|confirm" && pass "reset-without-yes message mentions confirmation" \
  || fail "reset-without-yes message mentions confirmation" "no confirmation wording found"
assert_file_empty "reset without --yes never touches docker" "$DOCKER_LOG_G20"
assert_file_exists "reset without --yes leaves data untouched" "$DATA_DIR_G20/SENTINEL"

# =====================================================================
# GROUP 21: reset --yes wipes only the validated data dir and restarts
# =====================================================================
echo ""
echo "=== Group 21: reset --yes wipes data and restarts ==="

DOCKER_LOG_G21="$_CONTRACT_TMP/docker-g21.log"
: > "$DOCKER_LOG_G21"
DOCKER_STATE_G21="$_CONTRACT_TMP/docker-g21.state"
printf 'running' > "$DOCKER_STATE_G21"
SYSROOT_G21="$_CONTRACT_TMP/sys-g21"
DEVROOT_G21="$_CONTRACT_TMP/dev-g21"
_make_valid_sysfs "$SYSROOT_G21"
mkdir -p "$DEVROOT_G21"
DATA_DIR_G21="$_CONTRACT_TMP/state-g21/ui-diff-mcp/redroid-data"
mkdir -p "$DATA_DIR_G21"
printf 'sentinel' > "$DATA_DIR_G21/SENTINEL"
RESET_YES_OUTPUT=$(
  export PATH="$ROOT_PRIV_PATH"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$SYSROOT_G21"
  export UI_DIFF_DEV_ROOT="$DEVROOT_G21"
  export UI_DIFF_REDROID_DATA_DIR="$DATA_DIR_G21"
  export FAKE_DOCKER_CONTAINER_STATE=running
  export FAKE_DOCKER_STATE_FILE="$DOCKER_STATE_G21"
  export DOCKER_CALL_LOG="$DOCKER_LOG_G21" MKNOD_CALL_LOG="$_CONTRACT_TMP/mknod-g21.log"
  bash "$RESET_SH" --yes 2>&1
)
RESET_YES_EXIT=$?
[ "$RESET_YES_EXIT" -eq 0 ] && pass "reset --yes exits 0" \
  || fail "reset --yes exits 0" "nonzero exit: $RESET_YES_EXIT / $RESET_YES_OUTPUT"
assert_file_absent "reset --yes removes the old sentinel file" "$DATA_DIR_G21/SENTINEL"
assert_file_exists "reset --yes recreates the data directory" "$DATA_DIR_G21"
[ ! -L "$DATA_DIR_G21" ] && pass "reset --yes recreates a real directory rather than a symlink" \
  || fail "reset --yes recreates a real directory rather than a symlink" "data directory is a symlink"
assert_contains "reset --yes stops the old container" "$(cat "$DOCKER_LOG_G21")" "stop"
assert_contains "reset --yes starts a fresh container" "$(cat "$DOCKER_LOG_G21")" "run -d"
assert_log_order "reset --yes orders stop, removal, and fresh launch" "$DOCKER_LOG_G21" "stop ui-diff-redroid" "rm ui-diff-redroid" "run -d"
[ "$(cat "$DOCKER_STATE_G21")" = "running" ] && pass "reset --yes leaves the replacement container running" \
  || fail "reset --yes leaves the replacement container running" "final fake Docker state: $(cat "$DOCKER_STATE_G21")"

# =====================================================================
# GROUP 22: reset rejects dangerous/invalid data-dir paths
# =====================================================================
echo ""
echo "=== Group 22: validate_safe_data_dir rejects dangerous paths ==="

(
  source "$COMMON_SH"
  validate_safe_data_dir "" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "validate_safe_data_dir rejects empty path" "did not reject" \
  || pass "validate_safe_data_dir rejects empty path"

(
  source "$COMMON_SH"
  validate_safe_data_dir "/" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "validate_safe_data_dir rejects root path" "did not reject" \
  || pass "validate_safe_data_dir rejects root path"

(
  source "$COMMON_SH"
  validate_safe_data_dir "relative/redroid-data" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "validate_safe_data_dir rejects relative path" "did not reject" \
  || pass "validate_safe_data_dir rejects relative path"

(
  source "$COMMON_SH"
  validate_safe_data_dir "/tmp/some/unrelated/dir" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "validate_safe_data_dir rejects wrong basename" "did not reject" \
  || pass "validate_safe_data_dir rejects wrong basename"

(
  source "$COMMON_SH"
  validate_safe_data_dir "/redroid-data" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "validate_safe_data_dir rejects shallow path" "did not reject" \
  || pass "validate_safe_data_dir rejects shallow path"

(
  source "$COMMON_SH"
  validate_safe_data_dir "/tmp/./state/ui-diff-mcp/redroid-data" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "validate_safe_data_dir rejects dot path components" "did not reject" \
  || pass "validate_safe_data_dir rejects dot path components"

SYMLINK_PARENT="$_CONTRACT_TMP/symlink-parent"
SYMLINK_TARGET="$_CONTRACT_TMP/symlink-target"
mkdir -p "$SYMLINK_TARGET/ui-diff-mcp"
ln -s "$SYMLINK_TARGET" "$SYMLINK_PARENT"
(
  source "$COMMON_SH"
  validate_safe_data_dir "$SYMLINK_PARENT/ui-diff-mcp/redroid-data" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "validate_safe_data_dir rejects symlink parent escape" "did not reject" \
  || pass "validate_safe_data_dir rejects symlink parent escape"

SAFE_DATA_PARENT="$_CONTRACT_TMP/safe-state/ui-diff-mcp"
mkdir -p "$SAFE_DATA_PARENT"
ln -s "$SYMLINK_TARGET" "$SAFE_DATA_PARENT/redroid-data"
(
  source "$COMMON_SH"
  validate_safe_data_dir "$SAFE_DATA_PARENT/redroid-data" 2>/dev/null
  echo "SHOULD_NOT_REACH"
) 2>/dev/null | grep -q "SHOULD_NOT_REACH" \
  && fail "validate_safe_data_dir rejects data-dir symlink escape" "did not reject" \
  || pass "validate_safe_data_dir rejects data-dir symlink escape"

(
  source "$COMMON_SH"
  validate_safe_data_dir "/home/agent-runner/.local/state/ui-diff-mcp/redroid-data" 2>/dev/null
  echo "CORRECTLY_ACCEPTED"
) 2>/dev/null | grep -q "CORRECTLY_ACCEPTED" \
  && pass "validate_safe_data_dir accepts the default-shaped path" \
  || fail "validate_safe_data_dir accepts the default-shaped path" "rejected a valid path"

# =====================================================================
# GROUP 23: script structure checks
# =====================================================================
echo ""
echo "=== Group 23: script structure ==="

for f_label_pair in "$START_SH:start-redroid.sh" "$STOP_SH:stop-redroid.sh" "$RESET_SH:reset-redroid.sh"; do
  f="${f_label_pair%%:*}"
  label="${f_label_pair#*:}"
  grep -q "set -euo pipefail" "$f" && pass "$label uses set -euo pipefail" \
    || fail "$label uses set -euo pipefail" "missing strict mode"
  grep -q "REPO_ROOT" "$f" && pass "$label resolves REPO_ROOT" \
    || fail "$label resolves REPO_ROOT" "no REPO_ROOT"
  [ -x "$f" ] && pass "$label is executable" \
    || fail "$label is executable" "not executable"
done

# =====================================================================
# GROUP 24: ARM64 architecture guard
# =====================================================================
echo ""
echo "=== Group 24: ARM64 architecture guard ==="

for machine in aarch64 arm64; do
  ARCH_OUTPUT=$( 
    export PATH="$ROOT_PRIV_PATH"
    export FAKE_UNAME_MACHINE="$machine"
    export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
    export UI_DIFF_SYS_ROOT="$_CONTRACT_TMP/sys-arch-$machine"
    export UI_DIFF_DEV_ROOT="$_CONTRACT_TMP/dev-arch-$machine"
    export UI_DIFF_REDROID_DATA_DIR="$_CONTRACT_TMP/state-arch-$machine/ui-diff-mcp/redroid-data"
    export DOCKER_CALL_LOG="$_CONTRACT_TMP/docker-arch-$machine.log" MKNOD_CALL_LOG="$_CONTRACT_TMP/mknod-arch-$machine.log"
    _make_valid_sysfs "$UI_DIFF_SYS_ROOT"
    mkdir -p "$UI_DIFF_DEV_ROOT"
    bash "$START_SH" 2>&1
  )
  ARCH_EXIT=$?
  assert_exit_zero "start-redroid.sh accepts $machine" "$ARCH_EXIT" "$ARCH_OUTPUT"
done

DOCKER_LOG_G24="$_CONTRACT_TMP/docker-g24.log"
: > "$DOCKER_LOG_G24"
X86_OUTPUT=$( 
  export PATH="$ROOT_PRIV_PATH"
  export FAKE_UNAME_MACHINE="x86_64"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export DOCKER_CALL_LOG="$DOCKER_LOG_G24"
  bash "$START_SH" 2>&1
)
X86_EXIT=$?
[ "$X86_EXIT" -ne 0 ] && pass "start-redroid.sh rejects x86_64" \
  || fail "start-redroid.sh rejects x86_64" "expected nonzero exit: $X86_OUTPUT"
echo "$X86_OUTPUT" | grep -qi "arm64\|aarch64\|architecture" \
  && pass "x86_64 rejection explains the ARM64 requirement" \
  || fail "x86_64 rejection explains the ARM64 requirement" "missing architecture remediation: $X86_OUTPUT"
assert_not_contains "x86_64 rejection never invokes docker run" "$(cat "$DOCKER_LOG_G24")" "run"

# =====================================================================
# GROUP 25: binder kernel-config preflight
# =====================================================================
echo ""
echo "=== Group 25: binder kernel-config preflight ==="

KERNEL_CONFIG_PASS="$_CONTRACT_TMP/kernel-config-pass-g25"
printf 'CONFIG_ANDROID_BINDER_IPC=y\nCONFIG_ANDROID_BINDER_DEVICES="binder,hwbinder,vndbinder"\n' > "$KERNEL_CONFIG_PASS"
PASS_OUTPUT=$( 
  export PATH="$ROOT_PRIV_PATH"
  export FAKE_UNAME_MACHINE="aarch64"
  export UI_DIFF_KERNEL_CONFIG="$KERNEL_CONFIG_PASS"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$_CONTRACT_TMP/sys-pass-g25"
  export UI_DIFF_DEV_ROOT="$_CONTRACT_TMP/dev-pass-g25"
  export UI_DIFF_REDROID_DATA_DIR="$_CONTRACT_TMP/state-pass-g25/ui-diff-mcp/redroid-data"
  export DOCKER_CALL_LOG="$_CONTRACT_TMP/docker-pass-g25.log" MKNOD_CALL_LOG="$_CONTRACT_TMP/mknod-pass-g25.log"
  _make_valid_sysfs "$UI_DIFF_SYS_ROOT"
  mkdir -p "$UI_DIFF_DEV_ROOT"
  bash "$START_SH" 2>&1
)
PASS_EXIT=$?
assert_exit_zero "valid binder kernel config permits start" "$PASS_EXIT" "$PASS_OUTPUT"

KERNEL_CONFIG_DISABLED="$_CONTRACT_TMP/kernel-config-disabled-g25"
printf 'CONFIG_ANDROID_BINDER_IPC=n\nCONFIG_ANDROID_BINDER_DEVICES="binder,hwbinder,vndbinder"\n' > "$KERNEL_CONFIG_DISABLED"
MKNOD_LOG_G25_DISABLED="$_CONTRACT_TMP/mknod-disabled-g25.log"
DOCKER_LOG_G25_DISABLED="$_CONTRACT_TMP/docker-disabled-g25.log"
: > "$MKNOD_LOG_G25_DISABLED"
: > "$DOCKER_LOG_G25_DISABLED"
DISABLED_OUTPUT=$( 
  export PATH="$ROOT_PRIV_PATH"
  export FAKE_UNAME_MACHINE="aarch64"
  export UI_DIFF_KERNEL_CONFIG="$KERNEL_CONFIG_DISABLED"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$_CONTRACT_TMP/sys-disabled-g25"
  export UI_DIFF_DEV_ROOT="$_CONTRACT_TMP/dev-disabled-g25"
  export DOCKER_CALL_LOG="$DOCKER_LOG_G25_DISABLED" MKNOD_CALL_LOG="$MKNOD_LOG_G25_DISABLED"
  _make_valid_sysfs "$UI_DIFF_SYS_ROOT"
  mkdir -p "$UI_DIFF_DEV_ROOT"
  bash "$START_SH" 2>&1
)
DISABLED_EXIT=$?
[ "$DISABLED_EXIT" -ne 0 ] && pass "disabled binder IPC config fails closed" \
  || fail "disabled binder IPC config fails closed" "expected nonzero exit: $DISABLED_OUTPUT"
echo "$DISABLED_OUTPUT" | grep -q "CONFIG_ANDROID_BINDER_IPC" \
  && pass "disabled binder IPC message names the required config" \
  || fail "disabled binder IPC message names the required config" "missing config remediation: $DISABLED_OUTPUT"
assert_file_empty "disabled binder IPC never invokes mknod" "$MKNOD_LOG_G25_DISABLED"
assert_not_contains "disabled binder IPC never runs docker" "$(cat "$DOCKER_LOG_G25_DISABLED")" "run"

KERNEL_CONFIG_MISSING_DEVICE="$_CONTRACT_TMP/kernel-config-missing-device-g25"
printf 'CONFIG_ANDROID_BINDER_IPC=y\nCONFIG_ANDROID_BINDER_DEVICES="binder,hwbinder"\n' > "$KERNEL_CONFIG_MISSING_DEVICE"
MKNOD_LOG_G25_MISSING="$_CONTRACT_TMP/mknod-missing-g25.log"
DOCKER_LOG_G25_MISSING="$_CONTRACT_TMP/docker-missing-g25.log"
: > "$MKNOD_LOG_G25_MISSING"
: > "$DOCKER_LOG_G25_MISSING"
MISSING_OUTPUT=$( 
  export PATH="$ROOT_PRIV_PATH"
  export FAKE_UNAME_MACHINE="aarch64"
  export UI_DIFF_KERNEL_CONFIG="$KERNEL_CONFIG_MISSING_DEVICE"
  export UI_DIFF_ADB_BIN="$FAKE_ADB_FULL"
  export UI_DIFF_SYS_ROOT="$_CONTRACT_TMP/sys-missing-g25"
  export UI_DIFF_DEV_ROOT="$_CONTRACT_TMP/dev-missing-g25"
  export DOCKER_CALL_LOG="$DOCKER_LOG_G25_MISSING" MKNOD_CALL_LOG="$MKNOD_LOG_G25_MISSING"
  _make_valid_sysfs "$UI_DIFF_SYS_ROOT"
  mkdir -p "$UI_DIFF_DEV_ROOT"
  bash "$START_SH" 2>&1
)
MISSING_EXIT=$?
[ "$MISSING_EXIT" -ne 0 ] && pass "missing binder device config fails closed" \
  || fail "missing binder device config fails closed" "expected nonzero exit: $MISSING_OUTPUT"
echo "$MISSING_OUTPUT" | grep -q "CONFIG_ANDROID_BINDER_DEVICES\|vndbinder" \
  && pass "missing binder device message names the required devices" \
  || fail "missing binder device message names the required devices" "missing device remediation: $MISSING_OUTPUT"
assert_file_empty "missing binder device config never invokes mknod" "$MKNOD_LOG_G25_MISSING"
assert_not_contains "missing binder device config never runs docker" "$(cat "$DOCKER_LOG_G25_MISSING")" "run"

grep -q '/boot/config-.*uname -r' "$START_SH" || grep -q '/boot/config-.*uname -r' "$COMMON_SH" \
  && pass "kernel preflight documents the uname-based fallback config path" \
  || fail "kernel preflight documents the uname-based fallback config path" "fallback path expression missing"

# =====================================================================
# Summary
# =====================================================================
echo ""
echo "================================================================"
printf "Shell contract tests: %d run, %d passed, %d failed\n" "$TESTS_RUN" "$PASS" "$FAIL"
echo "================================================================"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
