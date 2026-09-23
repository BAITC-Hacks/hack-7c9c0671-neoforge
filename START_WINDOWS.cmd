@echo off
setlocal
cd /d "%~dp0"

echo.
echo  Meeting Assistant - Windows startup
echo  ===================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Install Node.js 22 LTS from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm.cmd not found. Reinstall Node.js 22 LTS.
  pause
  exit /b 1
)

if not exist package.json (
  echo [ERROR] package.json not found.
  echo Put START_WINDOWS.cmd in the extracted project folder.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"
echo [OK] Node.js %NODE_VERSION%
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(((major===20&&minor>=19)||(major===22&&minor>=12)||major>22)?0:1)"
if errorlevel 1 (
  echo [ERROR] This project requires Node.js 20.19+, 22.12+, or newer.
  echo Install Node.js 22 LTS from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)

if not exist .env (
  if exist .env.windows.example (
    copy /y .env.windows.example .env >nul
  ) else (
    copy /y .env.example .env >nul
  )
  echo [OK] Created local .env
) else (
  echo [OK] Using existing .env
)

set "APP_PORT=3000"
for /f "usebackq tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="PORT" set "APP_PORT=%%b"
set "NODE_ENV="

if not exist node_modules (
  echo [INFO] First launch: installing exact dependencies from package-lock.json.
  echo [INFO] This can take several minutes. Do not press Ctrl+C or close this window.
  call npm.cmd ci --include=dev --no-audit --no-fund
  if errorlevel 1 goto dependencies_failed
) else (
  call npm.cmd ls --depth=0 --include=dev >nul 2>nul
  if errorlevel 1 (
    echo [INFO] Dependencies are missing or incomplete.
    echo [INFO] Repairing them now. Do not press Ctrl+C or close this window.
    call npm.cmd install --include=dev --no-audit --no-fund
    if errorlevel 1 goto dependencies_failed
  )
)

call npm.cmd ls --depth=0 --include=dev >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Dependencies are still incomplete. See README: Windows troubleshooting.
  pause
  exit /b 1
)

echo [OK] Dependencies are ready.
echo [INFO] Waiting for http://localhost:%APP_PORT% ...
echo [INFO] Keep this window open. Press Ctrl+C to stop the server.
echo.

start "Meeting Assistant browser" powershell.exe -NoProfile -WindowStyle Hidden -Command "$url='http://localhost:%APP_PORT%'; foreach($i in 1..60){try{Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1 ^| Out-Null; Start-Process $url; exit}catch{Start-Sleep -Seconds 1}}"
call npm.cmd run dev
set "SERVER_EXIT=%errorlevel%"

if not "%SERVER_EXIT%"=="0" (
  echo.
  echo [ERROR] Server stopped with an error. Read the message above.
) else (
  echo.
  echo Server stopped.
)
pause
exit /b %SERVER_EXIT%

:dependencies_failed
echo.
echo [ERROR] Dependency installation failed.
echo Do not press Ctrl+C while npm is installing packages.
echo If you see EPERM or ERR_MODULE_NOT_FOUND for tsx, follow README: Windows troubleshooting.
echo Close VS Code and any old Meeting Assistant server before retrying.
pause
exit /b 1
