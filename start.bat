@echo off
chcp 65001 >nul
title 文旅智能辅助 · 本地部署启动器
echo ================================================
echo    文旅智能辅助 Skill · 本地大模型启动器
echo ================================================
echo.

rem ---- 1. 检查 Ollama 是否安装 ----
where ollama >nul 2>nul
if %errorlevel% neq 0 (
  echo [错误] 未检测到 Ollama。请先安装：
  echo        winget install Ollama.Ollama
  echo.
  pause
  exit /b 1
)

rem ---- 2. 检查本地模型，缺失则自动下载（仅首次，约 4.7GB）----
ollama list | findstr /C:"qwen2.5:7b" >nul
if %errorlevel% neq 0 (
  echo [提示] 未找到模型 qwen2.5:7b，开始下载（仅首次，请耐心等待）...
  ollama pull qwen2.5:7b
)

rem ---- 3. 启动本地服务器并打开浏览器 ----
echo [启动] 正在启动本地服务器 http://localhost:8000 ...
start "" http://localhost:8000
node server.js
