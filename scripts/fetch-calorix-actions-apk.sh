#!/usr/bin/env bash
# Fetch one verified Calorix Android APK from an immutable Actions run.
# The caller, not this script, attests that the requested source SHA is clean.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_FILE="$SCRIPT_DIR/lib/calorix-actions-apk-policy.mjs"
EXPECTED_WORKFLOW_NAME="Build Android APK"
EXPECTED_WORKFLOW_PATH=".github/workflows/android-build.yml"

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command '$1' not found on PATH."
}

usage() {
  cat <<'EOF'
Usage:
  fetch-calorix-actions-apk.sh --repo OWNER/REPO --source-sha SHA --source-clean \
    --output PATH.apk [--workflow android-build.yml] [--artifact-name android-apk-SHA]

The source-clean flag is an affirmative caller attestation. This script does
not inspect a local checkout; omit it (or pass --source-dirty) to reject with
uncommitted_source rather than labelling an APK as current evidence.
EOF
}

repo=""
source_sha=""
source_clean="false"
workflow="android-build.yml"
artifact_name=""
output=""

seen_repo=0
seen_sha=0
seen_clean=0
seen_workflow=0
seen_artifact=0
seen_output=0

require_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || fail "Missing value for $1."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      [ "$seen_repo" -eq 0 ] || fail "Duplicate argument: --repo"
      require_value "$@"; repo="$2"; seen_repo=1; shift 2 ;;
    --source-sha)
      [ "$seen_sha" -eq 0 ] || fail "Duplicate argument: --source-sha"
      require_value "$@"; source_sha="$2"; seen_sha=1; shift 2 ;;
    --source-clean)
      [ "$seen_clean" -eq 0 ] || fail "Duplicate argument: --source-clean/--source-dirty"
      source_clean="true"; seen_clean=1; shift ;;
    --source-dirty)
      [ "$seen_clean" -eq 0 ] || fail "Duplicate argument: --source-clean/--source-dirty"
      source_clean="false"; seen_clean=1; shift ;;
    --workflow)
      [ "$seen_workflow" -eq 0 ] || fail "Duplicate argument: --workflow"
      require_value "$@"; workflow="$2"; seen_workflow=1; shift 2 ;;
    --artifact-name)
      [ "$seen_artifact" -eq 0 ] || fail "Duplicate argument: --artifact-name"
      require_value "$@"; artifact_name="$2"; seen_artifact=1; shift 2 ;;
    --output)
      [ "$seen_output" -eq 0 ] || fail "Duplicate argument: --output"
      require_value "$@"; output="$2"; seen_output=1; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

[ "$seen_repo" -eq 1 ] || fail "Missing required argument: --repo"
[ "$seen_sha" -eq 1 ] || fail "malformed_requested_source_sha"
[ "$seen_output" -eq 1 ] || fail "Missing required argument: --output"

