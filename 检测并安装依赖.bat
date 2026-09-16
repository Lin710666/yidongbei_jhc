@echo off
chcp 936 >nul
cd /d "%~dp0"
title 检测并安装依赖 · 文旅智能辅助

setlocal enabledelayedexpansion
set "ROOT=%~dp0"
set "TTS_PORT=7860"

REM 缺什么就置对应的标志位，最后统一汇总
set "M_QWEN25=0"
set "M_EMBED=0"
set "M_VL=0"
set "M_TTSMODEL=0"
set "M_ASSETS=0"
set "NEED=0"

echo ==================================================
echo   文旅智能辅助 · 依赖检测与一键补装
echo ==================================================
echo.
echo   逐项检查运行本项目需要的全部东西，把缺的列出来，
echo   确认后自动下载。已经装好的会跳过，不会重复下。
echo.

call "%~dp0tools\env-detect.bat"

REM ============================================================
echo [1/6] Node.js ...
REM ============================================================
where node >nul 2>nul
if errorlevel 1 goto NO_NODE
for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
for /f "tokens=1 delims=." %%a in ("!NODEVER:v=!") do set "NODEMAJOR=%%a"
if !NODEMAJOR! LSS 18 goto NODE_TOO_OLD
echo        OK  !NODEVER!
goto STEP2

:NODE_TOO_OLD
echo        [缺] 当前 !NODEVER!，项目要求 Node.js 18 以上
echo        请到 https://nodejs.org 下载安装，然后重新运行本脚本。
echo.
pause
exit /b 1

:NO_NODE
echo        [缺] 未检测到 Node.js
echo        请到 https://nodejs.org 下载安装 18 以上版本，然后重新运行本脚本。
echo.
pause
exit /b 1

REM ============================================================
:STEP2
echo.
echo [2/6] Ollama 服务 ...
REM ============================================================
curl -s -m 4 http://127.0.0.1:11434/api/tags >nul 2>nul
if not errorlevel 1 goto OLLAMA_OK

echo        未运行，正在启动 ...
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" goto START_OLLAMA_APP
start "Ollama" /min cmd /c "ollama serve"
goto WAIT_OLLAMA

:START_OLLAMA_APP
start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"

set "O_TRY=0"
:WAIT_OLLAMA
ping -n 3 127.0.0.1 >nul
curl -s -m 4 http://127.0.0.1:11434/api/tags >nul 2>nul
if not errorlevel 1 goto OLLAMA_OK
set /a O_TRY+=1
if !O_TRY! LSS 12 goto WAIT_OLLAMA

echo        [缺] 连不上 Ollama。请先安装：https://ollama.com/download
echo        装好后重新运行本脚本。
echo.
pause
exit /b 1

:OLLAMA_OK
echo        OK  已连接 http://127.0.0.1:11434

REM ============================================================
echo.
echo [3/6] Ollama 模型 ...
REM ============================================================
call :CHECK_OLLAMA_MODEL "qwen2.5:7b" "对话，必须" "4.7 GB" M_QWEN25
call :CHECK_OLLAMA_MODEL "nomic-embed-text" "记忆向量，强烈建议" "274 MB" M_EMBED
call :CHECK_OLLAMA_MODEL "qwen2.5vl:3b" "视觉理解，可选" "3.2 GB" M_VL

REM ============================================================
echo.
echo [4/6] Qwen TTS WebUI ...
REM ============================================================
if defined TTS_HOME goto TTS_HOME_OK
echo        [缺] 本机没找到 Qwen TTS WebUI
echo        它是个独立程序，需要单独安装（安装包约 9 GB，建议留 25 GB 空间）：
echo            https://github.com/licyk/qwen-tts-webui
echo        装好后二选一告诉本脚本它在哪：
echo            1) 在项目根目录建 qwen-tts-home.txt，里面写一行安装路径
echo            2) 设环境变量 QWEN_TTS_HOME 指向该路径
echo        没装也能跑，只是虚拟人物不会出声，其它功能都正常。
goto STEP5

