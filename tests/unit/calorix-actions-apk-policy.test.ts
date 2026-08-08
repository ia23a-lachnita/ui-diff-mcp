import { describe, it, expect } from "vitest";
import {
  normalizeGitSha,
  decideCalorixActionsApkFetch,
} from "../../scripts/lib/calorix-actions-apk-policy.mjs";

const VALID_40 = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const VALID_40_UPPER = "A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0";
const VALID_64 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const VALID_64_UPPER = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855";
const DIFF_40 = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1";

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    requestedSourceSha: VALID_40,
    workflowSourceSha: VALID_40,
    workingTreeClean: true,
    workflowConclusion: "success",
    workflowName: "Build Android APK",
    workflowPath: ".github/workflows/android-build.yml",
    artifactName: `android-apk-${VALID_40}`,
    artifactFiles: ["app-release.apk", "app-release.apk.sha256"],
    artifactSha256: VALID_64,
    expectedSha256: VALID_64,
    ...overrides,
  };
}

describe("normalizeGitSha", () => {
  it("returns lowercase 40-char hex unchanged", () => {
    expect(normalizeGitSha(VALID_40)).toBe(VALID_40);
  });

  it("normalizes uppercase to lowercase", () => {
    expect(normalizeGitSha(VALID_40_UPPER)).toBe(VALID_40);
  });

  it("normalizes mixed case to lowercase", () => {
    expect(normalizeGitSha("a1B2C3D4e5F6a7B8c9D0e1F2a3B4c5D6e7f8A9b0")).toBe(VALID_40);
  });

  it("throws for too-short hex", () => {
    expect(() => normalizeGitSha("a1b2c3")).toThrow();
  });

  it("throws for too-long hex", () => {
    expect(() => normalizeGitSha(VALID_40 + "00")).toThrow();
  });

  it("throws for non-hex characters", () => {
    expect(() => normalizeGitSha("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toThrow();
  });

  it("throws for empty string", () => {
    expect(() => normalizeGitSha("")).toThrow();
  });

  it("throws for non-string number", () => {
    expect(() => normalizeGitSha(123 as unknown as string)).toThrow();
  });

  it("throws for null", () => {
    expect(() => normalizeGitSha(null as unknown as string)).toThrow();
  });

  it("throws for undefined", () => {
    expect(() => normalizeGitSha(undefined as unknown as string)).toThrow();
  });

  it("throws for boolean", () => {
    expect(() => normalizeGitSha(true as unknown as string)).toThrow();
  });

  it("throws for array", () => {
    expect(() => normalizeGitSha(["a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"] as unknown as string)).toThrow();
  });
});

describe("decideCalorixActionsApkFetch — allowed path", () => {
  it("allows when all fields valid and matching", () => {
    expect(decideCalorixActionsApkFetch(baseInput())).toMatchObject({ allowed: true });
  });

  it("allows with uppercase requested SHA (normalized)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      requestedSourceSha: VALID_40_UPPER,
      artifactName: `android-apk-${VALID_40}`,
    }))).toMatchObject({ allowed: true });
  });

  it("allows with uppercase workflow SHA (normalized)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      workflowSourceSha: VALID_40_UPPER,
    }))).toMatchObject({ allowed: true });
  });

  it("allows with uppercase artifact checksum (normalized)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactSha256: VALID_64_UPPER,
    }))).toMatchObject({ allowed: true });
  });

  it("allows with uppercase expected checksum (normalized)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      expectedSha256: VALID_64_UPPER,
    }))).toMatchObject({ allowed: true });
  });

  it("allows with all fields uppercase (all normalized)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      requestedSourceSha: VALID_40_UPPER,
      workflowSourceSha: VALID_40_UPPER,
      artifactSha256: VALID_64_UPPER,
      expectedSha256: VALID_64_UPPER,
    }))).toMatchObject({ allowed: true });
  });

  it("allows artifact files in reverse order", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["app-release.apk.sha256", "app-release.apk"],
    }))).toMatchObject({ allowed: true });
  });
});

