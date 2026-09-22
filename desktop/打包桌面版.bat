@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title 智能文旅辅助系统 - 打包桌面安装包

REM ============================================================
REM  一键把本项目打成 Windows 安装包（.exe）。
REM
REM  为什么仓库里不发安装包本体：
REM    安装包 130 MB，超过 GitHub 单文件 100 MB 的硬上限，推不上去。
REM    所以发源码 + 这个脚本 —— 在有网的环境跑一次就有了。
REM
REM  产物：desktop\dist\智能文旅辅助系统-<版本>-安装包.exe
REM
REM  前置条件（脚本会逐项检查）：
REM    ① backend\.venv        后端虚拟环境（根目录 install.bat 会建）
REM    ② Node.js 18+          打包前端外壳用
REM    ③ 首次会联网下载 Electron（约 270 MB）与 NSIS，之后有缓存
REM ============================================================

echo.
echo  ==================================================
echo    智能文旅辅助系统 - 打包桌面安装包
echo  ==================================================
echo.

REM ---------- ① 后端虚拟环境 ----------
set "PYEXE=%~dp0..\backend\.venv\Scripts\python.exe"
if not exist "%PYEXE%" (
    echo  [X] 没找到后端虚拟环境：
    echo      %PYEXE%
    echo.
    echo  请先在项目根目录运行「一键部署.bat」或「install.bat」建好环境。
    echo.
    pause
    exit /b 1
)
echo  [OK] 后端环境

REM ---------- ② PyInstaller ----------
"%PYEXE%" -c "import PyInstaller" >nul 2>nul
if errorlevel 1 (
    echo  [!] 缺少 PyInstaller，正在安装...
    where uv >nul 2>nul
    if not errorlevel 1 (
        pushd "%~dp0..\backend"
        uv add --dev pyinstaller
        popd
    ) else (
        "%PYEXE%" -m pip install pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple
    )
    "%PYEXE%" -c "import PyInstaller" >nul 2>nul
    if errorlevel 1 (
        echo  [X] PyInstaller 安装失败，请手动执行：
        echo      cd backend ^&^& uv add --dev pyinstaller
        pause
        exit /b 1
    )
)
echo  [OK] PyInstaller

REM ---------- ③ Node ----------
where node >nul 2>nul
if errorlevel 1 (
    echo  [X] 没找到 Node.js。请安装 Node.js 18 及以上版本后重试：
    echo      https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo  [OK] Node %%v

REM ---------- ④ 打后端 exe ----------
echo.
echo  [1/3] 打包后端（PyInstaller，首次约 1-3 分钟）...
"%PYEXE%" -X utf8 "build-backend.py"
if errorlevel 1 (
    echo  [X] 后端打包失败
    pause
    exit /b 1
)
if not exist "dist-backend\hiki-backend\hiki-backend.exe" (
    echo  [X] 没生成后端 exe，请查看上面的报错
    pause
    exit /b 1
)
echo  [OK] 后端 exe

REM ---------- ⑤ 装 Electron ----------
echo.
echo  [2/3] 准备 Electron 依赖...
if not exist "node_modules\electron\dist\electron.exe" (
    echo      首次需要联网下载 Electron（约 270 MB），请耐心等待...
    set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
    set "npm_config_registry=https://registry.npmmirror.com"
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo  [X] npm install 失败
        pause
        exit /b 1
    )
    REM npm 可能拦截 postinstall，这里补下载一次二进制
    if not exist "node_modules\electron\dist\electron.exe" (
        pushd node_modules\electron
        node install.js
        popd
    )
)
if not exist "node_modules\electron\dist\electron.exe" (
    echo  [X] Electron 二进制未就绪
    pause
    exit /b 1
)
echo  [OK] Electron

REM ---------- ⑥ 打安装包 ----------
echo.
echo  [3/3] 生成安装包（压缩中，约 1-3 分钟）...
set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
call node "node_modules\electron-builder\cli.js" --win nsis
if errorlevel 1 (
    echo.
    echo  [X] 生成安装包失败。常见原因：
    echo      · winCodeSign 缓存解压需要符号链接权限 —— 打开 Windows「开发者模式」后重试
    echo      · 网络不通导致 NSIS 下载失败
    pause
    exit /b 1
)

echo.
echo  ==================================================
echo   打包完成
echo  ==================================================
for %%f in ("dist\*安装包.exe") do echo    %%~nxf   (%%~zf 字节)
echo.
echo   位置：%~dp0dist\
echo   双击即可安装；安装后桌面与开始菜单会有快捷方式。
echo.
pause
