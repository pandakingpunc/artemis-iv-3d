@echo off
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js and run this again.
  pause
  exit /b 1
)
start "ARTEMIS IV" /min node.exe "%~dp0server.cjs"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:5184/
