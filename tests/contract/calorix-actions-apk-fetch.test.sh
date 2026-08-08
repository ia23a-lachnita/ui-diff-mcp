#!/usr/bin/env bash
# Contract tests for scripts/fetch-calorix-actions-apk.sh. All GitHub access
# is faked through PATH; this suite never contacts the network.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/fetch-calorix-actions-apk.sh"
SHA="1f538641f5e5f5c4a48c95cdfb97462838187106"
ALT_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
PASS=0
FAIL=0
RUN=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { PASS=$((PASS + 1)); RUN=$((RUN + 1)); printf '  PASS %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); RUN=$((RUN + 1)); printf '  FAIL %s: %s\n' "$1" "$2"; }
assert_status() { if [ "$2" -eq "$3" ]; then pass "$1"; else fail "$1" "expected exit $3, got $2: $4"; fi; }
assert_contains() { if printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1" "missing '$3': $2"; fi; }
assert_absent() { if [ ! -e "$2" ] && [ ! -L "$2" ]; then pass "$1"; else fail "$1" "unexpected path $2"; fi; }
assert_file() { if [ -f "$2" ]; then pass "$1"; else fail "$1" "missing file $2"; fi; }
assert_empty() { if [ ! -s "$2" ]; then pass "$1"; else fail "$1" "expected empty file $2"; fi; }

FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/gh" <<'GHEOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${GH_LOG:?}"
case "$1" in
  api)
    [ "${2:-}" = "--method" ] && [ "${3:-}" = "GET" ] || { echo 'API must use GET' >&2; exit 91; }
    cat "${GH_RUNS_JSON:?}"
    ;;
  run)
    [ "${2:-}" = "download" ] || { echo 'unexpected gh run command' >&2; exit 92; }
    [ "${3:-}" = "${EXPECTED_RUN_ID:?}" ] || { echo 'run id was not numeric expected id' >&2; exit 93; }
    [ "${4:-}" = "--repo" ] && [ "${6:-}" = "--name" ] && [ "${8:-}" = "--dir" ] || { echo 'bad download arguments' >&2; exit 94; }
    [ "${7:-}" = "${EXPECTED_ARTIFACT:?}" ] || { echo 'wrong artifact name' >&2; exit 95; }
    [ "${GH_DOWNLOAD_FAIL:-0}" = 0 ] || exit 96
    target="$9"
    mkdir -p "$target"
    write_versioned_artifact() {
      checksum_target="$1"
      apk="$target/calorix-1.0.0+1-android-release.apk"
      checksum="$target/calorix-1.0.0+1-android-release.apk.sha256"
      printf 'versioned apk bytes for checksum target contract\n' > "$apk"
      digest="$(sha256sum "$apk" | awk '{print $1}')"
      printf '%s  %s\n' "$digest" "$checksum_target" > "$checksum"
    }
    case "${GH_ARTIFACT_MODE:-good}" in
      good)
        printf 'apk bytes for contract test\n' > "$target/calorix-1.2.3-android-release.apk"
        sha256sum "$target/calorix-1.2.3-android-release.apk" | sed 's#  .*#  calorix-1.2.3-android-release.apk#' > "$target/calorix-1.2.3-android-release.apk.sha256"
        ;;
      checksum_mismatch)
        printf 'apk bytes for contract test\n' > "$target/calorix-1.2.3-android-release.apk"
        printf '%064d  calorix-1.2.3-android-release.apk\n' 0 > "$target/calorix-1.2.3-android-release.apk.sha256"
        ;;
      checksum_malformed)
        printf 'apk bytes for contract test\n' > "$target/calorix-1.2.3-android-release.apk"
        printf 'not a checksum\n' > "$target/calorix-1.2.3-android-release.apk.sha256"
        ;;
      checksum_multiline)
        printf 'apk bytes for contract test\n' > "$target/calorix-1.2.3-android-release.apk"
        sha256sum "$target/calorix-1.2.3-android-release.apk" | sed 's#  .*#  calorix-1.2.3-android-release.apk#' > "$target/calorix-1.2.3-android-release.apk.sha256"
        printf 'extra checksum line\n' >> "$target/calorix-1.2.3-android-release.apk.sha256"
        ;;
      checksum_dist_safe) write_versioned_artifact 'dist/calorix-1.0.0+1-android-release.apk' ;;
      checksum_parent_traversal) write_versioned_artifact '../calorix-1.0.0+1-android-release.apk' ;;
      checksum_absolute) write_versioned_artifact '/absolute/calorix-1.0.0+1-android-release.apk' ;;
      checksum_embedded_traversal) write_versioned_artifact 'dist/../calorix-1.0.0+1-android-release.apk' ;;
      checksum_backslash) write_versioned_artifact 'dist\calorix-1.0.0+1-android-release.apk' ;;
      checksum_different_basename) write_versioned_artifact 'dist/different-android-release.apk' ;;
      extra) printf x > "$target/calorix-1.2.3-android-release.apk"; printf x > "$target/calorix-1.2.3-android-release.apk.sha256"; printf x > "$target/unexpected.txt" ;;
      missing) printf x > "$target/calorix-1.2.3-android-release.apk" ;;
      symlink) printf x > "$target/calorix-1.2.3-android-release.apk"; ln -s calorix-1.2.3-android-release.apk "$target/calorix-1.2.3-android-release.apk.sha256" ;;
      nested) mkdir -p "$target/nested"; printf x > "$target/nested/calorix-1.2.3-android-release.apk"; printf x > "$target/nested/calorix-1.2.3-android-release.apk.sha256" ;;
    esac
    ;;
  *) echo "unexpected gh command: $*" >&2; exit 90 ;;
