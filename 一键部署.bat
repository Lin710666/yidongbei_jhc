@echo off
REM ============================================================================
REM  One-click deploy launcher (kept ASCII-only on purpose)
REM
REM  Why this file has no Chinese in it: cmd.exe reads .bat in the OEM codepage
REM  (936/GBK on Chinese Windows). A UTF-8 .bat with Chinese text turns into
REM  mojibake. So the Chinese banner and all the logic live in tools\deploy.ps1
REM  (UTF-8, read correctly by PowerShell), and this launcher stays pure ASCII.
REM ============================================================================
chcp 65001 >nul 2>nul
cd /d "%~dp0"

where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\deploy.ps1" %*
  goto :done
)

where powershell >nul 2>nul
if %errorlevel%==0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\deploy.ps1" %*
  goto :done
)

echo.
echo   [ERROR] PowerShell not found. / Wei jian ce dao PowerShell.
echo   Windows 7 and older are not supported. Please use Windows 10 or 11.
echo.
pause
exit /b 1

:done
exit /b %errorlevel%