:TTS_HOME_OK
echo        OK  %TTS_HOME%

REM ============================================================
:STEP5
echo.
echo [5/6] Qwen TTS 语音模型 ...
REM ============================================================
if not defined TTS_HOME goto TTS_MODEL_DONE

set "TTS_CACHE_A=%TTS_CORE%\cache\modelscope\hub\models"
set "TTS_CACHE_B=%TTS_HOME%\cache\modelscope\hub\models"

call :CHECK_TTS_MODEL "%TTS_CACHE_A%" "Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice" M_TTSMODEL
if not errorlevel 1 goto TTS_MODEL_DONE
call :CHECK_TTS_MODEL "%TTS_CACHE_B%" "Qwen--Qwen3-TTS-12Hz-0.6B-CustomVoice" M_TTSMODEL
if not errorlevel 1 goto TTS_MODEL_DONE
call :CHECK_TTS_MODEL "%TTS_CACHE_A%" "Qwen--Qwen3-TTS-12Hz-1.7B-CustomVoice" M_TTSMODEL
if not errorlevel 1 goto TTS_MODEL_DONE
call :CHECK_TTS_MODEL "%TTS_CACHE_B%" "Qwen--Qwen3-TTS-12Hz-1.7B-CustomVoice" M_TTSMODEL
if not errorlevel 1 goto TTS_MODEL_DONE

echo        [缺] 一个语音模型都还没下载
set "M_TTSMODEL=1"

:TTS_MODEL_DONE

REM ============================================================
echo.
echo [6/6] 前端素材，Live2D 与 3D 人物模型 ...
REM ============================================================
if not exist "public\models\haru\Haru.moc3" goto ASSETS_MISSING
if not exist "public\models3d\seed-san\Seed-san.vrm" goto ASSETS_MISSING
echo        OK  Live2D 与 3D 模型都在
goto SUMMARY

:ASSETS_MISSING
echo        [缺] 示例 Live2D 或 3D 模型没下全
echo        这些是第三方素材，不随仓库分发，需要单独下载，约 33 MB。
set "M_ASSETS=1"

REM ============================================================
:SUMMARY
echo.
echo ==================================================
REM ============================================================
if "%M_QWEN25%"=="1" set "NEED=1"
if "%M_EMBED%"=="1" set "NEED=1"
if "%M_VL%"=="1" set "NEED=1"
if "%M_TTSMODEL%"=="1" set "NEED=1"
if "%M_ASSETS%"=="1" set "NEED=1"

if "%NEED%"=="0" goto ALL_GOOD

echo   下面这些还没装，需要下载：
echo.
if "%M_QWEN25%"=="1" echo      - qwen2.5:7b                          约 4.7 GB   对话模型
if "%M_EMBED%"=="1"  echo      - nomic-embed-text                    约 274 MB   记忆语义检索
if "%M_VL%"=="1"     echo      - qwen2.5vl:3b                        约 3.2 GB   视觉理解
if "%M_TTSMODEL%"=="1" echo      - Qwen3-TTS-12Hz-0.6B-CustomVoice     约 2.4 GB   语音合成
if "%M_ASSETS%"=="1" echo      - 示例 Live2D / 3D 模型               约 33 MB    虚拟人物
echo.
echo   下载时间取决于网速，中途请不要关闭本窗口。
echo.

set "GO="
set /p GO=  现在开始下载吗？[Y/n] 
if /i "%GO%"=="n" goto SKIP_DL
if /i "%GO%"=="no" goto SKIP_DL
goto INSTALL

:ALL_GOOD
echo   检查完毕：所有依赖和模型都齐了，不需要补装。
echo.
echo   直接双击 start.bat 就能启动项目。
echo.
pause
exit /b 0

REM ============================================================
:INSTALL
echo.
echo -------------------- 开始补装 --------------------
echo.

