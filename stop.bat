@echo off
chcp 936 >nul
cd /d "%~dp0"
title 文旅智能辅助 · 停止服务
echo ================================================
echo    文旅智能辅助 Skill · 停止本地服务
echo ================================================
echo.

netstat -ano | findstr /C:"LISTENING" | findstr /C:":8000 " >nul
if %errorlevel% neq 0 goto NONE

echo [执行] 正在停止监听 8000 端口的服务 ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:"LISTENING" ^| findstr /C:":8000 "') do (
  echo        结束进程 PID %%p
  taskkill /PID %%p /F >nul 2>nul
)
echo.
echo [完成] 服务已停止。
echo.
pause
exit /b 0

:NONE
echo [提示] 端口 8000 上没有正在运行的服务，无需停止。
echo.
pause
exit /b 0
