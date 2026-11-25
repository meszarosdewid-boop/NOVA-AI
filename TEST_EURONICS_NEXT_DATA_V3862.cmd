@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo NOVA AI V3.86.2 - EURONICS NEXT DATA TEST
echo Syntax check + offline regression fixtures
echo No live crawl, catalogue writes or approvals
echo ==========================================
echo.

node --check website-import-v2.js
if errorlevel 1 (
  echo.
  echo FAIL: website-import-v2.js syntax check failed.
  pause
  exit /b 1
)

node tests\test-euronics-next-data.mjs
if errorlevel 1 (
  echo.
  echo FAIL: Euronics Next.js regression tests failed.
  pause
  exit /b 1
)

echo.
echo PASS: syntax and offline regression tests completed.
pause
