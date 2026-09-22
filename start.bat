@echo off
REM ★ chcp 65001：本文件是 UTF-8（无 BOM）且含中文提示，而中文 Windows 的
REM 控制台默认是 GBK(936)。不切码页的话中文会显示成乱码
REM （一键部署.bat 就是这么做的，install.bat 原来漏了这句、已补）。
chcp 65001 >nul
setlocal enabledelayedexpansion

title 智能文旅辅助系统 - 启动

cd /d "%~dp0"

REM ============================================================
REM  Force UTF-8 mode for Python. See install.bat for the long story:
REM  "pip install -e ." writes a .pth file in UTF-8, site.py reads it in
REM  the locale code page (GBK), and this project lives under a path
REM  with non-ASCII characters - without this the venv python dies.
REM
REM  Keep the quotes:  set PYTHONUTF8=1 && ...  leaves a trailing space
REM  in the value and python rejects it as invalid.
REM ============================================================
set "PYTHONUTF8=1"

REM ============================================================
REM  跳过语音服务的办法（临时想省显存时用）：
REM     start.bat notts      或先  set WENLV_NO_TTS=1
REM ============================================================
set "WANT_TTS=1"
if /i "%~1"=="notts" set "WANT_TTS="
if /i "%~1"=="--no-tts" set "WANT_TTS="
if defined WENLV_NO_TTS set "WANT_TTS="

REM ============================================================
REM  Locate Python: project venv - uv - py launcher - PATH - common dirs
REM ============================================================
set "PYEXE="
set "PYARGS="
set "HAS_UV="

uv --version >nul 2>nul && set "HAS_UV=1"

if exist "%~dp0backend\.venv\Scripts\python.exe" (
    set "PYEXE=%~dp0backend\.venv\Scripts\python.exe"
    goto :py_ready
)
if defined HAS_UV (
    set "PYEXE=uv"
    set "PYARGS=run python"
    goto :py_ready
)
py -3 --version >nul 2>nul && ( set "PYEXE=py" & set "PYARGS=-3" )
if not defined PYEXE ( python --version >nul 2>nul && set "PYEXE=python" )
if not defined PYEXE ( python3 --version >nul 2>nul && set "PYEXE=python3" )
if not defined PYEXE (
    for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
        if exist "%%d\python.exe" if not defined PYEXE set "PYEXE=%%d\python.exe"
    )
)

:py_ready
if not defined PYEXE (
    echo [错误] 没找到 Python。请先运行 install.bat。
    pause
    exit /b 1
)

REM ============================================================
REM  确认这个 python 真能跑起后端。
REM
REM  为什么需要这一道：上面那串查找是「项目 venv → uv → py → python → …」，
REM  一个**刚 clone 下来**的人没有 backend\.venv、也没装 uv，于是会落到系统
REM  Python 上；而系统 Python 里通常没有本项目的依赖，启动时抛的是
REM      ModuleNotFoundError: No module named 'uvicorn'
REM  这种跟"你还没装依赖"完全看不出关系的报错。
REM  （实测：从 GitHub 克隆一份直接双击 start.bat，就是这个问题。）
REM
REM  用的确实是项目 venv、或走 uv 的，跳过这道检查。
REM ============================================================
set "PY_IS_PROJECT_VENV="
echo %PYEXE% | findstr /i "\.venv" >nul 2>nul && set "PY_IS_PROJECT_VENV=1"
if not defined PY_IS_PROJECT_VENV if /i not "%PYEXE%"=="uv" (
    "%PYEXE%" %PYARGS% -c "import uvicorn, fastapi" >nul 2>nul
    if errorlevel 1 (
        echo.
        echo [错误] 项目依赖还没装 —— 当前的 Python 是 %PYEXE%
        echo.
        echo        请先双击  install.bat      （只装 Python 依赖）
        echo        或双击      一键部署.bat    （连本地大模型一起装）
        echo.
        echo        装完再运行本脚本。想先看看缺什么，可以双击 检查环境.bat
        echo.
        pause
        exit /b 1
    )
)

if not exist "public\index.html" (
    echo [错误] 缺少 public\index.html —— 前端界面是必需的。
    pause
    exit /b 1
)

