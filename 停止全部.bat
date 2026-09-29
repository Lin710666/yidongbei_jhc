@echo off
REM ★ chcp 65001：本文件是 UTF-8（无 BOM）且含中文，中文 Windows 控制台默认 GBK。
chcp 65001 >nul
title 停止服务

cd /d "%~dp0"

echo ==================================================
echo   停止三个服务
echo ==================================================
echo.

REM 为什么要单独写这个：这三个服务是 detached（脱离父进程）起的，
REM 关掉看守窗口或 Ctrl+C **不会**停掉它们 —— 这是保活的代价。
REM 想真停就得按端口找进程杀掉。
for %%P in (8800 8001) do (
  set FOUND=
  for /f "tokens=5" %%I in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
    taskkill /F /PID %%I >nul 2>&1
    if not errorlevel 1 (
      echo   已停端口 %%P  ^(PID %%I^)
      set FOUND=1
    )
  )
  if not defined FOUND echo   端口 %%P 本来就没在跑
)

echo.
echo   Ollama^(11434^) 没有停 —— 它可能还有别的程序在用。
echo   要停就自己执行：ollama stop
echo.
pause
