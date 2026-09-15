@echo off
chcp 936 >nul
cd /d "%~dp0"
title 文旅智能辅助 · 本地部署启动器
echo ================================================
echo    文旅智能辅助 Skill · 本地大模型启动器
echo ================================================
echo.

rem ---- 1. 检查 Ollama ----
where ollama >nul 2>nul
if %errorlevel% neq 0 goto NO_OLLAMA

rem ---- 2. 检查 Node.js（要求 18 或更高版本）----
where node >nul 2>nul
if %errorlevel% neq 0 goto NO_NODE

set NODE_MAJOR=0
for /f "tokens=1 delims=." %%a in ('node -v') do set NODE_MAJOR=%%a
set NODE_MAJOR=%NODE_MAJOR:v=%
if %NODE_MAJOR% LSS 18 goto NODE_OLD

rem ---- 3. 检查本地模型，缺失则自动下载（仅首次，约 4.7GB）----
rem 用行首正则匹配，避免 qwen2.5:7b-instruct 这类名称被误判为已安装
ollama list | findstr /R /C:"^qwen2.5:7b " >nul
if %errorlevel%==0 goto HAVE_MODEL
echo [提示] 未找到模型 qwen2.5:7b，开始下载（仅首次，请耐心等待）...
ollama pull qwen2.5:7b
:HAVE_MODEL

rem ---- 4. 端口已在监听：说明服务已经跑着，直接打开页面 ----
netstat -ano | findstr /C:"LISTENING" | findstr /C:":8000 " >nul
if %errorlevel%==0 goto ALREADY

rem ---- 5. 启动服务，并轮询等待它就绪（最多约 10 秒）----
rem 这里不用 timeout 命令：stdin 被重定向时 timeout 会直接报错退出，导致等待失效
echo [启动] 正在启动本地服务器 ...
start "wenlv-server" /min cmd /c "node server.js > server.log 2>&1"

set WAIT=0
:WAIT_LOOP
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr /C:"LISTENING" | findstr /C:":8000 " >nul
if %errorlevel%==0 goto STARTED
set /a WAIT+=1
if %WAIT% LSS 10 goto WAIT_LOOP
goto START_FAIL

:STARTED
start "" "http://localhost:8000"
echo.
echo [完成] 服务已在后台运行，页面已打开。
echo        停止服务：双击 stop.bat
echo.
pause
exit /b 0

:ALREADY
echo [提示] 服务已经在运行，正在打开页面 ...
start "" "http://localhost:8000"
echo.
echo   页面地址：http://localhost:8000
echo   如果浏览器没有自动打开，请手动复制上面的地址访问。
echo.
pause
exit /b 0

:NO_OLLAMA
echo [错误] 未检测到 Ollama。请先安装：
echo        winget install Ollama.Ollama
echo.
pause
exit /b 1

:NO_NODE
echo [错误] 未检测到 Node.js。请先安装 Node.js 18 或更高版本：
echo        https://nodejs.org
echo.
pause
exit /b 1

:NODE_OLD
echo [错误] Node.js 版本过低，请升级到 18 或更高版本。
echo.
pause
exit /b 1

:START_FAIL
echo [错误] 服务未能在 10 秒内启动，请查看同目录下的 server.log 了解原因。
echo.
pause
exit /b 1
