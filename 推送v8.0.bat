@echo off
REM ★ chcp 65001：本文件是 UTF-8（无 BOM）且含中文，中文 Windows 控制台默认 GBK。
chcp 65001 >nul
title 推送 v8.0 到 GitHub

cd /d "%~dp0"

REM 用 PowerShell 跑，因为要**隐藏输入 Token**（bat 的 set /p 会把 Token 打在屏幕上）。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push-v8.0.ps1"

if errorlevel 1 pause
