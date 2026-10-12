@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.12 or newer first, then reopen this file.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing Synapse dependencies...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Open http://localhost:5173 in your browser.
echo Keep this window open. Press Ctrl+C to stop the app.
call npm run dev
pause
