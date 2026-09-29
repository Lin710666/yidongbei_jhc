@echo off
REM ★ chcp 65001：本文件是 UTF-8（无 BOM）且含中文，而中文 Windows 控制台默认 GBK。
REM    不切码页中文会显示成乱码。
chcp 65001 >nul
title 守门狗 · 自动保活

cd /d "%~dp0"

echo ==================================================
echo   守门狗 —— 谁停了就把它拉起来
echo ==================================================
echo.
echo   看着三个服务：
echo     8800   海报站点
echo     8001   旅游规划（门户的 /wenlv/ 指向它）
echo     11434  Ollama（本机模型）
echo.
echo   为什么需要它：这两个服务会自己死（实测日志里是 ^C 信号，
echo   不是崩溃），每次都要人工去拉，用户看到的就是"又打不开了"。
echo.
echo   每 20 秒检查一次，缺了就拉。
echo   日志：site\.work\logs\watchdog.log
echo.
echo   按 Ctrl+C 停止守门狗本身（已拉起的服务不会被它关掉）。
echo.

node watchdog.mjs

echo.
echo 守门狗已退出。
pause
