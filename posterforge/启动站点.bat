@echo off
chcp 65001 >nul
setlocal

echo ==========================================================
echo   PosterForge - 宣传海报与打卡模板生成
echo ==========================================================
echo.
echo   零运行时依赖，只用 Node 内置模块。
echo   需要本机有 Node 18+ 和 Python 3.10+（带 Pillow）。
echo.

cd /d "%~dp0"

:: ---- 检查 Node ----
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 找不到 node。请先安装 Node.js 18+：https://nodejs.org/
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo   Node      %NODEVER%

:: ---- 检查 Python 与 Pillow ----
set PYEXE=
if exist "E:\devenv\Scripts\python.exe" set PYEXE=E:\devenv\Scripts\python.exe
if "%PYEXE%"=="" (
  where python >nul 2>nul
  if errorlevel 1 (
    echo [错误] 找不到 python。请安装 Python 3.10+ 并勾选 Add to PATH。
    echo.
    pause
    exit /b 1
  )
  set PYEXE=python
)
echo   Python    %PYEXE%

"%PYEXE%" -c "import PIL" >nul 2>nul
if errorlevel 1 (
  echo [错误] Python 缺少 Pillow。请执行：
  echo          "%PYEXE%" -m pip install pillow
  echo.
  pause
  exit /b 1
)
echo   Pillow    已安装

:: ---- 检查渲染器 ----
if not exist "..\poster-forge\render.py" (
  echo [错误] 找不到渲染器：..\poster-forge\render.py
  echo         本脚本需放在 site\ 目录下，且与 poster-forge\ 同级。
  echo.
  pause
  exit /b 1
)
echo   渲染器    已找到

:: ---- 启动 ----
set PF_PYTHON=%PYEXE%
echo.
echo ----------------------------------------------------------
echo   启动后浏览器访问： http://127.0.0.1:8787
echo   自检接口：         http://127.0.0.1:8787/api/health
echo   停止：             Ctrl + C
echo ----------------------------------------------------------
echo.

node server.mjs --port 8787

echo.
echo 服务已停止。
pause
