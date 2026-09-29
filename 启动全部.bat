@echo off
REM ★ chcp 65001：本文件是 UTF-8（无 BOM）且含中文，而中文 Windows 控制台默认 GBK。
REM    不切码页中文会显示成乱码。
chcp 65001 >nul
title 浙里文旅 · 海报与行程 v8.0

cd /d "%~dp0"

echo ==================================================
echo   浙里文旅 · 海报与行程  v8.0
echo ==================================================
echo.

REM 先部署再启动 —— 用户不该先想着"我装过依赖没有"。
REM deploy.mjs 每步都会探测是否已就绪，所以重复跑是安全的、也很快。
echo [1/2] 检查部署...
node deploy.mjs
if errorlevel 1 (
  echo.
  echo   部署没通过。上面每步都写了原因，修完再双击本文件即可
  echo   （已经就绪的步骤会自动跳过，不用从头来）。
  echo.
  pause
  exit /b 1
)

echo.
echo [2/2] 启动服务...
echo.
echo   门户      http://127.0.0.1:8800/hub.html
echo   海报生成  http://127.0.0.1:8800/
echo   旅游规划  http://127.0.0.1:8800/wenlv/
echo.
echo   三个服务会自己死（实测是收到 ^C 信号，不是崩溃），
echo   所以本程序会每 20 秒检查一次，谁停了就拉起来。
echo   按 Ctrl+C 停止看守（已经起好的服务不会被关掉）。
echo.

start "" http://127.0.0.1:8800/hub.html
node start.mjs

echo.
echo 看守已退出。
pause
