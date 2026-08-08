@echo off
rem Double-click launcher for Crosscheck (Windows). Installs dependencies on
rem first run, starts the server, and opens your browser.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Crosscheck needs Node.js ^(free^): https://nodejs.org - install the LTS version, then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run - installing dependencies, give it a minute...
  call npm install
)
start "" cmd /c "timeout /t 2 >nul & start http://localhost:3000"
echo Crosscheck is starting - your browser will open. Keep this window open while you use it.
node server.js
pause
