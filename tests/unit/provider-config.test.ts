import { describe, expect, it } from "vitest";
import { resolveVisionProviderConfig } from "../../src/models/provider-config.js";

describe("resolveVisionProviderConfig", () => {
  it("uses the public OpenCode credential and official provider defaults", () => {
    expect(resolveVisionProviderConfig({})).toEqual({
      openRouterApiKey: "",
      nvidiaApiKey: "",
      nvidiaBaseUrl: "https://integrate.api.nvidia.com/v1",
      openCodeApiKey: "public",
      openCodeBaseUrl: "https://opencode.ai/zen/v1"
    });
  });

  it("honors explicit provider credentials and base URLs", () => {
    expect(resolveVisionProviderConfig({
      OPENROUTER_API_KEY: "or-key",
      NVIDIA_API_KEY: "nv-key",
      NVIDIA_VLM_BASE_URL: "https://nvidia.example/v1",
      OPENCODE_API_KEY: "oc-key",
      OPENCODE_ZEN_BASE_URL: "https://opencode.example/v1"
    })).toEqual({
      openRouterApiKey: "or-key",
      nvidiaApiKey: "nv-key",
      nvidiaBaseUrl: "https://nvidia.example/v1",
      openCodeApiKey: "oc-key",
      openCodeBaseUrl: "https://opencode.example/v1"
    });
  });

  it("treats a blank OpenCode key as the public free-route credential", () => {
    expect(resolveVisionProviderConfig({ OPENCODE_API_KEY: "   " }).openCodeApiKey).toBe("public");
  });
});