describe("decideCalorixActionsApkFetch — malformed requested source SHA", () => {
  it("rejects too-short requested SHA", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ requestedSourceSha: "a1b2c3" }))).toMatchObject({
      allowed: false,
      reason: "malformed_requested_source_sha",
    });
  });

  it("rejects too-long requested SHA", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ requestedSourceSha: VALID_40 + "00" }))).toMatchObject({
      allowed: false,
      reason: "malformed_requested_source_sha",
    });
  });

  it("rejects non-hex requested SHA", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      requestedSourceSha: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    }))).toMatchObject({
      allowed: false,
      reason: "malformed_requested_source_sha",
    });
  });

  it("rejects empty requested SHA", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ requestedSourceSha: "" }))).toMatchObject({
      allowed: false,
      reason: "malformed_requested_source_sha",
    });
  });

  it("rejects number requested SHA (type-invalid, no throw)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ requestedSourceSha: 123 as unknown as string }))).toMatchObject({
      allowed: false,
      reason: "malformed_requested_source_sha",
    });
  });

  it("rejects null requested SHA (type-invalid, no throw)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ requestedSourceSha: null as unknown as string }))).toMatchObject({
      allowed: false,
      reason: "malformed_requested_source_sha",
    });
  });

  it("rejects undefined requested SHA (type-invalid, no throw)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ requestedSourceSha: undefined as unknown as string }))).toMatchObject({
      allowed: false,
      reason: "malformed_requested_source_sha",
    });
  });

  it("rejects boolean requested SHA (type-invalid, no throw)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ requestedSourceSha: true as unknown as string }))).toMatchObject({
      allowed: false,
      reason: "malformed_requested_source_sha",
    });
  });

  it("rejects array requested SHA (type-invalid, no throw)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      requestedSourceSha: ["a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"] as unknown as string,
    }))).toMatchObject({
      allowed: false,
      reason: "malformed_requested_source_sha",
    });
  });
});

describe("decideCalorixActionsApkFetch — malformed workflow source SHA", () => {
  it("rejects too-short workflow SHA", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workflowSourceSha: "a1b2c3" }))).toMatchObject({
      allowed: false,
      reason: "malformed_workflow_source_sha",
    });
  });

  it("rejects too-long workflow SHA", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workflowSourceSha: VALID_40 + "00" }))).toMatchObject({
      allowed: false,
      reason: "malformed_workflow_source_sha",
    });
  });

  it("rejects non-hex workflow SHA", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      workflowSourceSha: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    }))).toMatchObject({
      allowed: false,
      reason: "malformed_workflow_source_sha",
    });
  });

  it("rejects number workflow SHA (type-invalid, no throw)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workflowSourceSha: 42 as unknown as string }))).toMatchObject({
      allowed: false,
      reason: "malformed_workflow_source_sha",
    });
  });
});

describe("decideCalorixActionsApkFetch — malformed artifact SHA256", () => {
  it("rejects non-hex artifact checksum", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactSha256: "xyz00000000000000000000000000000000000000000000000000000000000",
    }))).toMatchObject({
      allowed: false,
      reason: "malformed_artifact_sha256",
    });
  });

  it("rejects too-short artifact checksum", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ artifactSha256: "e3b0c4" }))).toMatchObject({
      allowed: false,
      reason: "malformed_artifact_sha256",
    });
  });

  it("rejects too-long artifact checksum", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ artifactSha256: VALID_64 + "00" }))).toMatchObject({
      allowed: false,
      reason: "malformed_artifact_sha256",
    });
  });

  it("rejects number artifact checksum (type-invalid, no throw)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ artifactSha256: 123 as unknown as string }))).toMatchObject({
      allowed: false,
      reason: "malformed_artifact_sha256",
    });
  });
});

describe("decideCalorixActionsApkFetch — malformed expected SHA256", () => {
  it("rejects too-short expected checksum", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ expectedSha256: "e3b0c4" }))).toMatchObject({
      allowed: false,
      reason: "malformed_expected_sha256",
    });
  });

  it("rejects non-hex expected checksum", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      expectedSha256: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    }))).toMatchObject({
      allowed: false,
      reason: "malformed_expected_sha256",
    });
  });

  it("rejects number expected checksum (type-invalid, no throw)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ expectedSha256: 42 as unknown as string }))).toMatchObject({
      allowed: false,
      reason: "malformed_expected_sha256",
    });
  });
});

