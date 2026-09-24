@echo off
rem Runs the whole Renderly test suite. Exit code 1 = something failed.
setlocal
cd /d "%~dp0"

echo [1/2] Extension + driver tests (node)...
node --test "tests/js/*.test.js"
if errorlevel 1 goto :fail

echo [2/2] Backend tests (python)...
"backend\.venv\Scripts\python.exe" -m unittest discover -s tests\py
if errorlevel 1 goto :fail

echo.
echo All tests passed.
endlocal & exit /b 0

:fail
echo.
echo TESTS FAILED
endlocal & exit /b 1
