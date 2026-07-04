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
      "Also set LOCATEANYTHING_SIDECAR_URL before running verify:mcp-live. OpenCode uses the public free credential by default; NVIDIA/OpenRouter keys are optional fallbacks."
    );
  } else if (varName === "RUN_OPENROUTER_FREE_LIVE") {
    console.error(
      "Also set OPENROUTER_API_KEY and LOCATEANYTHING_SIDECAR_URL before running verify:openrouter-free-live."
    );
  } else if (varName === "RUN_FREE_LIVE") {
    console.error(
      "Also set OPENROUTER_API_KEY before running verify:free-live (alias for verify:openrouter-free-live)."
    );
  } else if (varName === "RUN_NVIDIA_LIVE") {
    console.error(
      "Also set NVIDIA_API_KEY (and optionally NVIDIA_VLM_BASE_URL) before running verify:nvidia-live."
    );
  } else if (varName === "RUN_OPENCODE_LIVE") {
    console.error(
      "OpenCode's current free route uses the public credential by default; OPENCODE_API_KEY and OPENCODE_ZEN_BASE_URL are optional overrides."
    );
  } else if (varName === "RUN_GEMINI_LIVE") {
    console.error(
      "Also set GEMINI_API_KEY (and optionally GEMINI_BASE_URL) before running verify:gemini-live."
    );
  } else if (varName === "RUN_MISTRAL_LIVE") {
    console.error(
      "Also set MISTRAL_API_KEY (and optionally MISTRAL_BASE_URL) before running verify:mistral-live."
    );
  } else if (varName === "RUN_CALORIX_UI_DIFF_LIVE") {
    console.error(
      "Also set LOCATEANYTHING_SIDECAR_URL, " +
      "UI_DIFF_LIVE_EXPECTED_IMAGE, and LOCATEANYTHING_EAGLE_EMBODIED_DIR before running verify:calorix-live. " +
      "UI_DIFF_LIVE_ACTUAL_IMAGE is optional and only for explicit historical-file overrides; default Calorix gates auto-capture from ADB."
    );
  } else if (varName === "RUN_CALORIX_FULL_LIVE") {
    console.error(
      "Also set LOCATEANYTHING_SIDECAR_URL, " +
      "UI_DIFF_LIVE_EXPECTED_IMAGE, and LOCATEANYTHING_EAGLE_EMBODIED_DIR before running verify:calorix-full-live. " +
      "UI_DIFF_LIVE_ACTUAL_IMAGE is optional and only for explicit historical-file overrides. " +
      "Do NOT set UI_DIFF_MAX_AUDIT_PAIRS — this gate requires an unbounded audit."
    );
  } else if (varName === "RUN_CALORIX_RELEASE_LIVE") {
    console.error(
      "Also set LOCATEANYTHING_SIDECAR_URL, UI_DIFF_LIVE_EXPECTED_IMAGE, and LOCATEANYTHING_EAGLE_EMBODIED_DIR before running verify:calorix-release-live. " +
      "Do NOT set UI_DIFF_LIVE_ACTUAL_IMAGE for fresh release evidence unless you intentionally want a historical-file override."
    );
  }
  process.exit(1);
}