esac
GHEOF
chmod +x "$FAKE_BIN/gh"

write_runs() {
  cat > "$TMP/runs.json" <<EOF
{"workflow_runs":[${1}]}
EOF
}
good_run() { printf '{"id":31182023073,"head_sha":"%s","name":"Build Android APK","path":".github/workflows/android-build.yml","conclusion":"success","status":"completed"}' "$1"; }

run_fetch() {
  local output="$1"; shift
  : > "$TMP/gh.log"
  GH_LOG="$TMP/gh.log" GH_RUNS_JSON="$TMP/runs.json" EXPECTED_RUN_ID=31182023073 EXPECTED_ARTIFACT="${EXPECTED_ARTIFACT_OVERRIDE:-android-apk-${SHA}}" \
    TMPDIR="$TMP/script-tmp" PATH="$FAKE_BIN:$PATH" "$SCRIPT" --repo ia23a-lachnita/calorix --source-sha "$SHA" --source-clean --output "$output" "$@" >"$TMP/command.out" 2>&1
  FETCH_STATUS=$?
  FETCH_OUTPUT="$(cat "$TMP/command.out")"
}

# RED contract: before implementation, the absent script exits 127 and leaves
# no output. Once it exists, execute the complete GREEN contract below.
if [ ! -x "$SCRIPT" ]; then
  write_runs "$(good_run "$SHA")"
  run_fetch "$TMP/out/app release.apk"
  assert_status 'absent script fails RED' "$FETCH_STATUS" 127 "$FETCH_OUTPUT"
  assert_absent 'RED leaves no output' "$TMP/out/app release.apk"
