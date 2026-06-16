@echo off
setlocal
set "PROMPT_ARG="
if not "%~1"=="" set "PROMPT_ARG=--print "%~1""
start "ui-diff-mcp Claude" /D "C:\Users\xursc\projects\ui-diff-mcp" cmd /k claude --dangerously-skip-permissions --model claude-sonnet-4-6 --remote-control "ui-diff-mcp" %PROMPT_ARG%
endlocal
