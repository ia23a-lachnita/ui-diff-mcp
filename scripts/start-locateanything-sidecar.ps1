param(
  [int]$Port = 39731,
  [string]$HostName = "127.0.0.1"
)

$ErrorActionPreference = "Stop"

if (-not $env:LOCATEANYTHING_EAGLE_EMBODIED_DIR) {
  Write-Host "LOCATEANYTHING_EAGLE_EMBODIED_DIR is not set."
  Write-Host "Set it to the NVlabs/Eagle/Embodied checkout path before starting the sidecar."
}

python -m uvicorn sidecars.locateanything.server:app --host $HostName --port $Port
