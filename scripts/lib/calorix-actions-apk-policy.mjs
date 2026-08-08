#!/usr/bin/env node

const EXPECTED_WORKFLOW_NAME = "Build Android APK";
const EXPECTED_WORKFLOW_PATH = ".github/workflows/android-build.yml";

function isString(v) {
  return typeof v === "string";
}

function isHexString(v, len) {
  if (!isString(v)) return false;
  if (v.length !== len) return false;
  return /^[0-9a-f]+$/i.test(v);
}

function toLowerHex(v) {
  return v.toLowerCase();
}

export function normalizeGitSha(value) {
  if (!isHexString(value, 40)) {
    throw new Error(`Invalid git SHA: expected exactly 40 hex characters, got ${JSON.stringify(value)}`);
  }
  return toLowerHex(value);
}

function validateArtifactFiles(files) {
  if (!Array.isArray(files)) return { valid: false, reason: "artifact_file_count_invalid" };
  if (files.length !== 2) return { valid: false, reason: "artifact_file_count_invalid" };
  for (const f of files) {
    if (!isString(f)) return { valid: false, reason: "artifact_file_count_invalid" };
    if (f.includes("/") || f.includes("\\") || f.includes("..") || f.startsWith(".")) {
      return { valid: false, reason: "artifact_file_count_invalid" };
    }
  }
  if (files[0] === files[1]) return { valid: false, reason: "artifact_file_count_invalid" };

  const sorted = [...files].sort();
  const apkFile = sorted.find((f) => f.endsWith(".apk"));
  const shaFile = sorted.find((f) => f.endsWith(".apk.sha256"));

  if (!apkFile || !shaFile) return { valid: false, reason: "artifact_file_count_invalid" };
  if (shaFile !== `${apkFile}.sha256`) return { valid: false, reason: "artifact_file_count_invalid" };

  return { valid: true, apkFile };
}

export function decideCalorixActionsApkFetch(input) {
  if (input === null || input === undefined || typeof input !== "object") {
    return { allowed: false, reason: "malformed_requested_source_sha" };
  }

  const {
    requestedSourceSha,
    workflowSourceSha,
    workingTreeClean,
    workflowConclusion,
    workflowName,
    workflowPath,
    artifactName,
    artifactFiles,
    artifactSha256,
    expectedSha256,
  } = input;

  if (!isHexString(requestedSourceSha, 40)) {
    return { allowed: false, reason: "malformed_requested_source_sha" };
  }

  if (!isHexString(workflowSourceSha, 40)) {
    return { allowed: false, reason: "malformed_workflow_source_sha" };
  }

  if (!isHexString(artifactSha256, 64)) {
    return { allowed: false, reason: "malformed_artifact_sha256" };
  }

  if (!isHexString(expectedSha256, 64)) {
    return { allowed: false, reason: "malformed_expected_sha256" };
  }

  if (workingTreeClean !== true) {
    return { allowed: false, reason: "uncommitted_source" };
  }

  const normRequested = toLowerHex(requestedSourceSha);
  const normWorkflow = toLowerHex(workflowSourceSha);

  if (normRequested !== normWorkflow) {
    return { allowed: false, reason: "source_sha_mismatch" };
  }

  if (workflowConclusion !== "success") {
    return { allowed: false, reason: "workflow_conclusion_not_success" };
  }

  if (workflowName !== EXPECTED_WORKFLOW_NAME) {
    return { allowed: false, reason: "wrong_workflow_name" };
  }

  if (workflowPath !== EXPECTED_WORKFLOW_PATH) {
    return { allowed: false, reason: "wrong_workflow_path" };
  }

  const expectedArtifactName = `android-apk-${normRequested}`;
  if (artifactName !== expectedArtifactName) {
    return { allowed: false, reason: "wrong_artifact_name" };
  }

  const fileCheck = validateArtifactFiles(artifactFiles);
  if (!fileCheck.valid) {
    return { allowed: false, reason: fileCheck.reason };
  }

  const normArtifact = toLowerHex(artifactSha256);
  const normExpected = toLowerHex(expectedSha256);

  if (normArtifact !== normExpected) {
    return { allowed: false, reason: "checksum_mismatch" };
  }

  return { allowed: true };
}