if "%M_QWEN25%%M_EMBED%%M_VL%"=="000" goto INSTALL_TTS
echo [Ollama 模型]
if "%M_QWEN25%"=="1" call :PULL_OLLAMA "qwen2.5:7b"
if "%M_EMBED%"=="1"  call :PULL_OLLAMA "nomic-embed-text"
if "%M_VL%"=="1"     call :PULL_OLLAMA "qwen2.5vl:3b"
echo.

:INSTALL_TTS
if "%M_TTSMODEL%"=="0" goto INSTALL_ASSETS
echo [Qwen TTS 语音模型]
curl -s -m 4 http://127.0.0.1:%TTS_PORT%/qwenapi/v1/models >nul 2>nul
if not errorlevel 1 goto TTS_SVC_READY
echo   语音服务没在跑，先启动它 ...
start "文旅-QwenTTS语音服务" /min /D "%~dp0tools" cmd /c "start-tts.bat"
set "W_TRY=0"

:WAIT_TTS_SVC
ping -n 3 127.0.0.1 >nul
curl -s -m 4 http://127.0.0.1:%TTS_PORT%/qwenapi/v1/models >nul 2>nul
if not errorlevel 1 goto TTS_SVC_READY
set /a W_TRY+=1
if !W_TRY! LSS 20 goto WAIT_TTS_SVC
echo   [跳过] 语音服务没起来。下次第一次朗读时它会自动下载模型。
goto INSTALL_ASSETS

:TTS_SVC_READY
if not exist "%~dp0tools\fetch-tts-model.ps1" goto INSTALL_ASSETS
call :RUN_PS "%~dp0tools\fetch-tts-model.ps1" ""

:INSTALL_ASSETS
if "%M_ASSETS%"=="0" goto FINISH
echo [示例 Live2D / 3D 模型]
if not exist "%~dp0tools\获取示例模型.ps1" goto ASSETS_NOFILE
call :RUN_PS "%~dp0tools\获取示例模型.ps1" ""
goto FINISH

:ASSETS_NOFILE
echo   [跳过] 没找到 tools\获取示例模型.ps1

REM ============================================================
:FINISH
echo.
echo ==================================================
echo   补装结束。
echo   再跑一次本脚本可以复查有没有漏的；
echo   也可以直接双击 start.bat 启动项目。
echo ==================================================
echo.
pause
exit /b 0

:SKIP_DL
echo.
echo   已取消，什么都没下载。想补装时重新双击本脚本即可。
echo.
pause
exit /b 0

REM ============================================================
REM 子过程
REM ============================================================

REM 检查一个 ollama 模型；缺了就把第 4 个参数名对应的标志位置 1
REM 用法：call :CHECK_OLLAMA_MODEL "模型名" "用途" "体积" 标志位变量名
:CHECK_OLLAMA_MODEL
REM 用 ollama show 的退出码判断，不解析文本，避免 nomic-embed-text:latest 这类带标签的名字漏判
ollama show %~1 >nul 2>nul
if not errorlevel 1 goto CHECK_OLLAMA_FOUND
echo        [缺] %~1    %~2
set "%~4=1"
exit /b 1

:CHECK_OLLAMA_FOUND
echo        OK  %~1    %~2
exit /b 0

REM 检查 TTS 模型目录里有没有下载完成的权重
REM 用法：call :CHECK_TTS_MODEL "缓存根目录" "模型目录名" 标志位变量名
:CHECK_TTS_MODEL
if exist "%~1\%~2\snapshots\master\model.safetensors" goto CHECK_TTS_FOUND
exit /b 1

:CHECK_TTS_FOUND
echo        OK  %~2
exit /b 0

REM 拉一个 ollama 模型
:PULL_OLLAMA
echo.
echo   ^>^> ollama pull %~1
ollama pull %~1
exit /b 0

REM 调一个 PowerShell 脚本，自动挑 pwsh / powershell
:RUN_PS
where pwsh >nul 2>nul
if errorlevel 1 goto RUN_PS_WIN
pwsh -NoProfile -ExecutionPolicy Bypass -File %~1
exit /b 0

:RUN_PS_WIN
powershell -NoProfile -ExecutionPolicy Bypass -File %~1
exit /b 0
