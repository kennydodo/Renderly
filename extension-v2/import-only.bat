@echo off
setlocal
title Renderly Flow driver - import existing outputs
cd /d "%~dp0"

echo [import] Importing output\ images into Renderly (backend must be running - start.bat).
node flow.js --file prompts.json --import-only
if errorlevel 1 (echo [error] Import failed - see output above.) else (echo Done.)
pause
