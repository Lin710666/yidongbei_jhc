@echo off
chcp 936 >nul
cd /d "%~dp0"
title 停止 文旅智能辅助 · AIRI 网页版

echo ==================================================
echo   正在停止本地服务（端口 8000）...
echo ==================================================
echo.

set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8000" ^| findstr "LISTENING"') do call :KILL %%a
if "%FOUND%"=="0" echo 没有找到正在监听 8000 端口的进程（服务本来就没在运行）。
echo.
pause
goto :EOF

:KILL
set FOUND=1
echo   结束进程 PID=%1
taskkill /F /PID %1 >nul 2>nul
goto :EOF
