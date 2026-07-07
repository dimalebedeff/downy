@echo off
rem Downy one-click installer. Logic lives in setup.mjs (Node handles Unicode output).
cd /d "%~dp0"

if not exist "%~dp0setup.mjs" (
  echo It looks like install.bat is running from inside the ZIP archive.
  echo Extract the whole archive to a folder first, then run install.bat from there.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found.
  echo Install the LTS version from https://nodejs.org and run install.bat again.
  pause
  exit /b 1
)

node setup.mjs
pause
