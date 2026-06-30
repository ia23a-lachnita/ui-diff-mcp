export interface VisionProviderConfig {
  openRouterApiKey: string;
  nvidiaApiKey: string;
  nvidiaBaseUrl: string;
  openCodeApiKey: string;
  openCodeBaseUrl: string;
  geminiApiKey: string;
  geminiBaseUrl: string;
  mistralApiKey: string;
  mistralBaseUrl: string;
}

export function resolveVisionProviderConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): VisionProviderConfig {
  return {
    openRouterApiKey: env["OPENROUTER_API_KEY"] ?? "",
    nvidiaApiKey: env["NVIDIA_API_KEY"] ?? "",
    nvidiaBaseUrl: env["NVIDIA_VLM_BASE_URL"] ?? "https://integrate.api.nvidia.com/v1",
    openCodeApiKey: env["OPENCODE_API_KEY"]?.trim() || "public",
    openCodeBaseUrl: env["OPENCODE_ZEN_BASE_URL"] ?? "https://opencode.ai/zen/v1",
    geminiApiKey: env["GEMINI_API_KEY"] ?? "",
    geminiBaseUrl: env["GEMINI_BASE_URL"] ?? "https://generativelanguage.googleapis.com/v1beta",
    mistralApiKey: env["MISTRAL_API_KEY"] ?? "",
    mistralBaseUrl: env["MISTRAL_BASE_URL"] ?? "https://api.mistral.ai/v1"
  };
}
