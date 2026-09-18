@echo off
setlocal
title Renderly Flow driver - generate batch
cd /d "%~dp0"

rem ---- Dependencies ----
if not exist "node_modules\playwright" (
    echo [setup] Installing dependencies...
    call npm install --no-fund --no-audit || (echo [error] npm install failed & pause & exit /b 1)
)

rem ---- Prompts file: drag a .json onto this .bat, or it uses prompts.json ----
set "PROMPTS_FILE=%~1"
if "%PROMPTS_FILE%"=="" set "PROMPTS_FILE=%~dp0prompts.json"
if not exist "%PROMPTS_FILE%" (
    echo [error] Prompts file not found: %PROMPTS_FILE%
    echo Copy prompts.example.json to prompts.json, edit it,
    echo or drag your own prompts .json file onto this .bat.
    pause & exit /b 1
)

echo [run] Batch: %PROMPTS_FILE%
echo       Sign in if asked, then press Enter in THIS window when the script asks.
node flow.js --file "%PROMPTS_FILE%" --channel "The Nature Made Us"
if errorlevel 1 echo [error] Batch failed - see output above.
echo.
pause
