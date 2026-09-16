@echo off
chcp 936 >nul
cd /d "%~dp0"
title 文旅智能辅助 · 一键启动

setlocal enabledelayedexpansion
set "ROOT=%~dp0"
REM 三个版本各用一个端口，才能同时开着做对比演示：
REM     2.0 原始版 → 8200      2.2 → 8100      3.1 → 8000
set "VER=3.1"
if not defined PORT set "PORT=8000"
set "TTS_PORT=7860"

echo ==================================================
echo   文旅智能辅助 · AIRI 网页版   v!VER!
echo   本地一键启动
echo.
echo   本版本端口：!PORT!        ^(2.0=8200 / 2.2=8100 / 3.1=8000^)
echo ==================================================
echo.
echo   本脚本会把下面这些全部拉起来：
echo     1. 本机 Ollama（对话 / 视觉 / 记忆向量）
echo     2. 本机 Qwen TTS 语音合成服务
echo     3. 文旅智能辅助网页服务
echo   然后自动打开浏览器。
echo.

REM ---------- 0. 先找 Qwen TTS 装在哪（找不到也不阻断） ----------
call "%~dp0tools\env-detect.bat"

REM ============================================================
REM 1/5  Node.js
REM ============================================================
where node >nul 2>nul
if errorlevel 1 goto NO_NODE
for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
echo [1/5] Node.js !NODEVER!  OK

REM ============================================================
REM 2/5  Ollama
REM ============================================================
echo [2/5] 检查本机 Ollama ...
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
if !OLLAMA_TRY! LSS 12 goto WAIT_OLLAMA
goto NO_OLLAMA