REM ---- Ollama check: the whole product is local inference ----
set "OLLAMA_OK="
where curl >nul 2>nul && (
    curl -s -m 3 http://localhost:11434/api/tags >nul 2>nul && set "OLLAMA_OK=1"
)
if not defined OLLAMA_OK (
    echo.
    echo [警告] Ollama 没在 http://localhost:11434 响应。
    echo        页面还能打开，但**生成方案会失败**。
    echo        先把 Ollama 起起来（桌面图标，或命令行 ollama serve），再刷新页面。
    echo.
)

REM ============================================================
REM  语音合成服务（Qwen TTS WebUI —— 独立进程、独立显存）
REM
REM  为什么在这里拉起它：它和本项目是两个进程。不启动的话 /api/tts
REM  一律 503 —— 形象全程静音，**而且口型也不会动**（口型是拿音频的
REM  频谱驱动的，没有音频就没得分析）。用户点「🔊 朗读」会以为功能坏了。
REM
REM  为什么先检查再起：重复启动会抢 7860 端口，第二个进程直接报错退出，
REM  还白占一次显存。
REM ============================================================
echo.
echo [1/2] 语音合成服务 ...
set "TTS_RUN="
where curl >nul 2>nul && (
    curl -s -m 3 http://127.0.0.1:7860/qwenapi/v1/models >nul 2>nul && set "TTS_RUN=1"
)

if not defined WANT_TTS (
    echo       已跳过（start.bat notts）。形象会静音、嘴也不会动。
    goto :tts_done
)
if defined TTS_RUN (
    echo       OK  已经在跑（http://127.0.0.1:7860）
    goto :tts_done
)

REM 找安装位置：QWEN_TTS_HOME - qwen-tts-home.txt - tools\find-tts.ps1
set "TTS_HOME="
if defined QWEN_TTS_HOME call :TTS_SET "%QWEN_TTS_HOME%"
if not defined TTS_HOME if exist "%~dp0qwen-tts-home.txt" (
    REM 注意：这里必须是 `type "文件"`（反引号里跑命令）。
    REM 写成 for /f "usebackq" ... in ("文件") 会把那个带引号的串**当成字面量**，
    REM 文件根本不会被读 —— 5.0 那份脚本就踩过这个坑，注释记在 start-tts.bat 里。
    for /f "usebackq delims=" %%p in (`type "%~dp0qwen-tts-home.txt"`) do call :TTS_SET "%%~p"
)
if not defined TTS_HOME (
    for /f "usebackq delims=" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\find-tts.ps1" 2^>nul`) do call :TTS_SET "%%~p"
)

if not defined TTS_HOME (
    echo       [跳过] 本机没装 Qwen TTS WebUI —— 形象会静音、嘴也不会动。
    echo              装：https://github.com/licyk/qwen-tts-webui
    echo              装完在项目根建 qwen-tts-home.txt，里面写安装路径（一行）
    goto :tts_done
)

echo       正在后台启动（首次加载权重要 30 秒到几分钟，期间朗读会 503）...
echo       ^>^> 它和 Ollama 共用同一张显卡：8G 卡上两个都开，
echo          显存只剩两三百 MB（实测 7720 / 8188 MiB）。生成会变慢，但能用。
start "Qwen TTS 语音服务" /min cmd /c call "%~dp0tools\start-tts.bat"

:tts_done

echo.
echo [2/2] 后端服务 ...
echo.
echo  ==================================================
echo    网页界面 : http://localhost:8000
echo    接口文档 : http://localhost:8000/docs
echo    健康检查 : http://localhost:8000/api/health
echo    按 Ctrl+C 停止本窗口（语音那个窗口要单独关）
echo  ==================================================
echo.

REM Open the browser a moment after the server starts.
REM Use ping instead of "timeout /t": timeout.exe exits with
REM "Input redirection is not supported" whenever stdin is not a real
REM console (a redirect, a CI runner, a background job), and the browser
REM then never opens. ping -n 5 is the portable 4-second sleep.
start "" /b cmd /c "ping -n 5 127.0.0.1 >nul & start http://localhost:8000"

pushd backend
"%PYEXE%" %PYARGS% -m uvicorn app.main:app --host 0.0.0.0 --port 8000
popd

echo.
echo 后端已停止。
pause
exit /b 0

REM ============================================================
REM  :TTS_SET  只在目录看起来确实是 Qwen TTS 安装时才接受
REM ============================================================
:TTS_SET
if defined TTS_HOME exit /b 0
if "%~1"=="" exit /b 0
if not exist "%~1\core\launch.py" exit /b 0
if not exist "%~1\python\python.exe" exit /b 0
set "TTS_HOME=%~1"
exit /b 0