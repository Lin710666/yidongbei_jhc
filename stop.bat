@echo off
chcp 936 >nul
cd /d "%~dp0"
title 停止 文旅智能辅助

setlocal
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
REM 三个版本各用一个端口：2.0 原始版 → 8200   2.2 → 8100   3.1 及以后 → 8000
REM 这里只停 4.0 自己的端口和它依赖的语音服务，不会误伤别的版本。
set "VER=4.0"
if not defined PORT set "PORT=8000"
set "TTS_PORT=7860"

REM 先探出 Qwen TTS 装在哪，才能精确认出它的 python 进程（不误伤别的 python）
call "%~dp0tools\env-detect.bat"

echo ==================================================
echo   停止 文旅智能辅助 · AIRI 网页版   v4.0
echo   本版本端口：%PORT%
echo   会一并停掉它依赖的 Qwen TTS 语音服务（7860）
echo   Ollama 保留不动
echo ==================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\stop-services.ps1" -TtsHome "%TTS_HOME%" -ProjectRoot "%ROOT%" -Port %PORT% -TtsPort %TTS_PORT%

echo.
echo ---- 复查 ----
set "LEFT=0"
netstat -ano | findstr "LISTENING" | findstr ":%PORT% " >nul 2>nul
if not errorlevel 1 ( echo   [注意] 端口 %PORT% 还有进程在监听 & set "LEFT=1" ) else ( echo   端口 %PORT% 已释放 )
netstat -ano | findstr "LISTENING" | findstr ":%TTS_PORT% " >nul 2>nul
if not errorlevel 1 ( echo   [注意] 端口 %TTS_PORT% 还有进程在监听 & set "LEFT=1" ) else ( echo   端口 %TTS_PORT% 已释放 )

curl -s -m 3 http://127.0.0.1:11434/api/tags >nul 2>nul
if not errorlevel 1 ( echo   Ollama 仍在运行（按要求保留） ) else ( echo   Ollama 本来就没在运行 )

echo.
if "%LEFT%"=="1" (
  echo   还有残留进程。可以在任务管理器里找 node.exe / python.exe 手动结束，
  echo   或者把上面的 PID 发给我们排查。
) else (
  echo   全部清理干净了。
)
echo.
pause
exit /b 0
