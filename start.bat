@echo off
setlocal

title Wenlv Assistant (HikiTravel + AIRI UI) - Start

cd /d "%~dp0"

REM ============================================================
REM Force UTF-8 mode for Python. See install.bat for the long story:
REM pip install -e . writes a .pth file in UTF-8, site.py reads it in
REM the locale code page (GBK), and this project lives under a path
REM with non-ASCII characters - without this the venv python dies.
REM
REM Keep the quotes:  set PYTHONUTF8=1 && ...  leaves a trailing space
REM in the value and python rejects it as invalid.
REM ============================================================
set "PYTHONUTF8=1"

REM ============================================================
REM Locate Python: project venv - uv - py launcher - PATH - common dirs
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
    echo [ERROR] Python not found. Run install.bat first.
    pause
    exit /b 1
)

if not exist "public\index.html" (
    echo [ERROR] public\index.html is missing - the AIRI web UI is required.
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
    echo [WARN] Ollama is not answering on http://localhost:11434
    echo        The page still opens, but plan generation will fail.
    echo        Start Ollama first, then refresh the page.
    echo.
)

echo.
echo  ==================================================
echo    Web UI   : http://localhost:8000
echo    API docs : http://localhost:8000/docs
echo    Health   : http://localhost:8000/api/health
echo    Press Ctrl+C to stop.
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
echo Service stopped.
pause
