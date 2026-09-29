@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ==========================================================
echo   PosterForge - 停止服务
echo ==========================================================
echo.
echo   会停掉：站点服务（server.mjs）与 ComfyUI
echo   不会碰：其它 node / python 程序
echo.

set FOUND=0

echo [1/2] 查找站点服务 ...
for /f "tokens=2 delims=," %%p in ('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH 2^>nul') do (
  set "PID=%%~p"
  for /f "delims=" %%c in ('wmic process where "ProcessId=!PID!" get CommandLine /value 2^>nul ^| findstr /i "server.mjs"') do (
    echo     停止站点服务 PID !PID!
    taskkill /F /PID !PID! >nul 2>&1
    set FOUND=1
  )
)

echo [2/2] 查找 ComfyUI ...
for /f "tokens=2 delims=," %%p in ('tasklist /FI "IMAGENAME eq python.exe" /FO CSV /NH 2^>nul') do (
  set "PID=%%~p"
  for /f "delims=" %%c in ('wmic process where "ProcessId=!PID!" get CommandLine /value 2^>nul ^| findstr /i "ComfyUI"') do (
    echo     停止 ComfyUI PID !PID!
    taskkill /F /PID !PID! >nul 2>&1
    set FOUND=1
  )
)

echo.
if "!FOUND!"=="0" (
  echo   没有找到正在运行的服务。
) else (
  echo   已停止。
)
echo.
pause