describe("decideCalorixActionsApkFetch — uncommitted source", () => {
  it("rejects when workingTreeClean is false", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workingTreeClean: false }))).toMatchObject({
      allowed: false,
      reason: "uncommitted_source",
    });
  });

  it("rejects when workingTreeClean is undefined (not strictly true)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workingTreeClean: undefined as unknown as boolean }))).toMatchObject({
      allowed: false,
      reason: "uncommitted_source",
    });
  });
});

describe("decideCalorixActionsApkFetch — source SHA mismatch", () => {
  it("rejects when normalized SHAs differ", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workflowSourceSha: DIFF_40 }))).toMatchObject({
      allowed: false,
      reason: "source_sha_mismatch",
    });
  });

  it("rejects when requested is uppercase and workflow differs", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      requestedSourceSha: VALID_40_UPPER,
      workflowSourceSha: DIFF_40,
    }))).toMatchObject({
      allowed: false,
      reason: "source_sha_mismatch",
    });
  });
});

describe("decideCalorixActionsApkFetch — workflow conclusion", () => {
  it("rejects conclusion 'failure'", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workflowConclusion: "failure" }))).toMatchObject({
      allowed: false,
      reason: "workflow_conclusion_not_success",
    });
  });

  it("rejects conclusion 'cancelled'", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workflowConclusion: "cancelled" }))).toMatchObject({
      allowed: false,
      reason: "workflow_conclusion_not_success",
    });
  });

  it("rejects empty conclusion", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workflowConclusion: "" }))).toMatchObject({
      allowed: false,
      reason: "workflow_conclusion_not_success",
    });
  });
});

describe("decideCalorixActionsApkFetch — wrong workflow name", () => {
  it("rejects wrong workflow name", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workflowName: "ci-build" }))).toMatchObject({
      allowed: false,
      reason: "wrong_workflow_name",
    });
  });

  it("rejects similar but wrong name", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workflowName: "Build Android Apk" }))).toMatchObject({
      allowed: false,
      reason: "wrong_workflow_name",
    });
  });
});

describe("decideCalorixActionsApkFetch — wrong workflow path", () => {
  it("rejects wrong workflow path", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workflowPath: ".github/workflows/ci.yml" }))).toMatchObject({
      allowed: false,
      reason: "wrong_workflow_path",
    });
  });

  it("rejects similar but wrong path", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ workflowPath: ".github/workflows/android-build.yaml" }))).toMatchObject({
      allowed: false,
      reason: "wrong_workflow_path",
    });
  });
});

describe("decideCalorixActionsApkFetch — wrong artifact name", () => {
  it("rejects wrong artifact name", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ artifactName: "some-other-artifact" }))).toMatchObject({
      allowed: false,
      reason: "wrong_artifact_name",
    });
  });

  it("rejects artifact name with wrong casing", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactName: `Android-APK-${VALID_40}`,
    }))).toMatchObject({
      allowed: false,
      reason: "wrong_artifact_name",
    });
  });

  it("rejects artifact name with wrong SHA", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactName: `android-apk-${DIFF_40}`,
    }))).toMatchObject({
      allowed: false,
      reason: "wrong_artifact_name",
    });
  });
});

