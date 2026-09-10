@echo off
setlocal
title Rosterly Launcher
cd /d "%~dp0"

echo ============================================
echo   Rosterly - starting backend + frontend
echo ============================================

rem ---- Backend dependencies ----
if not exist "backend\.venv\Scripts\python.exe" (
    echo [setup] Creating backend virtual environment...
    pushd backend
    python -m venv .venv || (echo [error] Python not found - install Python 3.12+ first & popd & pause & exit /b 1)
    ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt || (echo [error] pip install failed & popd & pause & exit /b 1)
    popd
)

if not exist "backend\.env" (
    echo [warn] backend\.env missing - copy backend\.env.example and add your GEMINI_API_KEY
)

rem ---- Frontend dependencies ----
if not exist "frontend\node_modules" (
    echo [setup] Installing frontend dependencies...
    pushd frontend
    call npm install --no-fund --no-audit || (echo [error] npm install failed & popd & pause & exit /b 1)
    call npm approve-scripts esbuild --yes >nul 2>&1
    popd
)

echo [start] Backend  - http://127.0.0.1:8022  (docs: /docs)
start "Rosterly Backend" cmd /k "cd /d %~dp0backend && .venv\Scripts\python.exe -m uvicorn main:app --reload --port 8022"

echo [start] Frontend - http://localhost:5173
start "Rosterly Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

timeout /t 3 /nobreak >nul
echo.
echo Both windows launched. Close them or run stop.bat to quit Rosterly.
timeout /t 4 /nobreak >nul
