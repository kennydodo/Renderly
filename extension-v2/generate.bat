@echo off
setlocal
title Renderly Flow driver - generate batch
cd /d "%~dp0"

rem ---- Dependencies ----
if not exist "node_modules\playwright" (
    echo [setup] Installing dependencies...
    call npm install --no-fund --no-audit || (echo [error] npm install failed & pause & exit /b 1)
)

rem ---- Prompts source ----
rem Set SHOTLIST to the shotlist.json in YOUR working directory (full path).
rem Order: a .json dragged onto this bat wins, then SHOTLIST, then
rem shotlist.json in this folder, then prompts.json.
set "SHOTLIST="
set "PROMPTS_FILE=%~1"
if "%PROMPTS_FILE%"=="" set "PROMPTS_FILE=%SHOTLIST%"
if "%PROMPTS_FILE%"=="" if exist "%~dp0shotlist.json" set "PROMPTS_FILE=%~dp0shotlist.json"
if "%PROMPTS_FILE%"=="" set "PROMPTS_FILE=%~dp0prompts.json"
if not exist "%PROMPTS_FILE%" (
    echo [error] Prompts file not found: %PROMPTS_FILE%
    echo Set SHOTLIST in this .bat to your working-directory shotlist.json,
    echo or drop a shotlist/prompts .json file onto this .bat.
    pause & exit /b 1
)

rem ---- Reference images (optional) ----
rem Same refs are attached to EVERY image of the run (ingredients persist
rem across cards). Clear the REFS line for pure text-to-image batches.
set "REFS=D:\Repos\Renderly\extension-v2\refs\CHAR-HUMAN-FEMALE-01-SIT.webp,D:\Repos\Renderly\extension-v2\refs\CHAR HUMAN MAKE.webp"

echo [run] Batch: %PROMPTS_FILE%
echo       Sign in if asked, then press Enter in THIS window when the script asks.
if "%REFS%"=="" (
    node flow.js --file "%PROMPTS_FILE%" --channel "The Nature Made Us"
) else (
    node flow.js --file "%PROMPTS_FILE%" --channel "The Nature Made Us" --refs "%REFS%"
)
if errorlevel 1 echo [error] Batch failed - see output above.
echo.
pause
