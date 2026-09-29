@echo off
REM ★ chcp 65001：本文件是 UTF-8（无 BOM）且含中文，中文 Windows 控制台默认 GBK。
chcp 65001 >nul
title 一键部署 · 浙里文旅 v8.0

cd /d "%~dp0"

echo ==================================================
echo   一键部署（不改代码，只装依赖 + 建目录 + 生成配置）
echo ==================================================
echo.
echo   这个脚本和「启动全部.bat」的区别：
echo     本脚本  只部署，不起服务 —— 想先检查环境、或部署完自己启动
echo     启动全部 部署 + 启动 + 保活，一步到位
echo.
echo   每一步都会先探测是否已就绪，就绪就跳过，
echo   所以反复跑是安全的，失败后修完也不用从头来。
echo.

node deploy.mjs
if errorlevel 1 (
  echo.
  echo   部署没通过。上面每步都写了原因和补救办法。
  echo   想先看看环境不改任何东西：node deploy.mjs --check
  echo.
  pause
  exit /b 1
)

echo.
echo   下一步：双击「启动全部.bat」，或执行 node start.mjs
echo.
pause
