@echo off
title Renderly
echo Starting Renderly (backend + frontend)...
call "%~dp0start.bat"
echo Opening Renderly in your browser...
timeout /t 5 /nobreak >nul
start "" http://localhost:5173
