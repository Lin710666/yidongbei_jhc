@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title 智能文旅辅助系统 - 环境检查

REM ============================================================
REM  逐项检查运行本项目需要的东西，把「缺什么、怎么补」列出来。
REM  只检查、不改动环境；要装依赖请运行 install.bat。
REM
REM  为什么要有它：install.bat 只负责"建 venv + 装 Python 依赖"，
REM  而实际跑起来还依赖 Ollama 服务与模型、高德 Key、TTS 服务、
REM  前端产物、媒体素材 —— 这些缺一样，界面看起来正常但功能是残的
REM  （比如没有 TTS 时形象全程静音、口型也不动）。
REM
REM  编码说明：本文件是 UTF-8（无 BOM）+ chcp 65001，与 一键部署.bat 一致。
REM  .bat 里写中文必须连同 chcp 一起写，否则中文 Windows 的控制台（936）
REM  会把 UTF-8 字节显示成乱码 —— install.bat 就漏了这句，已一并补上。
REM ============================================================

set /a OK_N=0
set /a BAD_N=0

REM ★ 必须设这个：项目装在中文路径下（「移动杯项目」），而 venv 里的 .pth
REM 是 UTF-8、site.py 按本地代码页（GBK）读 —— 不设的话 venv 的 python
REM 一启动就 fatal UnicodeDecodeError，于是所有调用都失败：版本读不到、
REM 依赖检查误报"没装齐"。start.bat / install.bat 都有这句，我第一版漏了，实测就踩到了。
set "PYTHONUTF8=1"

echo.
echo  ============================================================
echo    智能文旅辅助系统  -  环境检查
echo    只检查，不改动任何东西。要装依赖请运行 install.bat
echo  ============================================================
echo.

REM ============================================================
REM 1. Python
REM ============================================================
echo [1/8] Python ...
set "PY="
if exist "%~dp0backend\.venv\Scripts\python.exe" (
    set "PY=%~dp0backend\.venv\Scripts\python.exe"
    echo        项目自带的 venv：backend\.venv
) else (
    where py >nul 2>nul && set "PY=py -3"
    if not defined PY ( where python >nul 2>nul && set "PY=python" )
    if defined PY (
        echo        [缺] 还没有 backend\.venv
        echo             运行 install.bat 创建它（会自动装依赖）
        set /a BAD_N+=1
    ) else (
        echo        [缺] 没找到 Python
        echo             到 https://www.python.org/downloads/ 装 3.10 以上，
        echo             安装时勾选 "Add python.exe to PATH"，然后运行 install.bat
        set /a BAD_N+=1
    )
)
if defined PY (
    for /f "delims=" %%v in ('%PY% -c "import sys;print(sys.version.split()[0])" 2^>nul') do set "PYVER=%%v"
    if defined PYVER ( echo        OK  Python !PYVER! & set /a OK_N+=1 ) else ( echo        OK  Python 可用 & set /a OK_N+=1 )
)

REM ============================================================
REM 2. Python 依赖
REM ============================================================
echo [2/8] Python 依赖 ...
set "DEPS_OK="
if defined PY (
    %PY% -c "import fastapi,uvicorn,httpx,pydantic" >nul 2>nul && set "DEPS_OK=1"
)
if defined DEPS_OK (
    echo        OK   fastapi / uvicorn / httpx / pydantic 都在
    set /a OK_N+=1
) else (
    echo        [缺] 后端依赖没装齐
    echo             运行 install.bat（或 cd backend ^&^& pip install -e .）
    set /a BAD_N+=1
)

REM ============================================================
REM 3. Ollama 服务
REM ============================================================
echo [3/8] Ollama 服务 ...
set "OLLAMA_OK="
where curl >nul 2>nul && (
    curl -s -m 3 http://127.0.0.1:11434/api/tags >nul 2>nul && set "OLLAMA_OK=1"
)
if defined OLLAMA_OK (
    echo        OK   http://127.0.0.1:11434 有响应
    set /a OK_N+=1
) else (
    echo        [缺] 连不上 Ollama（整个项目靠本机推理）
    echo             装：https://ollama.com/download
    echo             装完运行一次，或双击桌面上的 Ollama 图标让它常驻
    set /a BAD_N+=1
)

REM ============================================================
REM 4. Ollama 模型
REM ============================================================
echo [4/8] Ollama 模型 ...
set "MODELS="
where ollama >nul 2>nul && (
    for /f "delims=" %%m in ('ollama list 2^>nul') do set "MODELS=!MODELS! %%m"
)
if not defined MODELS (
    echo        [跳过] 读不到模型清单（Ollama 没装或没在跑）
    set /a BAD_N+=1
) else (
    call :CHK_MODEL "qwen2.5:7b"        "对话，必须"
    call :CHK_MODEL "nomic-embed-text"  "记忆检索，强烈建议"
    call :CHK_MODEL "qwen2.5vl:3b"      "视觉理解，可选"
)

