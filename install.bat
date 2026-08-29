@echo off
rem Downy one-click installer. Finds a usable Node (>=20) or fetches a portable
rem one into vendor\node, then hands off to setup.mjs (Node does the real work).
setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist "%~dp0setup.mjs" (
  echo It looks like install.bat is running from inside the ZIP archive.
  echo Extract the whole archive to a folder first, then run install.bat from there.
  pause
  exit /b 1
)

set "NODE_MIN=20"
set "NODE_VER=22.14.0"
set "VENDOR=%~dp0vendor\node"

rem 1. Годный системный Node уже есть? (мажор не ниже NODE_MIN)
set "NODE_OK="
where node >nul 2>nul
if not errorlevel 1 (
  for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"
  set "NODE_MAJOR=!NODE_MAJOR:v=!"
  if !NODE_MAJOR! GEQ %NODE_MIN% set "NODE_OK=1"
)

if defined NODE_OK (
  echo Node.js найден в системе — использую его.
  goto :run
)

rem 2. Уже распакованный портативный Node от прошлой установки?
if exist "%VENDOR%\node.exe" (
  echo Использую портативный Node из vendor\node.
  set "PATH=%VENDOR%;%PATH%"
  goto :run
)

rem 3. Node нет или устарел — тянем портативный, права админа не нужны.
echo Node.js не найден (или версия ниже %NODE_MIN%). Скачиваю портативный Node %NODE_VER%...
set "NODE_ZIP=%TEMP%\node-v%NODE_VER%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip"
powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -Uri '%NODE_URL%' -OutFile '%NODE_ZIP%' -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 (
  echo.
  echo Не удалось скачать Node. Проверь интернет или поставь Node LTS вручную
  echo с https://nodejs.org и запусти install.bat снова.
  pause
  exit /b 1
)
echo Распаковываю Node...
powershell -NoProfile -Command "Expand-Archive -Path '%NODE_ZIP%' -DestinationPath '%~dp0vendor' -Force"
rem В архиве папка node-vXX-win-x64 — приводим к vendor\node
for /d %%d in ("%~dp0vendor\node-v*-win-x64") do (
  if exist "%VENDOR%" rmdir /s /q "%VENDOR%"
  move "%%d" "%VENDOR%" >nul
)
del "%NODE_ZIP%" >nul 2>nul
if not exist "%VENDOR%\node.exe" (
  echo Распаковка Node не удалась. Поставь Node LTS вручную с https://nodejs.org
  pause
  exit /b 1
)
set "PATH=%VENDOR%;%PATH%"

:run
node setup.mjs
pause
