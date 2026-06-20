# Projection Pre-Audit Live Gate Results - 2026-06-21

**Plan:** `docs/superpowers/plans/2026-06-20-projection-preaudit-full-gate-hardening.md`
**Code under test:** `7b9787c`
**Sidecar:** healthy at `http://127.0.0.1:39731`; multi-lane local parser with heavyweight LocateAnything checkpoint skipped on this machine

## Summary

| Gate | Result | Duration | Evidence |
| --- | --- | ---: | --- |
| deterministic verify | PASS | 53.1s including coverage | 416 unit/e2e, 22 integration, 16 Python parser tests; typecheck/build clean |
| coverage | PASS | 4.9s | 88.71% statements / 71.56% branches / 90.90% functions / 90.84% lines |
| npm audit | PASS |  | 0 vulnerabilities |
| NVIDIA free live | PASS | 38.7s | 4/4 tests |
| OpenRouter free live | PASS | 26.1s | 2 passed, 3 intentionally skipped |
| default MCP live | PASS | 35.2s | 1/1 passed |
| Calorix bounded | PASS | 226.4s | `run-1781995401714-d1ccda` |
| Calorix full | FAIL | 419.1s | `run-1781995654661-a86c16`; incomplete classification and a gate-predicate defect |
| Calorix release attempt 1 | ABORTED | 281.7s | `run-1781996099339-37129e`; checkpoint only, process exit 1 without Vitest assertion output |
| Calorix release attempt 2 | ABORTED | 146.9s | `run-1781996435518-9de09d`; checkpoint only, process exit -1 with 8 GB Node heap |

## Bounded Evidence

Run `run-1781995401714-d1ccda`:

- report status: `complete`
- locator coverage: `complete`
- viewport compatibility: `mismatch`
- audit scope: 3 VLM-audited / 79 total, `auditLimited:true`
- projected pre-audit: 79 checked, 8 deterministic mismatches, 71 eligible for VLM
- visual classification: `incomplete`, expected for the three-pair bounded diagnostic
- recovery: 90 unclassified, stopped at deadline; 83 components skipped by cap
- selected auditor/reviewer: native NVIDIA `moonshotai/kimi-k2.6`; recovery: native NVIDIA `qwen/qwen3.5-397b-a17b`

The bounded gate proves the projection-preaudit regression is fixed: all three bounded slots reached the VLM instead of being consumed by dimension-only checks.

## Full Evidence

Run `run-1781995654661-a86c16`:

- report status: `complete`
- locator coverage: `complete`
- audit scope: 71 VLM-audited + 8 deterministic pre-audit = 79 total; `auditLimited:false`
- visual classification: `incomplete`
- recovery: 93 unclassified; stopped at deadline; 83 components skipped by cap
- 716 diff records:
  - 706 `not_reviewed` `unclassified_visual_change` records with no `classificationSource`
  - 8 `deterministic_projected_mismatch` records
  - 1 accepted `vlm_reviewed` spacing/alignment record
  - 1 accepted `target_recovery` typography/content record
- primary auditor/reviewer/recovery route: native NVIDIA `qwen/qwen3.5-397b-a17b`
- runtime fallback reached NVIDIA Nemotron and OpenRouter Nex after malformed NVIDIA JSON

The full gate failed at `all accepted diffs must have classificationSource`, reporting 706. That assertion is itself too broad: it uses `reviewerStatus !== "rejected"`, which includes `not_reviewed` unclassified records. It should restrict the accepted-diff source check to accepted/escalated records. This predicate defect does not make the report release-ready: classification is independently incomplete and recovery has 93 leftovers.

## Release Attempts

Both strict release commands terminated before producing a final report or assertion summary:

- `run-1781996099339-37129e`: checkpoint after eight audit artifact groups, then process exit 1.
- `run-1781996435518-9de09d`: checkpoint immediately after model probes, then process exit -1 despite `NODE_OPTIONS=--max-old-space-size=8192`.

Both checkpoint reports have `status:"complete"`, `visualClassificationStatus:"not_run"`, no final `auditScope`, and no provider/audit/recovery trace artifacts. The checkpoint `status:"complete"` value is misleading for an interrupted run and must not be treated as release evidence. Windows recorded no application crash, and the machine retained about 12 GB free memory, so heap exhaustion was not demonstrated.

## Production Decision

**BLOCKED.** Required fixes before another sign-off attempt:

1. Correct the full/release gate predicate so `not_reviewed` records are not described as accepted diffs.
2. Remove the Calorix-scale classification gap: no recovery cap/deadline leftovers and `visualClassificationStatus:"complete"`.
3. Diagnose the release-run process termination and make interrupted checkpoints report an honest non-complete status.
4. Rerun full and release gates successfully with final reports and traces.
