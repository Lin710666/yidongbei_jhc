@echo off
setlocal
cd /d "%~dp0.."

REM Find the PowerShell script next to this file.
REM Wildcard instead of a literal name: the script is named in Chinese, and a
REM .bat that embeds non-ASCII paths breaks when the console code page is not
REM UTF-8. The wildcard keeps this file pure ASCII.
set "PS1="
for %%f in ("%~dp0*.ps1") do if not defined PS1 set "PS1=%%~ff"

if not defined PS1 (
  echo [ERROR] no .ps1 found next to this .bat
  pause
  exit /b 1
)

where pwsh >nul 2>nul
if errorlevel 1 (
  echo [ERROR] pwsh ^(PowerShell 7^) not found. Install it, or run:
  echo         powershell -ExecutionPolicy Bypass -File "%%PS1%%"
  pause
  exit /b 1
)

pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
if errorlevel 1 pause