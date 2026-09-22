@echo off
setlocal
chcp 936 >nul
cd /d "%~dp0.."

title Wenlv Qwen TTS service

REM ============================================================
REM  Start the local Qwen TTS WebUI in API-only mode.
REM
REM  Why this file exists
REM  --------------------
REM  Speech synthesis is a SEPARATE process (its own venv, its own
REM  launcher, its own VRAM). The backend proxies /api/tts to it at
REM  http://127.0.0.1:7860. Without this service running, /api/tts
REM  answers 503 and the avatar stays silent - including the
REM  audio-driven lip sync, which then has nothing to analyse.
REM
REM  How the install location is found (first hit wins)
REM  --------------------------------------------------
REM    1. the QWEN_TTS_HOME environment variable
REM    2. qwen-tts-home.txt in the project root (one line, the path)
REM    3. tools\find-tts.ps1 - scans the usual places
REM
REM  NOTE: this file is deliberately pure ASCII. A .bat whose body
REM  contains non-ASCII paths breaks when the console code page is
REM  not the one it was written in.
REM ============================================================

set "TTS_HOME="

if defined QWEN_TTS_HOME call :CHECK "%QWEN_TTS_HOME%"
if defined TTS_HOME goto READY

if exist "%~dp0..\qwen-tts-home.txt" (
  REM Read the file through `type` in backquotes.
  REM NOT `in ("%~dp0..\qwen-tts-home.txt")`: with "usebackq" a
  REM double-quoted token is a STRING, not a filename, so the file
  REM would never be read. (That exact bug sits in the 5.0 copy of
  REM this script - only its fallback scan kept it working. I hit it
  REM again while rewriting this, hence the comment.)
  for /f "usebackq delims=" %%p in (`type "%~dp0..\qwen-tts-home.txt"`) do call :CHECK "%%~p"
)
if defined TTS_HOME goto READY

for /f "usebackq delims=" %%p in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0find-tts.ps1"`) do call :CHECK "%%~p"
if defined TTS_HOME goto READY

echo.
echo   [ERROR] Qwen TTS WebUI was not found on this machine.
echo.
echo   Install it first, then tell this script where it is, either:
echo     1) write the install path into qwen-tts-home.txt (one line)
echo     2) or set the environment variable QWEN_TTS_HOME
echo.
echo   Project: https://github.com/licyk/qwen-tts-webui
echo.
pause
exit /b 1

:READY
set "TTS_CORE=%TTS_HOME%\core"
set "TTS_PY=%TTS_HOME%\python\python.exe"

echo ==================================================
echo   Qwen TTS local speech service
echo ==================================================
echo.
echo   install : %TTS_HOME%
echo   api     : http://127.0.0.1:7860
echo   backend : proxied at /api/tts (see README, speech section)
echo.
echo   First start loads the weights into VRAM: 30s to a few minutes.
echo.
echo   ^>^> VRAM WARNING: this uses the SAME GPU as Ollama.
echo      On an 8 GB card a 7B chat model plus TTS together leave only
echo      a couple hundred MB free (measured: 7720 / 8188 MiB).
echo      It works, but generation gets slower. Close one if a demo
echo      needs to be fast.
echo.
echo --------------------------------------------------
echo.

cd /d "%TTS_CORE%"
"%TTS_PY%" launch.py --nowebui --server-name 127.0.0.1 --server-port 7860

echo.
echo   TTS service exited.
pause
exit /b 0

:CHECK
REM accept a directory only when it really looks like a Qwen TTS install
if defined TTS_HOME exit /b 0
if "%~1"=="" exit /b 0
if not exist "%~1\core\launch.py" exit /b 0
if not exist "%~1\python\python.exe" exit /b 0
set "TTS_HOME=%~1"
exit /b 0
