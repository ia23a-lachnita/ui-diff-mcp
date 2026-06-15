# Last Run Readiness Review - 2026-06-15

## Purpose

Determine whether the most recent persisted UI diff run reports prove that `ui-diff-mcp` is production-ready.

## Reports Inspected

The latest Calorix async run-state file points to:

- Async handle: `run-1781530941625-ien7ls`
- Report run: `run-1781530941630-a2ada2`
- Project-relative report: `.ui-diff/runs/run-1781530941630-a2ada2/artifacts/report.json`
- Created: `2026-06-15T13:42:22.325Z`

Older persisted Calorix reports inspected:

- `run-1781515666760-3b3ae6`
- `run-1781515236427-513068`

Older generic live reports under the local temp directory were also inspected. They were earlier diagnostic runs, not current Calorix sign-off evidence.

## Latest Calorix Report Result

| Field | Value |
| --- | --- |
| `status` | `complete` |
| `visualClassificationStatus` | `incomplete` |
| `locatorCoverageStatus` | `weak` |
| Expected elements | `48` |
| Actual elements | `1` |
| Pairs | `49` |
| Diffs | `1350` |
| Audit scope | `auditedPairs=49`, `totalPairs=49`, `auditLimited=false` |
| Auditor | `nvidia/moonshotai/kimi-k2.6`, free |
| Reviewer | `nvidia/qwen/qwen3.5-397b-a17b`, free |

Diff breakdown:

| Criterion | Count |
| --- | ---: |
| `presence` | 50 |
| `typography_content` | 1 |
| `unclassified_visual_change` | 1299 |

Reviewer-status breakdown:

| Reviewer status | Count |
| --- | ---: |
| `accepted` | 50 |
| `needs_escalation` | 1 |
| `not_reviewed` | 1299 |

Recovery summary:

- `totalUncoveredComponents`: 1299
- `attemptedComponents`: 12
- `skippedComponents`: 865
- `recoveredDiffs`: 0
- `unclassifiedCount`: 12
- `stoppedReason`: `none`

## Readiness Determination From These Reports

These last persisted run reports do not prove production readiness.

The latest Calorix report has two release-blocking quality signals:

- `locatorCoverageStatus` is `weak`, because only one actual element was located.
- `visualClassificationStatus` is `incomplete`, because most visual changes remained `unclassified_visual_change` and `not_reviewed`.

That report shape should fail the current hardened Calorix live gates. The later test changes require:

- run status exactly `complete`,
- locator coverage not `weak` or `failed`,
- visual classification exactly `complete`,
- at least one non-deterministic, model-reviewed diff.

Therefore the persisted report is useful as regression evidence: it captures the failure mode the newer gates must reject. It is not release sign-off evidence.

## What The Reports Still Prove

The reports do show that several production-supporting mechanics work:

- Reports are written as schema-valid JSON.
- Exact provider/model/cost selections are recorded.
- Directional diff, pixel diff, normalized image, and mask artifact paths are recorded in `runArtifacts`.
- Async run-state points back to the generated report.
- The pipeline records incomplete visual classification instead of silently pretending the run was a full visual audit.

## Production-Readiness Position

Based on the last persisted reports alone: not production-ready.

Based on the current code gates after hardening: production-ready candidate, pending a fresh successful run of the hardened live gates in the intended environment.

Required fresh gates:

```powershell
npm run verify
npm run test:coverage
npm run verify:mcp-live
npm run verify:nvidia-live
npm run verify:openrouter-free-live
npm run verify:calorix-live
npm run verify:calorix-full-live
```

The Calorix gates must generate new reports that satisfy the hardened assertions above. The old `run-1781530941630-a2ada2` report should be treated as a known-bad regression sample, not as sign-off.
