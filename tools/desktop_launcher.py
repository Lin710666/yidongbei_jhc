# -*- coding: utf-8 -*-
"""
桌面板启动器（源码版，不需要装 Electron 安装包）。

和"手机版启动器"的区别：这个只绑 127.0.0.1（本机用，不暴露到局域网），
并且自动打开浏览器。

什么时候用它：
  · 还没跑过 desktop\\打包桌面版.bat（没生成安装包）
  · 只是想快速把服务起起来看看
装过安装包的话，直接用开始菜单/桌面上的「智能文旅辅助系统」图标更好，
那个是真正的桌面应用（自带 Electron 外壳与后端）。

用法：
    python tools/desktop_launcher.py
    python tools/desktop_launcher.py --port 8000 --no-open
"""
import argparse
import os
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"


def pick_python() -> Path:
    for p in (BACKEND / ".venv" / "Scripts" / "python.exe",
              BACKEND / ".venv" / "bin" / "python"):
        if p.is_file():
            return p
    return Path(sys.executable)


def port_free(port: int, host: str = "127.0.0.1") -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()

    py = pick_python()
    url = f"http://127.0.0.1:{args.port}/"

    print()
    print("  ============================================================")
    print("   智能文旅辅助系统 · 桌面（源码启动）")
    print("  ============================================================")
    print()
    print(f"   地址：{url}")
    if not (BACKEND / ".venv").is_dir():
        print("   [!] 没找到 backend/.venv，先运行 install.bat")
    if not port_free(args.port):
        print(f"   [!] {args.port} 端口已被占用 —— 多半是服务已经在跑了。")
        print("       直接打开上面的地址即可；要另起一个就加 --port 8001")
    print()
    print("   按 Ctrl+C 停止")
    print("  ============================================================")
    print()

    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    proc = subprocess.Popen(
        [str(py), "-m", "uvicorn", "app.main:app",
         "--host", "127.0.0.1", "--port", str(args.port)],
        cwd=str(BACKEND), env=env,
    )

    if not args.no_open:
        time.sleep(3.0)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        proc.wait()
    except KeyboardInterrupt:
        print("\n  正在停止…")
        proc.terminate()
        try:
            proc.wait(timeout=6)
        except Exception:
            proc.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
