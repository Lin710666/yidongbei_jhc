@echo off
setlocal

title Travel Planner - Start

cd /d "%~dp0"

REM Force Python to read .pth files as UTF-8 - see install.bat for the full
REM explanation. Short version: a .pth is decoded with the system codec, and a
REM non-ASCII path inside one makes the interpreter die at startup.
set "PYTHONUTF8=1"

REM Keep this file ASCII-only. cmd reads a .bat with the console code page, and
REM non-ASCII characters shift the parser offset, which eats the "REM" keyword
REM off following lines and makes cmd run the leftover text as commands.
chcp 65001 >nul

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
    echo [ERROR] Python not found. Please run install.bat first.
    pause
    exit /b 1
)

REM Dependency check. Without a venv this falls back to the system Python,
REM where the dependencies usually are NOT installed - uvicorn would just
REM flash a ModuleNotFoundError and the window would close. Say it clearly.
"%PYEXE%" %PYARGS% -c "import uvicorn, fastapi" >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Backend dependencies are not installed.
    echo         Please run install.bat first - it creates backend\.venv
    echo         and installs everything into it.
    pause
    exit /b 1
)

if not exist "frontend\dist\index.html" (
    echo [ERROR] Frontend build not found. Please run install.bat first.
    pause
    exit /b 1
)

REM Load backend\.env if present
if exist "backend\.env" (
    for /f "usebackq eol=# tokens=*" %%a in ("backend\.env") do set %%a
)

set "STATIC_DIR=%~dp0frontend\dist"
set "DB_PATH=%~dp0backend\data\travelplanner.db"

echo.
echo Starting service. Open http://localhost:8000  (Ctrl+C to stop)
echo.

pushd backend
REM Always prefer the venv interpreter: the dependencies live in it.
if exist "%~dp0backend\.venv\Scripts\python.exe" (
    "%~dp0backend\.venv\Scripts\python.exe" -m uvicorn app.main:app --host 0.0.0.0 --port 8000
) else (
    "%PYEXE%" %PYARGS% -m uvicorn app.main:app --host 0.0.0.0 --port 8000
)
popd

pause