else
  mkdir -p "$TMP/out" "$TMP/script-tmp"
  write_runs "$(good_run "$SHA")"

  : > "$TMP/gh.log"
  GH_LOG="$TMP/gh.log" GH_RUNS_JSON="$TMP/runs.json" PATH="$FAKE_BIN:$PATH" "$SCRIPT" --repo ia23a-lachnita/calorix --source-sha "" --source-clean --output "$TMP/out/genuine-empty.apk" >"$TMP/command.out" 2>&1; status=$?
  assert_status 'genuine empty source SHA rejects' "$status" 1 "$(cat "$TMP/command.out")"
  assert_contains 'genuine empty source SHA reason' "$(cat "$TMP/command.out")" 'Missing value for --source-sha.'
  assert_empty 'genuine empty source SHA makes no gh call' "$TMP/gh.log"
  assert_absent 'genuine empty source SHA leaves no APK' "$TMP/out/genuine-empty.apk"
  assert_absent 'genuine empty source SHA leaves no verification record' "$TMP/out/genuine-empty.apk.verified.json"

  run_fetch "$TMP/out/empty.apk" --source-sha ''
  assert_status 'duplicate source SHA is rejected' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"

  GH_LOG="$TMP/gh.log" GH_RUNS_JSON="$TMP/runs.json" PATH="$FAKE_BIN:$PATH" "$SCRIPT" --repo ia23a-lachnita/calorix --source-sha "$SHA" --output "$TMP/out/no-clean.apk" >"$TMP/command.out" 2>&1; status=$?
  assert_status 'missing clean proof rejects' "$status" 1 "$(cat "$TMP/command.out")"
  assert_contains 'missing clean proof reason' "$(cat "$TMP/command.out")" 'uncommitted_source'

  GH_LOG="$TMP/gh.log" GH_RUNS_JSON="$TMP/runs.json" PATH="$FAKE_BIN:$PATH" "$SCRIPT" --repo ia23a-lachnita/calorix --source-sha "$SHA" --source-dirty --output "$TMP/out/dirty.apk" >"$TMP/command.out" 2>&1; status=$?
  assert_status 'dirty source rejects' "$status" 1 "$(cat "$TMP/command.out")"
  assert_contains 'dirty source reason' "$(cat "$TMP/command.out")" 'uncommitted_source'

  write_runs "$(good_run "$ALT_SHA")"
  run_fetch "$TMP/out/mismatch.apk"
  assert_status 'workflow SHA mismatch rejects' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"
  assert_absent 'source mismatch leaves no output' "$TMP/out/mismatch.apk"

  write_runs "$(good_run "$SHA")"
  GH_ARTIFACT_MODE=checksum_mismatch run_fetch "$TMP/out/mismatch-digest.apk"
  assert_status 'checksum mismatch rejects' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"
  assert_contains 'checksum mismatch reason' "$FETCH_OUTPUT" 'checksum_mismatch'

  GH_ARTIFACT_MODE=checksum_malformed run_fetch "$TMP/out/malformed-digest.apk"
  assert_status 'malformed checksum rejects' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"
  assert_contains 'malformed checksum reason' "$FETCH_OUTPUT" 'malformed_expected_sha256'
  GH_ARTIFACT_MODE=checksum_multiline run_fetch "$TMP/out/multiline-digest.apk"
  assert_status 'multi-line checksum rejects' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"
  assert_contains 'multi-line checksum reason' "$FETCH_OUTPUT" 'malformed_expected_sha256'

  GH_ARTIFACT_MODE=checksum_dist_safe run_fetch "$TMP/out/dist-safe.apk"
  assert_status 'safe dist checksum target accepts flattened artifact' "$FETCH_STATUS" 0 "$FETCH_OUTPUT"
  assert_file 'safe dist checksum target writes APK' "$TMP/out/dist-safe.apk"

  for path_mode in checksum_parent_traversal checksum_absolute checksum_embedded_traversal checksum_backslash checksum_different_basename; do
    GH_ARTIFACT_MODE="$path_mode" run_fetch "$TMP/out/$path_mode.apk"
    assert_status "$path_mode checksum target rejects" "$FETCH_STATUS" 1 "$FETCH_OUTPUT"
    assert_contains "$path_mode checksum target reason" "$FETCH_OUTPUT" 'malformed_expected_sha256'
  done

  for mode in extra missing symlink nested; do
    GH_ARTIFACT_MODE="$mode" run_fetch "$TMP/out/$mode.apk"
    assert_status "artifact $mode rejects" "$FETCH_STATUS" 1 "$FETCH_OUTPUT"
    assert_contains "artifact $mode reason" "$FETCH_OUTPUT" 'artifact_file_count_invalid'
  done

  write_runs ''
  run_fetch "$TMP/out/no-run.apk"
  assert_status 'no matching run rejects' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"
  write_runs "$(good_run "$SHA"),$(good_run "$SHA")"
  run_fetch "$TMP/out/many-run.apk"
  assert_status 'multiple matching runs reject' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"

  write_runs '{"id":31182023073,"head_sha":"'"$SHA"'","name":"Other","path":".github/workflows/android-build.yml","conclusion":"success","status":"completed"}'
  run_fetch "$TMP/out/wrong-name.apk"
  assert_status 'wrong workflow name rejects' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"
  write_runs '{"id":31182023073,"head_sha":"'"$SHA"'","name":"Build Android APK","path":".github/workflows/other.yml","conclusion":"success","status":"completed"}'
  run_fetch "$TMP/out/wrong-path.apk"
  assert_status 'wrong workflow path rejects' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"
  write_runs '{"id":31182023073,"head_sha":"'"$SHA"'","name":"Build Android APK","path":".github/workflows/android-build.yml","conclusion":"failure","status":"completed"}'
  run_fetch "$TMP/out/failed.apk"
  assert_status 'failed workflow rejects' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"

  write_runs "$(good_run "$SHA")"
  EXPECTED_ARTIFACT_OVERRIDE=other run_fetch "$TMP/out/wrong-artifact.apk" --artifact-name other
  assert_status 'wrong artifact name rejects' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"
  assert_contains 'wrong artifact name reason' "$FETCH_OUTPUT" 'wrong_artifact_name'
  GH_DOWNLOAD_FAIL=1 run_fetch "$TMP/out/download-failure.apk"
  assert_status 'download failure rejects' "$FETCH_STATUS" 1 "$FETCH_OUTPUT"

  GH_LOG="$TMP/gh.log" GH_RUNS_JSON="$TMP/runs.json" PATH="$FAKE_BIN:$PATH" "$SCRIPT" --repo ia23a-lachnita/calorix --source-sha "$SHA" --source-clean --output "$TMP/out/not-an-apk.txt" >"$TMP/command.out" 2>&1; status=$?
  assert_status 'invalid output extension rejects' "$status" 1 "$(cat "$TMP/command.out")"
  GH_LOG="$TMP/gh.log" GH_RUNS_JSON="$TMP/runs.json" PATH="$FAKE_BIN:$PATH" "$SCRIPT" --repo ia23a-lachnita/calorix --source-sha "$SHA" --source-clean --output "$TMP/out/unknown.apk" --unknown >"$TMP/command.out" 2>&1; status=$?
  assert_status 'unknown argument rejects' "$status" 1 "$(cat "$TMP/command.out")"
  GH_LOG="$TMP/gh.log" GH_RUNS_JSON="$TMP/runs.json" PATH="$FAKE_BIN:$PATH" "$SCRIPT" --repo ia23a-lachnita/calorix --source-sha "$SHA" --source-clean --artifact-name first --artifact-name second --output "$TMP/out/duplicate.apk" >"$TMP/command.out" 2>&1; status=$?
  assert_status 'duplicate argument rejects' "$status" 1 "$(cat "$TMP/command.out")"
  assert_contains 'duplicate argument message' "$(cat "$TMP/command.out")" 'Duplicate argument: --artifact-name'
  GH_LOG="$TMP/gh.log" GH_RUNS_JSON="$TMP/runs.json" PATH="$FAKE_BIN:$PATH" "$SCRIPT" --repo ia23a-lachnita/calorix --source-sha not-a-sha --source-clean --output "$TMP/out/bad-sha.apk" >"$TMP/command.out" 2>&1; status=$?
  assert_status 'malformed source SHA rejects' "$status" 1 "$(cat "$TMP/command.out")"
  assert_contains 'malformed source SHA reason' "$(cat "$TMP/command.out")" 'malformed_requested_source_sha'
  GH_LOG="$TMP/gh.log" GH_RUNS_JSON="$TMP/runs.json" PATH="$FAKE_BIN:$PATH" "$SCRIPT" --repo ia23a-lachnita/calorix --source-sha "$SHA" --source-clean --workflow other.yml --output "$TMP/out/wrong-workflow-arg.apk" >"$TMP/command.out" 2>&1; status=$?
  assert_status 'noncanonical workflow identifier rejects' "$status" 1 "$(cat "$TMP/command.out")"
  assert_contains 'noncanonical workflow identifier reason' "$(cat "$TMP/command.out")" 'wrong_workflow_path'

  run_fetch "$TMP/out/final app.apk"
  assert_status 'successful fixture fetch accepts' "$FETCH_STATUS" 0 "$FETCH_OUTPUT"
  assert_file 'success writes APK with spaces' "$TMP/out/final app.apk"
  assert_file 'success writes verification record' "$TMP/out/final app.apk.verified.json"
  node - "$TMP/out/final app.apk.verified.json" "$TMP/out/final app.apk" <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const [recordPath, apkPath] = process.argv.slice(2);
