@echo off
REM ★ chcp 65001 不能省：本文件是 UTF-8（无 BOM）且含中文提示，中文 Windows 的
REM 控制台默认是 GBK(936)，不切码页中文会变成乱码。
REM
REM ★★ 本文件在仓库里必须是 CRLF 换行。cmd.exe 不认 LF —— LF 版会直接报
REM    "The syntax of the command is incorrect."。靠仓库根目录的 .gitattributes
REM    里 `*.bat -text` 保证（见那个文件里的实测记录）。
chcp 65001 >nul
setlocal EnableDelayedExpansion
title 智能文旅辅助系统 HikiTravel-AIRI-1.3 - 一键部署

echo.
echo  ============================================================
echo    智能文旅辅助系统 HikiTravel-AIRI-1.3   一键部署
echo    会安装：Python 依赖 / 本地大模型
echo.
echo    只想检查环境不装东西：双击  检查环境.bat
echo  ============================================================
echo.

cd /d "%~dp0"
set "ROOT=%CD%"
set "PY=%ROOT%\backend\.venv\Scripts\python.exe"
set "FAIL="

:: ---------------------------------------------------------------- 1. Python
echo [1/4] 检查 Python...
where python >nul 2>nul
if errorlevel 1 (
  echo    [!] 没找到 python。请先装 Python 3.10+ 并勾选 "Add to PATH"
  echo        下载： https://www.python.org/downloads/
  set "FAIL=1"
  goto :report
)
for /f "tokens=2" %%v in ('python --version 2^>^&1') do set "PYVER=%%v"
echo    [OK] Python %PYVER%

:: ---------------------------------------------------------------- 2. uv
echo.
echo [2/4] 检查 uv（Python 包管理器）...
where uv >nul 2>nul
if errorlevel 1 (
  echo    [..] 没装 uv，正在安装...
  python -m pip install --user uv 2>nul
  if errorlevel 1 (
    echo    [!] uv 安装失败。请手动执行： pip install uv
    set "FAIL=1"
    goto :report
  )
  set "PATH=%APPDATA%\Python\Scripts;%PATH%"
)
echo    [OK] uv 就绪

:: ---------------------------------------------------------------- 3. 后端依赖
echo.
echo [3/4] 安装后端依赖...
pushd backend
if exist "pyproject.toml" (
  echo    [..] uv sync
  call uv sync
  if errorlevel 1 ( echo    [!] uv sync 失败 & set "FAIL=1" & popd & goto :report )
) else (
  echo    [..] 建虚拟环境 + 装依赖
  if not exist ".venv" call uv venv .venv
  if exist "requirements.txt" (
    call uv pip install --python ".venv\Scripts\python.exe" -r requirements.txt
  ) else (
    call uv pip install --python ".venv\Scripts\python.exe" fastapi uvicorn httpx python-dotenv pydantic requests
  )
  if errorlevel 1 ( echo    [!] 依赖安装失败 & set "FAIL=1" & popd & goto :report )
)
:: 音频抽取要用（从视频里扒音轨）。装不上不影响主流程，只影响"上传视频自动提取音频"。
call uv pip install --python ".venv\Scripts\python.exe" av 2>nul
popd
echo    [OK] 后端依赖就绪

:: ---------------------------------------------------------------- 3.5 前端依赖
if exist "package.json" (
  echo.
  echo [3.5/4] 安装前端依赖...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo    [!] 没找到 npm，跳过。需要 Node.js 18+： https://nodejs.org/
  ) else (
    if not exist "node_modules" (
      call npm install --no-audit --no-fund
      if errorlevel 1 ( echo    [!] npm install 失败（不影响启动，只影响构建脚本） )
    ) else (
      echo    [OK] node_modules 已存在
    )
  )
)

:: ---------------------------------------------------------------- 4. 本地模型
echo.
echo [4/4] 检查本地大模型（Ollama）...
where ollama >nul 2>nul
if errorlevel 1 (
  echo    [!] 没找到 Ollama。请先安装： https://ollama.com/download
  echo        装完重跑本脚本会自动拉模型。不装也能跑（会用纯规则引擎兜底）
) else (
  echo    [..] 启动 Ollama 服务...
  start "" /min ollama serve
  REM 用 ping 而不是 timeout /t 6：timeout.exe 在 stdin 不是真实控制台时
  REM （重定向、CI、后台任务）会直接报 "Input redirection is not supported"
  REM 并立刻返回，于是 Ollama 还没起来就去 pull 模型了。
  REM ping -n 7 是通用的"等约 6 秒"（第一次是立即返回的）。
  ping -n 7 127.0.0.1 >nul

  echo    [..] 拉取对话模型 qwen2.5:7b（约 4.4GB，首次会慢）...
  ollama pull qwen2.5:7b
  if errorlevel 1 ( echo    [!] qwen2.5:7b 拉取失败 )

  echo    [..] 拉取向量模型 nomic-embed-text（约 0.3GB）...
  ollama pull nomic-embed-text
  if errorlevel 1 ( echo    [!] nomic-embed-text 拉取失败 )

  echo    [OK] 模型就绪
)

:report
echo.
echo  ============================================================
if defined FAIL (
  echo    部署过程中有失败项，请看上面的 [!] 提示
) else (
  echo    部署完成！
  echo.
  echo    启动：双击  start.bat
  echo    地址： http://localhost:8000
  echo.
  echo    可选：把高德 key / 云端模型 key 填进  backend\.env
  echo          （不填也能跑：地图瓦片走内置 key，模型走本地）
)
echo  ============================================================
echo.
pause
endlocal
