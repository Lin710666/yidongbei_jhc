@echo off
REM ★ chcp 65001 不能省：本文件是 UTF-8（无 BOM），里面有中文提示，
REM 而中文 Windows 的控制台默认是 GBK(936) —— 不切到 65001 的话，
REM 那些中文会以 UTF-8 字节被当成 GBK 显示，整段变成乱码
REM （"一键部署.bat" 就是因为带了这句才正常）。原来这里少了它。
chcp 65001 >nul
setlocal enabledelayedexpansion

title Wenlv Assistant (HikiTravel + AIRI UI) - One-Click Deploy

cd /d "%~dp0"

REM ============================================================
REM Force UTF-8 mode for Python.
REM
REM Why this is needed: "pip install -e ." writes a .pth file that
REM stores the project path in UTF-8, but site.py reads .pth with the
REM locale code page (GBK on Chinese Windows). When the project sits
REM in a path containing non-ASCII characters (this project's folder name
REM is Chinese), the venv python dies inside init_import_site with a
REM fatal UnicodeDecodeError that never mentions the path, so it looks
REM like a broken Python install.
REM
REM Keep the quotes: writing  set PYTHONUTF8=1 && ...  would leave a
REM trailing space in the value and python rejects it as invalid.
REM ============================================================
set "PYTHONUTF8=1"

echo.
echo  ==================================================
echo    Wenlv Assistant - One-Click Deploy
echo    Backend: HikiTravel (FastAPI)  UI: AIRI (static)
echo  ==================================================
echo.

REM ============================================================
REM 1. Locate Python: project venv - uv - py launcher - PATH - common dirs
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
if not defined PYEXE (
    python --version >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE (
    python3 --version >nul 2>nul && set "PYEXE=python3"
)
if not defined PYEXE (
    for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
        if exist "%%d\python.exe" if not defined PYEXE set "PYEXE=%%d\python.exe"
    )
)
if not defined PYEXE (
    for /d %%d in ("%ProgramFiles%\Python3*") do (
        if exist "%%d\python.exe" if not defined PYEXE set "PYEXE=%%d\python.exe"
    )
)
if not defined PYEXE (
    for /d %%d in ("%ProgramFiles(x86)%\Python3*") do (
        if exist "%%d\python.exe" if not defined PYEXE set "PYEXE=%%d\python.exe"
    )
)

:py_ready
if not defined PYEXE (
    echo [ERROR] Python 3.10+ was not found.
    echo         Download: https://www.python.org/downloads/
    echo         Tick "Add python.exe to PATH" during setup, then re-run.
    goto :fail
)
echo [1/3] Python found: %PYEXE%

REM ============================================================
REM 2. Create the virtualenv when it is missing
REM ============================================================
if not exist "backend\.venv\Scripts\python.exe" (
    if defined HAS_UV (
        echo [2/3] uv detected - dependencies will be installed with uv sync
    ) else (
        echo [2/3] Creating virtualenv at backend\.venv ...
        pushd backend
        "%PYEXE%" %PYARGS% -m venv .venv
        if errorlevel 1 (
            popd
            echo [ERROR] Failed to create the virtualenv.
            goto :fail
        )
        popd
        set "PYEXE=%~dp0backend\.venv\Scripts\python.exe"
        set "PYARGS="
    )
) else (
    echo [2/3] Virtualenv already exists, reusing it
)

REM ============================================================
REM 3. Install backend dependencies
REM    The frontend is plain static files under public\ - there is
REM    no npm build step at all, which is why this script is short.
REM ============================================================
echo [3/3] Installing backend dependencies (first run: about 1 minute) ...

if defined HAS_UV (
    pushd backend
    uv sync
    if errorlevel 1 (
        popd
        echo [ERROR] Backend dependency install failed [uv sync].
        goto :fail
    )
    popd
) else (
    pushd backend
    "%PYEXE%" %PYARGS% -m pip install -e . --quiet
    if errorlevel 1 (
        popd
        echo [ERROR] Backend dependency install failed [pip].
        goto :fail
    )
    popd
)

REM ============================================================
REM 4. backend\.env
REM    AMAP_API_KEY is deliberately NOT hard-coded here: a key baked
REM    into a public repo gets scraped and the daily quota runs out,
REM    which is exactly what happens on demo day. Fill in your own.
REM ============================================================
if not exist "backend\.env" (
    (
        echo # AMap Web Service key - REQUIRED for POI / weather / routing.
        echo # Apply for a free one at https://console.amap.com/dev/key/app
        echo AMAP_API_KEY=
        echo.
        echo # Ollama local inference
        echo # 用 127.0.0.1 而不是 localhost：装了 IPv6 的机器上 localhost 先解析到 ::1，
        echo # 而 Ollama 只监听 IPv4，每次探测都要白等 IPv6 超时（约 2 秒/次）。
        echo OLLAMA_BASE_URL=http://127.0.0.1:11434
        echo OLLAMA_MODEL=qwen2.5:7b
        echo OLLAMA_EMBED_MODEL=nomic-embed-text
        echo # 30s is fine for chat; plan generation needs a longer budget
        echo OLLAMA_TIMEOUT=180
    ) > "backend\.env"
    echo.
    echo  ==================================================
    echo    backend\.env was created - it still needs a key.
    echo    Open it and set AMAP_API_KEY=your_own_key
    echo    Then run start.bat.
    echo  ==================================================
    echo.
    pause
    exit /b 0
)

set "AMAP_OK="
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("backend\.env") do (
    if /i "%%a"=="AMAP_API_KEY" if not "%%b"=="" set "AMAP_OK=1"
)
if not defined AMAP_OK (
    echo.
    echo [WARN] backend\.env has no AMAP_API_KEY.
    echo        POI / weather / route lookups will fail with HTTP 503.
    echo        The app still starts; fill the key in and re-run.
    echo.
)

echo.
echo  ==================================================
echo    Deploy done. Run start.bat to launch.
echo  ==================================================
echo.
pause
exit /b 0

:fail
echo.
echo Deploy incomplete. Fix the issue above and re-run this script.
pause
exit /b 1