describe("decideCalorixActionsApkFetch — artifact file count invalid", () => {
  it("rejects missing sha256 file", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["app-release.apk"],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects extra files", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["app-release.apk", "app-release.apk.sha256", "extra.txt"],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects no files", () => {
    expect(decideCalorixActionsApkFetch(baseInput({ artifactFiles: [] }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects duplicate filenames", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["app-release.apk", "app-release.apk"],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects duplicate sha256 filenames", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["app-release.apk", "app-release.apk.sha256", "app-release.apk.sha256"],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects nested path in filename", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["build/app-release.apk", "build/app-release.apk.sha256"],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects dot segment traversal in filename", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["../app-release.apk", "../app-release.apk.sha256"],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects non-string element in files array", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["app-release.apk", 123 as unknown as string],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects null element in files array", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["app-release.apk", null as unknown as string],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects files without .apk extension", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["app-release.zip", "app-release.zip.sha256"],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects sha256 file not matching the apk basename", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["app-release.apk", "other.apk.sha256"],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects sha256 file with extra suffix", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["app-release.apk", "app-release.apk.sha256extra"],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects non-array artifactFiles", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: "app-release.apk" as unknown as string[],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });

  it("rejects three valid-looking files", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactFiles: ["app-release.apk", "app-release.apk.sha256", "README.md"],
    }))).toMatchObject({
      allowed: false,
      reason: "artifact_file_count_invalid",
    });
  });
});

describe("decideCalorixActionsApkFetch — checksum mismatch", () => {
  it("rejects when checksums differ", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactSha256: "aabbccdd00000000000000000000000000000000000000000000000000000000",
      expectedSha256: VALID_64,
    }))).toMatchObject({
      allowed: false,
      reason: "checksum_mismatch",
    });
  });

  it("rejects when checksums differ (reversed)", () => {
    expect(decideCalorixActionsApkFetch(baseInput({
      artifactSha256: VALID_64,
      expectedSha256: "aabbccdd00000000000000000000000000000000000000000000000000000000",
    }))).toMatchObject({
      allowed: false,
      reason: "checksum_mismatch",
    });
  });
});

describe("decideCalorixActionsApkFetch — precedence ordering", () => {
  it("malformed requested SHA takes precedence over all other failures", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      requestedSourceSha: "bad",
      workflowSourceSha: "also-bad",
      expectedSha256: "short",
      workingTreeClean: false,
      workflowConclusion: "failure",
      workflowName: "wrong",
      workflowPath: "wrong",
      artifactName: "wrong",
      artifactFiles: [],
      artifactSha256: "not-hex",
    }));
    expect(result).toMatchObject({ allowed: false, reason: "malformed_requested_source_sha" });
  });

  it("malformed workflow SHA takes precedence over artifact SHA, expected SHA, uncommitted, and everything below", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      workflowSourceSha: "bad",
      artifactSha256: "not-hex",
      expectedSha256: "short",
      workingTreeClean: false,
      workflowConclusion: "failure",
    }));
    expect(result).toMatchObject({ allowed: false, reason: "malformed_workflow_source_sha" });
  });

  it("malformed artifact SHA takes precedence over expected SHA, uncommitted, and everything below", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      artifactSha256: "not-hex",
      expectedSha256: "short",
      workingTreeClean: false,
      workflowConclusion: "failure",
    }));
    expect(result).toMatchObject({ allowed: false, reason: "malformed_artifact_sha256" });
  });

  it("malformed expected SHA takes precedence over uncommitted and everything below", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      expectedSha256: "short",
      workingTreeClean: false,
      workflowConclusion: "failure",
    }));
    expect(result).toMatchObject({ allowed: false, reason: "malformed_expected_sha256" });
  });

  it("uncommitted source takes precedence over source SHA mismatch", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      workingTreeClean: false,
      workflowSourceSha: DIFF_40,
    }));
    expect(result).toMatchObject({ allowed: false, reason: "uncommitted_source" });
  });

  it("source SHA mismatch takes precedence over workflow conclusion", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      workflowSourceSha: DIFF_40,
      workflowConclusion: "failure",
    }));
    expect(result).toMatchObject({ allowed: false, reason: "source_sha_mismatch" });
  });

  it("workflow conclusion takes precedence over wrong workflow name", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      workflowConclusion: "failure",
      workflowName: "wrong",
    }));
    expect(result).toMatchObject({ allowed: false, reason: "workflow_conclusion_not_success" });
  });

  it("wrong workflow name takes precedence over wrong workflow path", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      workflowName: "wrong",
      workflowPath: "wrong",
    }));
    expect(result).toMatchObject({ allowed: false, reason: "wrong_workflow_name" });
  });

  it("wrong workflow path takes precedence over wrong artifact name", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      workflowPath: "wrong",
      artifactName: "wrong",
    }));
    expect(result).toMatchObject({ allowed: false, reason: "wrong_workflow_path" });
  });

  it("wrong artifact name takes precedence over artifact file count", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      artifactName: "wrong",
      artifactFiles: [],
    }));
    expect(result).toMatchObject({ allowed: false, reason: "wrong_artifact_name" });
  });

  it("artifact file count invalid takes precedence over checksum mismatch", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      artifactFiles: [],
      artifactSha256: "aabbccdd00000000000000000000000000000000000000000000000000000000",
    }));
    expect(result).toMatchObject({ allowed: false, reason: "artifact_file_count_invalid" });
  });

  it("checksum mismatch is the last rejection before allowed", () => {
    const result = decideCalorixActionsApkFetch(baseInput({
      artifactSha256: "aabbccdd00000000000000000000000000000000000000000000000000000000",
    }));
    expect(result).toMatchObject({ allowed: false, reason: "checksum_mismatch" });
  });

  it("everything correct yields allowed", () => {
    const result = decideCalorixActionsApkFetch(baseInput());
    expect(result).toMatchObject({ allowed: true });
  });
});

