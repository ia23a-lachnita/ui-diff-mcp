import { describe, expect, test } from "vitest";
import { getRequiredModels } from "../../src/models/model-registry.js";
import { probeRequiredModels } from "../../src/models/probes.js";

const liveEnabled = process.env["RUN_UI_DIFF_LIVE"] === "1";

describe.skipIf(!liveEnabled)("live OpenRouter model probes", () => {
  test("required auditor and reviewer models pass real image+JSON probes", async () => {
    const apiKey = process.env["OPENROUTER_API_KEY"];
    expect(apiKey, "OPENROUTER_API_KEY must be set when RUN_UI_DIFF_LIVE=1").toBeTruthy();

    const results = await probeRequiredModels(getRequiredModels(), apiKey!);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status, `${result.role} ${result.model}: ${result.detail ?? ""}`).toBe("pass");
    }
  }, 120000);
});
