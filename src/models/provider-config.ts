export interface VisionProviderConfig {
  openRouterApiKey: string;
  nvidiaApiKey: string;
  nvidiaBaseUrl: string;
  openCodeApiKey: string;
  openCodeBaseUrl: string;
}

export function resolveVisionProviderConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): VisionProviderConfig {
  return {
    openRouterApiKey: env["OPENROUTER_API_KEY"] ?? "",
    nvidiaApiKey: env["NVIDIA_API_KEY"] ?? "",
    nvidiaBaseUrl: env["NVIDIA_VLM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1",
    openCodeApiKey: env["OPENCODE_API_KEY"]?.trim() || "public",
    openCodeBaseUrl: env["OPENCODE_ZEN_BASE_URL"] ?? "https://opencode.ai/zen/v1"
  };
}
