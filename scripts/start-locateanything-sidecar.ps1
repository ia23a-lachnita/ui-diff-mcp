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
  # Default for this machine — override by setting LOCATEANYTHING_EAGLE_EMBODIED_DIR in your shell profile
  $defaultDir = "C:\Users\xursc\projects\Eagle\Embodied"
  if (Test-Path $defaultDir) {
    $env:LOCATEANYTHING_EAGLE_EMBODIED_DIR = $defaultDir
    Write-Host "LOCATEANYTHING_EAGLE_EMBODIED_DIR defaulting to $defaultDir"
  } else {
    Write-Error "LOCATEANYTHING_EAGLE_EMBODIED_DIR is not set and default path '$defaultDir' does not exist. Set it to the Eagle/Embodied checkout containing locateanything_worker."
    exit 1
  }
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
