@echo off
if not exist Z:\e2e\agent.ps1 exit /b 0
start "tokitoki-e2e-agent" /MIN powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File Z:\e2e\agent.ps1
