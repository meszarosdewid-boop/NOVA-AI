@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo NOVA AI - SAFE MERGE REGRESSION TESTS
echo Preserves website importer V3.86.2
echo Offline tests only; no crawl or catalogue writes
echo ==========================================
echo.

node --check website-import-v2.js
if errorlevel 1 (
  echo FAIL: website-import-v2.js syntax check failed.
  pause
  exit /b 1
)

node --check website-product-merge.js
if errorlevel 1 (
  echo FAIL: website-product-merge.js syntax check failed.
  pause
  exit /b 1
)

node --check server.js
if errorlevel 1 (
  echo FAIL: server.js syntax check failed.
  pause
  exit /b 1
)

node --test website-product-merge.test.mjs
if errorlevel 1 (
  echo FAIL: safe merge regression tests failed.
  pause
  exit /b 1
)

echo.
echo PASS: syntax checks and safe merge regression tests completed.
pause
