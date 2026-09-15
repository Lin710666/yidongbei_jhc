@echo off
chcp 936 >nul
cd /d "%~dp0"
title 文旅智能辅助 · AIRI 网页版

echo ==================================================
echo   文旅智能辅助 · AIRI 网页版   本地一键启动
echo ==================================================
echo.

REM ---------- 1. Node.js ----------
where node >nul 2>nul
if errorlevel 1 goto NO_NODE
for /f "delims=" %%v in ('node -v') do echo [1/4] Node.js %%v  OK

REM ---------- 2. 本机 Ollama（没起来就自动帮用户起） ----------
echo [2/4] 检查本机 Ollama ...
set OLLAMA_TRY=0
call :PING_OLLAMA
if not errorlevel 1 goto OLLAMA_OK

echo        未运行，正在自动启动 ...
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
  start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
) else (
  start "Ollama" /min cmd /c "ollama serve"
)

:WAIT_OLLAMA
ping -n 3 127.0.0.1 >nul
call :PING_OLLAMA
if not errorlevel 1 goto OLLAMA_OK
set /a OLLAMA_TRY+=1
if %OLLAMA_TRY% LSS 12 goto WAIT_OLLAMA
goto NO_OLLAMA

:OLLAMA_OK
for /f "delims=" %%m in ('node -e "fetch('http://127.0.0.1:11434/api/tags').then(r=>r.json()).then(d=>{const n=(d.models||[]).map(x=>x.name);const p=n.find(x=>/^qwen3:8b/)||n.find(x=>/^qwen2\.5:7b/)||n[0];console.log(p||'（一个模型都没有）')}).catch(()=>console.log('未知'))"') do echo        对话模型：%%m
goto CHECK_TTS

:NO_OLLAMA
echo        [警告] 没能连上本机 Ollama（已尝试自动启动并等待约 35 秒）。
echo        服务仍会启动，但对话 / 视觉 / 记忆向量都用不了。
echo        手动排查：命令行执行 ollama serve，另开窗口执行 ollama list
echo.

:CHECK_TTS
REM ---------- 3. 本机 Qwen TTS（可选，只提示不阻断） ----------
echo [3/4] 检查本机 Qwen TTS 语音合成 ...
curl -s -m 4 http://127.0.0.1:7860/qwenapi/v1/models >nul 2>nul
if errorlevel 1 goto NO_TTS
echo        Qwen TTS 已连接（http://127.0.0.1:7860）
goto START

:NO_TTS
echo        [提示] 未连接本地语音合成服务，角色不会出声（其它功能正常）。
echo        启用方式：进入 Qwen TTS WebUI 目录执行
echo                  python launch.py --nowebui --server-port 7860
echo.

:START
REM ---------- 4. 启动本地服务并打开浏览器 ----------
echo [4/4] 启动本地服务 http://localhost:8000 ...
echo.
echo        按 Ctrl+C 停止服务。
echo.
start "" http://localhost:8000
node server.js
echo.
echo 服务已退出。
pause
goto :EOF

REM ---------- 子过程：探测 Ollama 是否在线（在线则 errorlevel=0） ----------
:PING_OLLAMA
curl -s -m 3 http://127.0.0.1:11434/api/tags >nul 2>nul
exit /b %errorlevel%

:NO_NODE
echo [错误] 未检测到 Node.js。
echo        请先安装 Node.js 18 或更高版本：https://nodejs.org
echo.
pause
