export interface CalorixActionsApkFetchInput {
  requestedSourceSha: string;
  workflowSourceSha: string;
  workingTreeClean: boolean;
  workflowConclusion: string;
  workflowName: string;
  workflowPath: string;
  artifactName: string;
  artifactFiles: string[];
  artifactSha256: string;
  expectedSha256: string;
}

export type CalorixActionsApkFetchRejectionReason =
  | "malformed_requested_source_sha"
  | "malformed_workflow_source_sha"
  | "malformed_artifact_sha256"
  | "malformed_expected_sha256"
  | "uncommitted_source"
  | "source_sha_mismatch"
  | "workflow_conclusion_not_success"
  | "wrong_workflow_name"
  | "wrong_workflow_path"
  | "wrong_artifact_name"
  | "artifact_file_count_invalid"
  | "checksum_mismatch";

export type CalorixActionsApkFetchResult =
  | { allowed: true }
  | { allowed: false; reason: CalorixActionsApkFetchRejectionReason };

export function normalizeGitSha(value: string): string;

export function decideCalorixActionsApkFetch(
  input: unknown,
): CalorixActionsApkFetchResult;
