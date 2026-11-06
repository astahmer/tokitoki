@echo off
start "tokitoki-e2e-agent" /MIN powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0agent.ps1"
echo started>"%~dp0agent.started"