describe("decideCalorixActionsApkFetch — discriminated result shape", () => {
  it("allowed result has no reason property", () => {
    const result = decideCalorixActionsApkFetch(baseInput());
    expect(result.allowed).toBe(true);
    expect(result).not.toHaveProperty("reason");
  });

  it("rejected result always has a string reason", () => {
    const result = decideCalorixActionsApkFetch(baseInput({ requestedSourceSha: "bad" }));
    expect(result.allowed).toBe(false);
    expect(typeof (result as { reason?: unknown }).reason).toBe("string");
  });

  it("allowed result is exactly { allowed: true }", () => {
    const result = decideCalorixActionsApkFetch(baseInput());
    expect(result).toEqual({ allowed: true });
  });
});

describe("decideCalorixActionsApkFetch — never throws", () => {
  it("does not throw on null input", () => {
    expect(() => decideCalorixActionsApkFetch(null as unknown as Parameters<typeof decideCalorixActionsApkFetch>[0])).not.toThrow();
  });

  it("does not throw on undefined input", () => {
    expect(() => decideCalorixActionsApkFetch(undefined as unknown as Parameters<typeof decideCalorixActionsApkFetch>[0])).not.toThrow();
  });

  it("does not throw on empty object", () => {
    expect(() => decideCalorixActionsApkFetch({} as any)).not.toThrow();
  });

  it("does not throw on number input", () => {
    expect(() => decideCalorixActionsApkFetch(42 as unknown as Parameters<typeof decideCalorixActionsApkFetch>[0])).not.toThrow();
  });

  it("does not throw on string input", () => {
    expect(() => decideCalorixActionsApkFetch("hello" as unknown as Parameters<typeof decideCalorixActionsApkFetch>[0])).not.toThrow();
  });

  it("returns malformed result on null input", () => {
    const result = decideCalorixActionsApkFetch(null as unknown as Parameters<typeof decideCalorixActionsApkFetch>[0]);
    expect(result).toHaveProperty("allowed", false);
    expect(result).toHaveProperty("reason");
  });

  it("returns malformed result on empty object", () => {
    const result = decideCalorixActionsApkFetch({} as any);
    expect(result).toHaveProperty("allowed", false);
    expect(result).toHaveProperty("reason");
  });
});

describe("decideCalorixActionsApkFetch — multiple simultaneous failures", () => {
  it("returns only the highest-precedence reason when many fields are invalid", () => {
    const result = decideCalorixActionsApkFetch({
      requestedSourceSha: "bad",
      workflowSourceSha: "bad",
      workingTreeClean: false,
      workflowConclusion: "failure",
      workflowName: "wrong",
      workflowPath: "wrong",
      artifactName: "wrong",
      artifactFiles: [],
      artifactSha256: "not-hex",
      expectedSha256: "short",
    });
    expect(result).toMatchObject({ allowed: false, reason: "malformed_requested_source_sha" });
  });
});
