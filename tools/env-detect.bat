@echo off
REM ============================================================
REM  env-detect.bat —— 被 start.bat / stop.bat / 检测并安装依赖.bat 共用
REM
REM  作用：找到本机 Qwen TTS WebUI 装在哪，导出三个变量给调用方：
REM      TTS_HOME   Qwen TTS 根目录
REM      TTS_CORE   core 目录（launch.py 所在）
REM      TTS_PY     python\python.exe 的完整路径
REM  找不到时三个变量都为空，由调用方决定是提示还是跳过。
REM
REM  查找顺序（三重保险，越靠前越优先）：
REM      1. 环境变量 QWEN_TTS_HOME
REM      2. 项目根目录下的 qwen-tts-home.txt（里面写一行安装路径，最省事）
REM      3. tools\find-tts.ps1 自动扫描常见位置
REM
REM  实现上刻意不用多层括号块：cmd 对括号块里的变量是「整块解析时就展开」，
REM  块内刚 set 的变量在同一块里读不到（这是踩过的坑），所以这里全用 goto 平铺。
REM ============================================================

set "TTS_HOME="
set "TTS_CORE="
set "TTS_PY="

REM ---------- 1. 环境变量 ----------
if not defined QWEN_TTS_HOME goto TRY_TXT_FILE
if not exist "%QWEN_TTS_HOME%\core\launch.py" goto TRY_TXT_FILE
if not exist "%QWEN_TTS_HOME%\python\python.exe" goto TRY_TXT_FILE
set "TTS_HOME=%QWEN_TTS_HOME%"
goto FINALIZE

REM ---------- 2. 项目根目录的 qwen-tts-home.txt ----------
:TRY_TXT_FILE
if not exist "%~dp0..\qwen-tts-home.txt" goto TRY_AUTO_SCAN
for /f "usebackq tokens=* delims=" %%p in ("%~dp0..\qwen-tts-home.txt") do call :SET_IF_VALID "%%~p"
if defined TTS_HOME goto FINALIZE

REM ---------- 3. 自动扫描 ----------
:TRY_AUTO_SCAN
for /f "usebackq delims=" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0find-tts.ps1"`) do call :SET_IF_VALID "%%~p"

:FINALIZE
if not defined TTS_HOME goto EXIT
set "TTS_CORE=%TTS_HOME%\core"
set "TTS_PY=%TTS_HOME%\python\python.exe"

:EXIT
exit /b 0

REM ---------- 子过程：只有目录里确实有 launch.py 和 python.exe 才认 ----------
REM 用法（必须带引号，路径里可能有空格）：call :SET_IF_VALID "D:\xxx\qwen_tts_webui"
:SET_IF_VALID
if defined TTS_HOME exit /b 0
if "%~1"=="" exit /b 0
if not exist "%~1\core\launch.py" exit /b 0
if not exist "%~1\python\python.exe" exit /b 0
set "TTS_HOME=%~1"
exit /b 0