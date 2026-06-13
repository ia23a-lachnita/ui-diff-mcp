param(
  [int]$Port = 39731,
  [string]$HostName = "127.0.0.1",
  [int]$InTokenLimit = 4096,
  [int]$MaxNewTokens = 512,
  [ValidateSet("fast", "slow", "hybrid")]
  [string]$GenerationMode = "hybrid"
)

$ErrorActionPreference = "Stop"

if (-not $env:LOCATEANYTHING_EAGLE_EMBODIED_DIR) {
  Write-Host "LOCATEANYTHING_EAGLE_EMBODIED_DIR is not set."
  Write-Host "Set it to the NVlabs/Eagle/Embodied checkout path before starting the sidecar."
}

if (-not $env:LOCATEANYTHING_IN_TOKEN_LIMIT) {
  $env:LOCATEANYTHING_IN_TOKEN_LIMIT = "$InTokenLimit"
}

if (-not $env:LOCATEANYTHING_GENERATION_MODE) {
  $env:LOCATEANYTHING_GENERATION_MODE = "$GenerationMode"
}

if (-not $env:LOCATEANYTHING_MAX_NEW_TOKENS) {
  $env:LOCATEANYTHING_MAX_NEW_TOKENS = "$MaxNewTokens"
}

python -m uvicorn sidecars.locateanything.server:app --host $HostName --port $Port
