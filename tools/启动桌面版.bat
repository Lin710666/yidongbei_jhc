@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0.."
title 智能文旅辅助系统 - 桌面版
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

REM ============================================================
REM  桌面板 · 一键启动（源码方式，不需要装 Electron 安装包）
REM
REM  做了什么：起后端（只绑 127.0.0.1）-> 自动打开浏览器
REM
REM  想更"像软件"的话：双击 desktop\打包桌面版.bat 生成安装包，
REM  装完之后用开始菜单/桌面上的「智能文旅辅助系统」图标 ——
REM  那个是真正的桌面应用，自带外壳与后端，不用命令行。
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
echo  正在启动桌面版…（关掉这个窗口即停止服务）
echo.
"%PYEXE%" -X utf8 "%~dp0desktop_launcher.py"
if errorlevel 1 (
  echo.
  echo  [X] 启动失败，请把上面的报错发出来。
  pause
)
