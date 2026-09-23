@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
title 智能文旅辅助系统 - 手机版
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

REM ============================================================
REM  手机版 · 一键启动
REM
REM  做了什么：
REM    1. 在 0.0.0.0 上起后端（只绑 127.0.0.1 的话手机连不上）
REM    2. 算出本机局域网地址，在窗口里显示出来
REM    3. 画一个二维码，手机扫一下就能打开
REM
REM  手机上打开的是 /m/ 那一页（豆包式对话界面）。
REM  手机要和这台电脑连**同一个 WiFi**。
REM  第一次连不上时，看 Windows 防火墙弹窗点「允许访问」。
REM ============================================================

set "PYEXE=%~dp0..\backend\.venv\Scripts\python.exe"
if not exist "%PYEXE%" (
  echo.
  echo  [X] 没找到后端虚拟环境：
  echo      %PYEXE%
  echo.
  echo  请先在项目根目录运行「一键部署.bat」或「install.bat」。
  echo.
  pause
  exit /b 1
)

echo.
echo  正在启动手机版服务…（这个窗口要一直开着，关掉就停了）
echo.
"%PYEXE%" -X utf8 "%~dp0mobile_launcher.py"
if errorlevel 1 (
  echo.
  echo  [X] 启动失败，请把上面的报错发出来。
  pause
)