if ! [[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
  fail "Invalid --repo; expected OWNER/REPO."
fi
if ! [[ "$source_sha" =~ ^[[:xdigit:]]{40}$ ]]; then
  fail "malformed_requested_source_sha"
fi
source_sha="${source_sha,,}"
if [ "$source_clean" != "true" ]; then
  fail "uncommitted_source"
fi
if ! [[ "$workflow" =~ ^[A-Za-z0-9._-]+\.ya?ml$ ]]; then
  fail "Invalid --workflow value."
fi
if [ "$workflow" != "android-build.yml" ]; then
  fail "wrong_workflow_path"
fi
if [ -z "$artifact_name" ]; then
  artifact_name="android-apk-${source_sha}"
fi
if [[ "$artifact_name" == */* || "$artifact_name" == *\\* || "$artifact_name" == *".."* ]] || [ -z "$artifact_name" ]; then
  fail "Invalid --artifact-name value."
fi
if [[ "$output" != *.apk || "$output" == *$'\n'* || "$output" == *$'\r'* ]]; then
  fail "--output must name an .apk file."
fi
output_dir="$(dirname "$output")"
output_base="$(basename "$output")"
if [[ "$output_base" == ".apk" || "$output_base" == *".."* ]] || [ ! -d "$output_dir" ]; then
  fail "Invalid --output path; its existing parent directory and a safe .apk basename are required."
fi
output_dir="$(cd -P "$output_dir" && pwd)"
output="$output_dir/$output_base"
verified_output="${output}.verified.json"
if [ -e "$output" ] || [ -L "$output" ] || [ -e "$verified_output" ] || [ -L "$verified_output" ]; then
  fail "Refusing to overwrite existing output or verification record."
fi

for cmd in gh node sha256sum mktemp find cp mv awk; do require_cmd "$cmd"; done
[ -f "$POLICY_FILE" ] || fail "Missing policy helper: $POLICY_FILE"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/ui-diff-calorix-apk.XXXXXX")"
output_tmp=""
verified_tmp=""
publish_complete=false
cleanup() {
  [ -n "$output_tmp" ] && rm -f -- "$output_tmp"
  [ -n "$verified_tmp" ] && rm -f -- "$verified_tmp"
  if [ "$publish_complete" != "true" ]; then
    rm -f -- "$output" "$verified_output"
  fi
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

runs_json="$tmp_dir/runs.json"
query="repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${source_sha}&status=completed&per_page=100"
if ! gh api --method GET "$query" > "$runs_json"; then
  fail "workflow_run_query_failed"
fi

selection_json="$tmp_dir/selection.json"
if node - "$runs_json" "$source_sha" "$workflow" "$selection_json" <<'NODE'
const fs = require("fs");
const [runsPath, requestedSha, workflowIdentifier, outputPath] = process.argv.slice(2);
let parsed;
try { parsed = JSON.parse(fs.readFileSync(runsPath, "utf8")); } catch { process.exit(20); }
if (!parsed || !Array.isArray(parsed.workflow_runs)) process.exit(20);
const matches = parsed.workflow_runs.filter((run) =>
  run && typeof run === "object" &&
  run.head_sha === requestedSha &&
  run.status === "completed" &&
  run.conclusion === "success" &&
  run.name === "Build Android APK" &&
  run.path === ".github/workflows/android-build.yml"
);
if (matches.length !== 1) process.exit(21);
const run = matches[0];
if (!Number.isSafeInteger(run.id) || run.id <= 0) process.exit(20);
fs.writeFileSync(outputPath, JSON.stringify({
  run_id: run.id,
  source_sha: run.head_sha,
  workflow_name: run.name,
  workflow_path: run.path,
  requested_workflow: workflowIdentifier,
}));
NODE
then
  :
else
  node_status=$?
  if [ "$node_status" -eq 21 ]; then fail "workflow_run_not_unique_or_not_successful"; fi
  fail "workflow_run_query_invalid"
fi

run_id="$(node -e 'const x=require(process.argv[1]); process.stdout.write(String(x.run_id))' "$selection_json")"
case "$run_id" in ''|*[!0-9]*) fail "workflow_run_query_invalid" ;; esac

download_dir="$tmp_dir/download"
if ! gh run download "$run_id" --repo "$repo" --name "$artifact_name" --dir "$download_dir"; then
  fail "artifact_download_failed"
fi

mapfile -t artifact_entries < <(find "$download_dir" -mindepth 1 -printf '%y\t%P\n' | LC_ALL=C sort)
if [ "${#artifact_entries[@]}" -ne 2 ]; then fail "artifact_file_count_invalid"; fi
artifact_files=()
for entry in "${artifact_entries[@]}"; do
  kind="${entry%%$'\t'*}"
  name="${entry#*$'\t'}"
  [ "$kind" = "f" ] || fail "artifact_file_count_invalid"
  [[ "$name" != */* && "$name" != *\\* && "$name" != *".."* && "$name" != .* && -n "$name" ]] || fail "artifact_file_count_invalid"
  artifact_files+=("$name")
done

apk_filename=""
checksum_filename=""
for name in "${artifact_files[@]}"; do
  case "$name" in
    *.apk) apk_filename="$name" ;;
    *.apk.sha256) checksum_filename="$name" ;;
  esac
