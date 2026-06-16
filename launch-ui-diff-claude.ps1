param(
  [string]$Prompt = ""
)

$ProjectDir = "C:\Users\xursc\projects\ui-diff-mcp"
$SessionName = "ui-diff-mcp"

$claudeArgs = @(
  "--dangerously-skip-permissions",
  "--model", "claude-sonnet-4-6",
  "--remote-control", "`"$SessionName`""
)

if ($Prompt -ne "") {
  $claudeArgs += @("--print", "`"$Prompt`"")
}

Start-Process powershell.exe `
  -WorkingDirectory $ProjectDir `
  -ArgumentList (@("-NoExit", "-Command", "claude " + ($claudeArgs -join " ")))
