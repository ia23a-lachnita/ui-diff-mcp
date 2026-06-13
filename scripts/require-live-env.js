// Preflight guard for npm run verify:live.
// Fails fast if RUN_UI_DIFF_LIVE=1 is not set so the script cannot silently
// exit green with every live test skipped.
if (process.env["RUN_UI_DIFF_LIVE"] !== "1") {
  console.error("Error: RUN_UI_DIFF_LIVE=1 must be set to run live release gates.");
  console.error(
    "Also set OPENROUTER_API_KEY and LOCATEANYTHING_SIDECAR_URL before running verify:live."
  );
  process.exit(1);
}
