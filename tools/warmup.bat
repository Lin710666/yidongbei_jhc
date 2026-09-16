@echo off
REM ---------------------------------------------------------------
REM  warmup.bat -- preload the Ollama models into VRAM.
REM  Called in the background by start.bat. All user-facing text is
REM  printed by warmup.js, so this file stays pure ASCII (no codepage
REM  headaches) and only switches the console to UTF-8 for it.
REM ---------------------------------------------------------------
chcp 65001 >nul
cd /d "%~dp0.."
node "%~dp0warmup.js"
if errorlevel 1 pause
exit /b 0
