@echo off
setlocal
title Renderly Flow driver service
cd /d "%~dp0"

if not exist "node_modules\playwright" (
    echo [setup] Installing dependencies...
    call npm install --no-fund --no-audit || (echo [error] npm install failed & pause & exit /b 1)
)

echo [driver] Flow driver service on http://127.0.0.1:8030
echo          Used by the Renderly web UI - "Flow Driver" menu.
node server.js
pause
