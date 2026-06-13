// Preflight guard for live release gate scripts.
// Usage: node scripts/require-live-env.js <ENV_VAR_NAME>
// Fails fast when the named flag is not set to "1" so the gate cannot silently
// exit green with every live test skipped.
const varName = process.argv[2];
if (!varName) {
  console.error("Usage: node scripts/require-live-env.js <ENV_VAR_NAME>");
  process.exit(1);
}
if (process.env[varName] !== "1") {
  console.error(`Error: ${varName}=1 must be set to run this live release gate.`);
  if (varName === "RUN_UI_DIFF_LIVE") {
    console.error(
      "Also set OPENROUTER_API_KEY and LOCATEANYTHING_SIDECAR_URL before running verify:live."
    );
  } else if (varName === "RUN_CALORIX_UI_DIFF_LIVE") {
    console.error(
      "Also set OPENROUTER_API_KEY, LOCATEANYTHING_SIDECAR_URL, " +
      "UI_DIFF_LIVE_EXPECTED_IMAGE, and UI_DIFF_LIVE_ACTUAL_IMAGE before running verify:calorix-live."
    );
  }
  process.exit(1);
}
