@echo off
chcp 936 >nul
cd /d "%~dp0.."
title 获取示例模型

echo ==================================================
echo   获取示例模型
echo ==================================================
echo.
echo   示例 Live2D 与 3D 模型是第三方素材，不随仓库分发，
echo   需要时由这个脚本从官方公开仓库下载（约 33MB，走 jsDelivr CDN）。
echo.

where pwsh >nul 2>nul
if errorlevel 1 goto USE_POWERSHELL
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0获取示例模型.ps1" %*
goto DONE

:USE_POWERSHELL
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0获取示例模型.ps1" %*

:DONE
echo.
pause
