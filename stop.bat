@echo off
setlocal
title Renderly Stop
cd /d "%~dp0"

echo Stopping Renderly...

taskkill /FI "WINDOWTITLE eq Renderly Backend*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Renderly Frontend*" /T /F >nul 2>&1

rem Fallback: kill anything still listening on the app ports
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8022,5173 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction Stop } catch {} }"

echo Done.
timeout /t 2 /nobreak >nul