const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
const expectedDigest = crypto.createHash("sha256").update(fs.readFileSync(apkPath)).digest("hex");
function exact(condition, message) {
  if (!condition) throw new Error(message);
}
exact(typeof record.run_id === "number" && Number.isSafeInteger(record.run_id) && record.run_id === 31182023073, "run_id must be numeric 31182023073");
exact(record.workflow && typeof record.workflow === "object" && !Array.isArray(record.workflow), "workflow must be an object");
exact(record.workflow.name === "Build Android APK", "workflow.name mismatch");
exact(record.workflow.path === ".github/workflows/android-build.yml", "workflow.path mismatch");
exact(record.source_sha === "1f538641f5e5f5c4a48c95cdfb97462838187106", "source_sha mismatch");
exact(record.artifact_name === "android-apk-1f538641f5e5f5c4a48c95cdfb97462838187106", "artifact_name mismatch");
exact(record.apk_filename === "calorix-1.2.3-android-release.apk", "apk_filename mismatch");
exact(record.checksum_filename === "calorix-1.2.3-android-release.apk.sha256", "checksum_filename mismatch");
exact(typeof record.digest === "string" && /^[0-9a-f]{64}$/.test(record.digest), "digest must be lowercase SHA-256");
exact(record.digest === expectedDigest, "digest does not match output APK");
exact(Object.keys(record).sort().join(",") === "apk_filename,artifact_name,checksum_filename,digest,run_id,source_sha,workflow", "unexpected verification record fields");
exact(Object.keys(record.workflow).sort().join(",") === "name,path", "unexpected workflow fields");
NODE
  assert_status 'success writes exact typed verification metadata' "$?" 0 'verification JSON assertion failed'
  assert_contains 'API is explicitly GET' "$(cat "$TMP/gh.log")" 'api --method GET'
  assert_contains 'download uses numeric run id' "$(cat "$TMP/gh.log")" 'run download 31182023073'
  if find "$TMP/script-tmp" -mindepth 1 -print -quit | grep -q .; then fail 'temporary download directory is cleaned' 'temporary data remains'; else pass 'temporary download directory is cleaned'; fi

  : > "$TMP/gh.log"
  GH_LOG="$TMP/gh.log" GH_RUNS_JSON="$TMP/runs.json" EXPECTED_RUN_ID=31182023073 EXPECTED_ARTIFACT="android-apk-${SHA}" \
    PATH="$FAKE_BIN:$PATH" "$SCRIPT" --repo ia23a-lachnita/calorix --source-sha "${SHA^^}" --source-clean --output "$TMP/out/uppercase.apk" >"$TMP/command.out" 2>&1; status=$?
  assert_status 'uppercase source SHA normalizes before query' "$status" 0 "$(cat "$TMP/command.out")"

  NO_AWK_BIN="$TMP/no-awk-bin"
  mkdir -p "$NO_AWK_BIN"
  for command_name in bash basename cat cp dirname find grep mkdir mktemp mv node rm sed sha256sum sort; do
    ln -s "$(command -v "$command_name")" "$NO_AWK_BIN/$command_name"
  done
  ln -s "$FAKE_BIN/gh" "$NO_AWK_BIN/gh"
  : > "$TMP/gh.log"
  GH_LOG="$TMP/gh.log" GH_RUNS_JSON="$TMP/runs.json" EXPECTED_RUN_ID=31182023073 EXPECTED_ARTIFACT="android-apk-${SHA}" \
    PATH="$NO_AWK_BIN" "$SCRIPT" --repo ia23a-lachnita/calorix --source-sha "$SHA" --source-clean --output "$TMP/out/no-awk.apk" >"$TMP/command.out" 2>&1; status=$?
  assert_status 'missing awk fails dependency preflight' "$status" 1 "$(cat "$TMP/command.out")"
  assert_contains 'missing awk names required command' "$(cat "$TMP/command.out")" "Required command 'awk' not found on PATH."
  assert_empty 'missing awk fails before gh call' "$TMP/gh.log"
fi

printf '\n%d run, %d passed, %d failed\n' "$RUN" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
