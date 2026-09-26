@echo off
title CodexApp (node)
cd /d "%~dp0"
echo Starting CodexApp client...
echo (runs via trusted node; Smart App Control won't block it; the panel opens automatically)
echo Close this window to quit.
echo.
node scripts\prepare-terminal.mjs
if errorlevel 1 exit /b 1
node scripts\run.mjs agent
echo.
echo CodexApp exited. Press any key to close.
pause >nul
