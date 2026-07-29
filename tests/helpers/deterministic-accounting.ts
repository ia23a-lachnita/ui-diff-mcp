export interface DeterministicAccountingInput {
  groupCount: number;
  groupedPairs: number;
  deterministicProjectedDiffs: number;
}

export interface DeterministicAccountingIssue {
  code: string;
  message: string;
}

export function validateDeterministicAccounting(input: DeterministicAccountingInput): DeterministicAccountingIssue[] {
  const issues: DeterministicAccountingIssue[] = [];

  if (input.groupedPairs > input.deterministicProjectedDiffs) {
    issues.push({
      code: "grouped_pairs_exceeds_deterministic_diffs",
      message: `groupedPairs (${input.groupedPairs}) cannot exceed deterministicProjectedDiffs (${input.deterministicProjectedDiffs})`
    });
  }

  if (input.groupCount === 0 && input.groupedPairs !== 0) {
    issues.push({
      code: "zero_groups_nonzero_pairs",
      message: `groupCount===0 requires groupedPairs===0, but got groupedPairs=${input.groupedPairs}`
    });
  }

  if (input.groupCount > 0 && input.groupedPairs < 2) {
    issues.push({
      code: "positive_groups_insufficient_pairs",
      message: `groupCount>0 requires groupedPairs>=2, but got groupedPairs=${input.groupedPairs}`
    });
  }

  return issues;
}

export function assertDeterministicAccounting(input: DeterministicAccountingInput): void {
  const issues = validateDeterministicAccounting(input);
  if (issues.length > 0) {
    throw new Error(
      `Deterministic accounting validation failed:\n${issues.map(i => `  - [${i.code}] ${i.message}`).join("\n")}`
    );
  }
}
