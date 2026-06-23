# Deterministic Pipeline Live Results - 2026-06-23

## Decision

The provider-independent deterministic pipeline gate passes. The new code turns eight real local crop mismatches into two inspectable structural-region findings without VLM calls, duplicate final findings, or invented shared translations. This validates the pipeline hardening only; it does not remove the separate production blocker caused by incomplete provider-backed visual classification.

## Verification

| Gate | Result |
| --- | --- |
| TypeScript typecheck and build | PASS |
| Unit/e2e | PASS - 473 tests |
| LocateAnything sidecar parser | PASS - 16 tests |
| MCP integration | PASS - 22 tests |
| Coverage | PASS - 89.66% statements / 74.20% branches / 91.43% functions / 91.81% lines |
| Critical npm audit | PASS - 0 vulnerabilities |
| Deterministic Calorix gate | PASS - 1 test in 15.71s |

## Calorix Evidence

- Run ID: `run-1782187460179-53f4c9`
- Expected image: current dark Today mockup
- Actual image: seeded full-screen ADB capture from 2026-06-17
- Locator: complete, 79 expected elements projected into comparison space
- Projected pairs checked: 79
- Deterministic projected mismatches: 8
- Pairs left for VLM in a provider-backed run: 71
- Coherent displacement groups: 0
- Structural mismatch groups: 2
- Grouped child pairs: 8
- Final deterministic findings: 2
- Auditor/reviewer calls: 0 by construction (`deterministic_only`)
- Recovery batches: not run in deterministic-only mode
- Unresolved regions: 111, intentionally retained because auditor/recovery stages did not run

## Final Findings

1. **Recent-scan region layout differs from expected** - two child crop mismatches. The expected crop contains the complete recent-scan card, while the projected actual crop contains surrounding heading/divider content and only part of the card.
2. **Nutrition region layout differs from expected** - six child crop mismatches spanning the protein, carbs, and fat rows. Expected and actual group crops visibly differ in text sizing/placement, value formatting, percentage placement, and progress-bar geometry.

Both findings use `classificationSource:"deterministic_projected_mismatch"`, `reviewerStatus:"not_reviewed"`, `findingGroupKind:"structural_region_mismatch"`, unique group IDs, all child target IDs, and both child-level and group-level expected/actual/overlay/mask artifacts. They intentionally contain no common `dx`/`dy` measurement because broad search did not prove one shared translation.

## Evidence-Led Amendment

The first broad-search run (`run-1782163777624-9dfac7`) showed that forcing the eight fragments into two coherent translation vectors would be false. A second run (`run-1782164174097-0064d3`) grouped seven fragments but left one same-row nutrition value isolated because Euclidean gap ignored row continuity. A failing same-row regression was added before changing the adjacency rule; the final run grouped all eight while the existing remote-cluster regression remained green.

## Remaining Release Boundary

This gate establishes that the deterministic pipeline fixes were useful and correctly remove duplicate fragment findings. Production release still requires a strict provider-backed Calorix run with `visualClassificationStatus:"complete"`, no unresolved escalation, and all existing release assertions green.