done
if [ -z "$apk_filename" ] || [ -z "$checksum_filename" ] || [ "$checksum_filename" != "${apk_filename}.sha256" ]; then
  fail "artifact_file_count_invalid"
fi

checksum_target_matches_apk() {
  local target="$1"
  local expected_basename="$2"
  local component=""
  local -a components=()

  case "$target" in
    ''|/*|[A-Za-z]:/*|*\\*|*//*|*/) return 1 ;;
  esac

  IFS='/' read -r -a components <<< "$target"
  for component in "${components[@]}"; do
    case "$component" in ''|.|..) return 1 ;; esac
  done

  [ "${target##*/}" = "$expected_basename" ]
}

checksum_line="$(cat "$download_dir/$checksum_filename")"
expected_sha256=""
if [[ "$checksum_line" != *$'\n'* ]] && [[ "$checksum_line" =~ ^([[:xdigit:]]{64})[[:space:]]{1,2}\*?([^[:space:]]+)$ ]]; then
  expected_sha256="${BASH_REMATCH[1],,}"
  checksum_target="${BASH_REMATCH[2]}"
  if ! checksum_target_matches_apk "$checksum_target" "$apk_filename"; then
    expected_sha256="invalid"
  fi
else
  expected_sha256="invalid"
fi
artifact_sha256="$(sha256sum "$download_dir/$apk_filename" | awk '{print tolower($1)}')"

decision_json="$tmp_dir/decision.json"
node - "$decision_json" "$source_sha" "$(node -e 'const x=require(process.argv[1]); process.stdout.write(x.source_sha)' "$selection_json")" "$artifact_name" "$apk_filename" "$checksum_filename" "$artifact_sha256" "$expected_sha256" <<'NODE'
const fs = require("fs");
const [out, requestedSourceSha, workflowSourceSha, artifactName, apk, checksum, artifactSha256, expectedSha256] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify({
  requestedSourceSha, workflowSourceSha, workingTreeClean: true,
  workflowConclusion: "success", workflowName: "Build Android APK",
  workflowPath: ".github/workflows/android-build.yml", artifactName,
  artifactFiles: [apk, checksum], artifactSha256, expectedSha256,
}));
NODE
decision="$(node --input-type=module - "$POLICY_FILE" "$decision_json" <<'NODE'
import fs from "node:fs";
import { pathToFileURL } from "node:url";
const [policyPath, inputPath] = process.argv.slice(2);
const { decideCalorixActionsApkFetch } = await import(pathToFileURL(policyPath).href);
process.stdout.write(JSON.stringify(decideCalorixActionsApkFetch(JSON.parse(fs.readFileSync(inputPath, "utf8")))));
NODE
)"
allowed="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.allowed === true))' "$decision")"
if [ "$allowed" != "true" ]; then
  reason="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(String(x.reason || "policy_rejected"))' "$decision")"
  fail "$reason"
fi

output_tmp="$(mktemp "$output_dir/.${output_base}.tmp.XXXXXX")"
verified_tmp="$(mktemp "$output_dir/.${output_base}.verified.tmp.XXXXXX")"
cp -- "$download_dir/$apk_filename" "$output_tmp"
node - "$verified_tmp" "$run_id" "$source_sha" "$artifact_name" "$apk_filename" "$checksum_filename" "$artifact_sha256" <<'NODE'
const fs = require("fs");
const [path, runId, sourceSha, artifactName, apkFilename, checksumFilename, digest] = process.argv.slice(2);
fs.writeFileSync(path, `${JSON.stringify({
  run_id: Number(runId),
  workflow: { name: "Build Android APK", path: ".github/workflows/android-build.yml" },
  source_sha: sourceSha.toLowerCase(), artifact_name: artifactName,
  apk_filename: apkFilename, checksum_filename: checksumFilename,
  digest: digest.toLowerCase(),
})}\n`);
NODE
mv -- "$output_tmp" "$output"
output_tmp=""
mv -- "$verified_tmp" "$verified_output"
verified_tmp=""
publish_complete=true
printf 'Verified Calorix APK written to %s (Actions run %s).\n' "$output" "$run_id"