:OLLAMA_OK
for /f "delims=" %%m in ('node -e "fetch('http://127.0.0.1:11434/api/tags').then(r=>r.json()).then(d=>{const n=(d.models||[]).map(x=>x.name);const p=n.find(x=>/^qwen2\.5:7b/.test(x))||n.find(x=>/^qwen3/.test(x))||n[0];console.log(p||'(一个模型都没有)')}).catch(()=>console.log('未知'))"') do echo        对话模型：%%m
goto CHECK_MODELS

:NO_OLLAMA
echo        [警告] 没能连上本机 Ollama（已尝试自动启动并等待约 35 秒）。
echo        服务仍会启动，但对话 / 视觉 / 记忆向量都用不了。
echo        手动排查：命令行执行 ollama serve，另开窗口执行 ollama list
echo.

REM ============================================================
REM 3/5  Ollama 模型自检（只提示，不在这里下载）
REM ============================================================
:CHECK_MODELS
echo [3/5] 检查本机已下载的大模型 ...
set "MISSING="
call :TEST_MODEL "qwen2.5:7b"
if errorlevel 1 ( set "MISSING=!MISSING! qwen2.5:7b（对话）" ) else ( echo        对话模型 qwen2.5:7b  OK )
call :TEST_MODEL "nomic-embed-text"
if errorlevel 1 ( set "MISSING=!MISSING! nomic-embed-text（记忆向量）" ) else ( echo        向量模型 nomic-embed-text  OK )
call :TEST_MODEL "qwen2.5vl:3b"
if not errorlevel 1 goto VISION_3B
call :TEST_MODEL "qwen2.5vl:7b"
if not errorlevel 1 goto VISION_7B
set "MISSING=!MISSING! qwen2.5vl:3b（视觉理解）"
echo        视觉模型（没有，拍照识景会用不了）
goto CHECK_MODELS_DONE

:VISION_3B
echo        视觉模型 qwen2.5vl:3b  OK
goto CHECK_MODELS_DONE

:VISION_7B
echo        视觉模型 qwen2.5vl:7b  OK

:CHECK_MODELS_DONE
if defined MISSING (
  echo.
  echo        [提示] 缺少这些模型：!MISSING!
  echo        双击项目根目录的「检测并安装依赖.bat」可以自动下载。
  echo.
)

REM ============================================================
REM 4/5  Qwen TTS 语音合成
REM ============================================================
echo [4/5] 检查本机 Qwen TTS 语音合成 ...
call :CHECK_PORT %TTS_PORT%
if not errorlevel 1 goto TTS_ALREADY

if not defined TTS_HOME goto NO_TTS_HOME

echo        未运行，正在自动启动 ...
start "文旅-QwenTTS语音服务" /min /D "%~dp0tools" cmd /c "start-tts.bat"

set TTS_TRY=0
:WAIT_TTS
ping -n 3 127.0.0.1 >nul
call :PING_TTS
if not errorlevel 1 goto TTS_OK
set /a TTS_TRY+=1
if !TTS_TRY! LSS 20 goto WAIT_TTS
echo        [警告] 等了约 60 秒还没连上语音服务。
echo        去看那个标题是「文旅-QwenTTS语音服务」的窗口，里面会有具体报错。
echo        首次启动要加载模型，慢一点是正常的，服务照样能先用。
echo.
goto START_WEB

:TTS_ALREADY
echo        Qwen TTS 已在运行（http://127.0.0.1:%TTS_PORT%）
goto START_WEB

:TTS_OK
echo        Qwen TTS 已连接（http://127.0.0.1:%TTS_PORT%）
goto START_WEB

:NO_TTS_HOME
echo        [提示] 没找到本机的 Qwen TTS WebUI，跳过（角色不会出声，其它功能正常）。
echo        想启用语音：先装 Qwen TTS WebUI，再在项目根目录建一个
echo        qwen-tts-home.txt 写上它的安装路径，或者设环境变量 QWEN_TTS_HOME。
echo        安装包：https://github.com/licyk/qwen-tts-webui
echo.

REM ============================================================
REM 5/5  启动网页服务并打开浏览器
REM ============================================================
:START_WEB
echo [5/5] 启动网页服务 ...
call :CHECK_PORT %PORT%
if not errorlevel 1 goto WEB_ALREADY

start "文旅智能辅助-网页服务" /D "%ROOT%" cmd /k "node server.js"

set WEB_TRY=0
:WAIT_WEB
ping -n 2 127.0.0.1 >nul
call :CHECK_PORT %PORT%
if not errorlevel 1 goto WEB_OK
set /a WEB_TRY+=1
if !WEB_TRY! LSS 15 goto WAIT_WEB
echo        [错误] 网页服务没起来。去看标题是「文旅智能辅助-网页服务」那个窗口里的报错。
echo.
goto DONE

:WEB_ALREADY
echo        v!VER! 的网页服务本来就在运行（http://localhost:!PORT!）
goto OPEN_BROWSER

:WEB_OK
echo        网页服务已启动

:OPEN_BROWSER
start "" http://localhost:!PORT!
echo.
echo ==================================================
echo   全部就绪，浏览器已打开 http://localhost:!PORT!
echo   当前版本：v!VER!
echo ==================================================
echo.
echo   窗口说明（可以最小化，别关错）：
echo     文旅智能辅助-网页服务    ^<- 网页服务本体，日志在这个窗口
echo     文旅-QwenTTS语音服务     ^<- 语音合成服务（没装 TTS 就不会有这个窗口）
echo.
echo   要全部关掉：双击项目根目录的 stop.bat（会保留 Ollama）。
echo   本窗口可以直接关闭，不影响服务运行。
echo.

:DONE
echo.
pause
exit /b 0

REM ============================================================
REM 子过程
REM ============================================================

REM 探测 Ollama 是否在线（在线则 errorlevel=0）
:PING_OLLAMA
curl -s -m 3 http://127.0.0.1:11434/api/tags >nul 2>nul
exit /b %errorlevel%

REM 探测 TTS 是否在线
:PING_TTS
curl -s -m 3 http://127.0.0.1:7860/qwenapi/v1/models >nul 2>nul
exit /b %errorlevel%

REM 探测某个端口是否在监听：call :CHECK_PORT 8000
:CHECK_PORT
netstat -ano | findstr "LISTENING" | findstr ":%~1 " >nul 2>nul
exit /b %errorlevel%

REM 探测某个 ollama 模型是否已下载：call :TEST_MODEL "qwen2.5:7b"
REM 用 ollama show 的退出码判断，不去解析 ollama list 的文本 ——
REM 列表里的名字是带标签的（nomic-embed-text:latest），前缀匹配很容易漏。
:TEST_MODEL
ollama show %~1 >nul 2>nul
exit /b %errorlevel%

:NO_NODE
echo [错误] 未检测到 Node.js。
echo        请先安装 Node.js 18 或更高版本：https://nodejs.org
echo.
pause
exit /b 1
