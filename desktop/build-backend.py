# -*- coding: utf-8 -*-
"""
桌面版后端打包脚本（PyInstaller）。

把 FastAPI 后端打成一个自包含的 exe —— 这是"一键安装部署"的关键：
目标机器**不需要装 Python**，双击即用。

产物：
  desktop/dist-backend/hiki-backend/hiki-backend.exe
  （连同同目录的 _internal/ 一起拷进安装包）

用法：
  cd backend && uv run python ../desktop/build-backend.py
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent          # desktop/
ROOT = HERE.parent                               # 项目根
BACKEND = ROOT / "backend"
ENTRY = HERE / "backend-entry.py"
OUT = HERE / "dist-backend"
WORK = HERE / ".pyi-build"


def main() -> int:
    if not ENTRY.is_file():
        print(f"  缺少入口文件 {ENTRY}")
        return 1

    venv_py = BACKEND / ".venv" / "Scripts" / "python.exe"
    if not venv_py.is_file():
        print(f"  找不到后端虚拟环境 {venv_py}")
        print("  请先执行： cd backend && uv sync")
        return 1

    for d in (OUT, WORK):
        if d.is_dir():
            shutil.rmtree(d)

    cmd = [
        str(venv_py), "-m", "PyInstaller",
        "--noconfirm", "--clean",
        "--name", "hiki-backend",
        # onedir 而不是 onefile：
        #   onefile 每次启动都要把几十 MB 解包到临时目录，冷启动明显更慢；
        #   桌面应用是安装到本地的，onedir 更合适。
        "--onedir",
        "--console",              # 保留控制台便于排错（安装包用快捷方式隐藏）
        "--distpath", str(OUT),
        "--workpath", str(WORK),
        "--specpath", str(WORK),
        # 把后端目录加进搜索路径，bundle 里才 import 得到 app.*
        "--paths", str(BACKEND),
        # 显式收集：uvicorn 走动态导入，PyInstaller 的静态分析看不全
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops.auto",
        "--hidden-import", "uvicorn.loops.asyncio",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.http.h11_impl",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.lifespan.on",
        "--hidden-import", "uvicorn.lifespan.off",
        "--collect-submodules", "app",
        # ★ 必须把 app/data/ 里的清单文件打进去。
        #
        # 踩过的坑：只 collect-submodules 是**不够的** —— 那只收 .py，
        # 而 capabilities.json / cards.json / wordcloud.json 与 prompts/ 都是数据文件。
        # 缺了它们的后果非常隐蔽：后端能正常启动、页面也正常打开，
        # 但 /api/capabilities 返回的 live2d 是**空数组** —— 于是界面显示
        # 「还没有可用的 Live2D 模型」，而同一份代码用源码跑就一切正常。
        # 原因：ui_compat.py 里 DATA_DIR = Path(__file__).parent.parent / "data"，
        # 打包后 __file__ 位于 _MEIPASS/app/routers/，指向 _MEIPASS/app/data，
        # 而 _load() 读不到文件时会**静默退回空 dict**，不报错。
        #
        # 目标路径 app/data 与源码里的层级一致，DATA_DIR 才能推算对。
        "--add-data", f"{BACKEND / 'app' / 'data'}{os.pathsep}app/data",
        str(ENTRY),
    ]

    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    print("  开始打包后端（首次约 1-3 分钟）…", flush=True)
    r = subprocess.run(cmd, cwd=str(BACKEND), env=env)
    if r.returncode != 0:
        print("  打包失败")
        return r.returncode

    dist = OUT / "hiki-backend"
    exe = dist / "hiki-backend.exe"
    total = sum(f.stat().st_size for f in dist.rglob("*") if f.is_file()) if dist.is_dir() else 0
    print(f"\n  产物: {exe}")
    print(f"  存在: {exe.is_file()}   体积: {total / 1024 / 1024:.0f} MB")

    (HERE / "backend-build.json").write_text(json.dumps({
        "entry": str(ENTRY),
        "dist": str(dist),
        "exe": str(exe),
        "exeExists": exe.is_file(),
        "totalMB": round(total / 1024 / 1024, 1),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if exe.is_file() else 1


if __name__ == "__main__":
    sys.exit(main())
