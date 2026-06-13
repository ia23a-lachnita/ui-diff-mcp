# Production Readiness Checklist

Run this checklist before calling `ui-diff-mcp` production-ready.

## Deterministic Gates

```powershell
npm run verify
npm run test:coverage
npm audit
```

Required result:

- Typecheck passes.
- Unit and integration tests pass.
- Coverage thresholds pass.
- `npm audit` reports no critical vulnerability.

## Live Gates

```powershell
$env:RUN_UI_DIFF_LIVE="1"
$env:OPENROUTER_API_KEY="<real-openrouter-key>"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
npm run verify:live
```

Required result:

- OpenRouter auditor and reviewer probes pass.
- LocateAnything sidecar returns valid in-bounds boxes.
- `discover_ui_diffs` completes through the MCP stdio server.
- The report has `status: "complete"` and `visualClassificationStatus: "complete"`.
- Required model health entries are `pass`.
- The report includes normalized images, pixel diff, overlay, report JSON, and artifact index.

## Optional Calorix Gate

```powershell
$env:RUN_CALORIX_UI_DIFF_LIVE="1"
$env:OPENROUTER_API_KEY="<real-openrouter-key>"
$env:LOCATEANYTHING_SIDECAR_URL="http://127.0.0.1:39731"
$env:UI_DIFF_LIVE_EXPECTED_IMAGE="C:\absolute\path\to\mockup.png"
$env:UI_DIFF_LIVE_ACTUAL_IMAGE="C:\absolute\path\to\screenshot.png"
npm run verify:calorix-live
```

Required result:

- Calorix image pair runs through `discover_ui_diffs`.
- Report path is recorded in the release note.
- Result is not `failed`.
- If visual classification is incomplete, the release note records the exact missing provider or sidecar reason.

## Sign-Off Record

Append a dated note to `docs/implementation-status.md` with:

- Commit SHA.
- Deterministic gate output summary.
- Live gate output summary.
- Calorix gate output summary or reason it was not run.
- Any remaining P2 risks.
