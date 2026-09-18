@echo off
setlocal
title Renderly Flow driver - diagnostics
cd /d "%~dp0"

rem ---- Dependencies ----
if not exist "node_modules\playwright" (
    echo [setup] Installing dependencies...
    call npm install --no-fund --no-audit || (echo [error] npm install failed & pause & exit /b 1)
)

echo [diag] Launching Chrome on flow.google.com...
echo        Sign in if asked, then press Enter in THIS window when the script asks.
node flow.js --diag
if errorlevel 1 echo [error] Diagnostics failed - see output above.
echo.
echo Report saved to: %~dp0diag-report.json
pause