REM ============================================================
REM 5. 高德 Key
REM ============================================================
echo [5/8] 高德地图 Key ...
set "AMAP_OK="
if exist "backend\.env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%a in ("backend\.env") do (
        if /i "%%a"=="AMAP_API_KEY" if not "%%b"=="" set "AMAP_OK=1"
    )
)
if defined AMAP_OK (
    echo        OK   backend\.env 里的 AMAP_API_KEY 已填
    set /a OK_N+=1
) else (
    echo        [缺] backend\.env 没有 AMAP_API_KEY
    echo             景点/天气/路线会全部 503。去 https://console.amap.com/dev/key/app
    echo             申请一个免费的，填进 backend\.env
    set /a BAD_N+=1
)

REM ============================================================
REM 6. 前端产物
REM ============================================================
echo [6/8] 前端产物 ...
set "FE_MISS="
for %%f in ("public\index.html" "public\planner-embed.js" "public\planner-embed.css") do (
    if not exist "%%~f" set "FE_MISS=!FE_MISS! %%~nxf"
)
if defined FE_MISS (
    echo        [缺] 少这些文件：!FE_MISS!
    echo             planner-embed.* 由 frontend 打包产生，见 README「重新构建并更新工作台」
    set /a BAD_N+=1
) else (
    echo        OK   index.html / planner-embed.js / planner-embed.css 都在
    set /a OK_N+=1
)

REM ============================================================
REM 7. Qwen TTS（语音合成）
REM ============================================================
echo [7/8] 语音合成（可选）...
set "TTS_HOME="
for /f "usebackq delims=" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\find-tts.ps1" 2^>nul`) do (
    if not defined TTS_HOME if exist "%%~p\core\launch.py" set "TTS_HOME=%%~p"
)
set "TTS_RUN="
where curl >nul 2>nul && (
    curl -s -m 3 http://127.0.0.1:7860/qwenapi/v1/models >nul 2>nul && set "TTS_RUN=1"
)
if defined TTS_RUN (
    echo        OK   语音服务在跑（http://127.0.0.1:7860）
    set /a OK_N+=1
) else (
    if defined TTS_HOME (
        echo        [提示] 装了但没在跑：!TTS_HOME!
        echo               要语音和口型就双击 tools\start-tts.bat
        echo               注意它和 Ollama 抢同一张显卡，两个都开时显存会很紧
    ) else (
        echo        [提示] 没装 Qwen TTS WebUI —— 形象会全程静音、嘴也不会动
        echo               装：https://github.com/licyk/qwen-tts-webui
        echo               装完在项目根建一个 qwen-tts-home.txt，里面写安装路径一行
    )
)

REM ============================================================
REM 8. 媒体素材 + 端口
REM ============================================================
echo [8/8] 媒体素材与端口 ...
if exist "data\videos" (
    set "VCNT=0"
    for %%f in ("data\videos\*") do set /a VCNT+=1
    echo        data\videos  !VCNT! 个文件
) else (
    echo        [提示] 没有 data\videos —— 开屏会用程序化西湖场景代替
)
if exist "data\audio" (
    set "ACNT=0"
    for %%f in ("data\audio\*") do set /a ACNT+=1
    echo        data\audio   !ACNT! 个文件
) else (
    echo        [提示] 没有 data\audio —— 「配乐」是空的
)
set /a OK_N+=1
echo.
echo        端口占用情况：
netstat -ano | findstr /C:"LISTENING" | findstr /C:":8000 " >nul && (echo           8000   本项目的后端，已在跑) || (echo           8000   空闲)
netstat -ano | findstr /C:"LISTENING" | findstr /C:":7860 " >nul && (echo           7860   语音服务，在跑) || (echo           7860   未占用)
netstat -ano | findstr /C:"LISTENING" | findstr /C:":11434 " >nul && (echo           11434  Ollama，在跑) || (echo           11434  未占用)

REM ============================================================
REM 汇总
REM ============================================================
echo.
echo  ============================================================
echo    检查完毕：通过 !OK_N! 项，有问题 !BAD_N! 项
echo  ============================================================
if !BAD_N! GTR 0 (
    echo.
    echo  上面标 [缺] 的就是要补的，每项后面都写了怎么补。
    echo.
    echo  装依赖：双击 install.bat
    echo  启动服务：双击 start.bat（默认会顺带把语音服务也拉起来）
) else (
    echo.
    echo  都齐了，直接双击 start.bat 就能用。
)
echo.
pause
exit /b 0

REM ============================================================
REM  :CHK_MODEL 模型名 用途说明
REM ============================================================
:CHK_MODEL
echo %MODELS% | findstr /C:"%~1" >nul
if errorlevel 1 (
    echo        [缺] %~1  ^(%~2^)
    echo             装：ollama pull %~1
    set /a BAD_N+=1
) else (
    echo        OK   %~1  ^(%~2^)
    set /a OK_N+=1
)
exit /b 0
