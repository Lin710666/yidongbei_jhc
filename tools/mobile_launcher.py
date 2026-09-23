# -*- coding: utf-8 -*-
"""
手机版启动器（在电脑上运行）。

做三件事：
  1. 在 **0.0.0.0** 上起后端 —— 只绑 127.0.0.1 的话手机连不上
  2. 算出本机的局域网地址（手机和电脑要在同一个 WiFi 下）
  3. 在终端里画一个二维码，手机扫一下就能打开

为什么需要它：手机端页面（/m/）是后端托管的，
而 uvicorn 默认只监听 127.0.0.1。不改监听地址，手机上无论输什么地址都打不开。

二维码实现：用 `qrcode` 库（可选依赖）。
**没装也不影响使用** —— 会退化成"直接打印地址让你手输"，
不会因为一个便利功能没装库就报错退出。

用法：
    python tools/mobile_launcher.py              # 默认 8000
    python tools/mobile_launcher.py --port 8080
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


def render_qr(url: str) -> str:
    """把 url 画成终端可扫的二维码。没装 qrcode 库就返回空串。"""
    try:
        import qrcode  # type: ignore
    except Exception:
        return ""
    try:
        q = qrcode.QRCode(border=1, box_size=1)
        q.add_data(url)
        q.make(fit=True)
        mat = q.get_matrix()
        # 用两个空格当一个模块、上下两行并一行（半块字符），
        # 终端里这样既方正又不至于太宽。
        out = []
        for row in mat:
            line = "    "
            for v in row:
                line += "██" if v else "  "
            out.append(line)
        return "\n".join(out)
    except Exception:
        return ""


def lan_ip() -> str:
    """取本机在局域网里的地址。连一个外网地址（不发包）让系统选出口网卡。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def pick_python() -> Path:
    """优先用后端虚拟环境里的解释器；没有就用当前这个。"""
    py = BACKEND / ".venv" / "Scripts" / "python.exe"
    if py.is_file():
        return py
    py2 = BACKEND / ".venv" / "bin" / "python"      # macOS / Linux
    if py2.is_file():
        return py2
    return Path(sys.executable)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--no-open", action="store_true", help="不自动打开电脑上的浏览器")
    args = ap.parse_args()

    py = pick_python()
    if not (BACKEND / ".venv").is_dir():
        print("  [!] 没找到后端虚拟环境 backend/.venv")
        print("      先运行项目根目录的 install.bat 建好环境；")
        print(f"      现在先用这个解释器试跑：{py}")

    ip = lan_ip()
    url_pc = f"http://127.0.0.1:{args.port}/m/"
    url_phone = f"http://{ip}:{args.port}/m/"

    print()
    print("  ============================================================")
    print("   智能文旅辅助系统 · 手机端")
    print("  ============================================================")
    print()
    print(f"   电脑上打开：  {url_pc}")
    print(f"   手机上打开：  {url_phone}")
    print()
    print("   ⚠ 手机要和这台电脑连**同一个 WiFi**")
    print("   ⚠ 连不上时看 Windows 防火墙弹窗，点「允许访问」")
    print("   ⚠ 换了 WiFi、IP 会变，重新跑一次这个脚本即可")
    print()

    qr = render_qr(url_phone)
    if qr:
        print("   手机扫码直达：")
        print(qr)
    else:
        print("   （没装 qrcode 库，跳过二维码；在手机上手动输入上面那行地址即可）")
        print("     想有二维码：backend\\.venv\\Scripts\\python.exe -m pip install qrcode")
        print("     或（用 uv 管理的环境）：cd backend && uv add qrcode")

    print()
    print("  ============================================================")
    print("   按 Ctrl+C 停止")
    print("  ============================================================")
    print()

    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    proc = subprocess.Popen(
        [str(py), "-m", "uvicorn", "app.main:app",
         "--host", args.host, "--port", str(args.port)],
        cwd=str(BACKEND), env=env,
    )

    if not args.no_open:
        time.sleep(3.0)
        try:
            webbrowser.open(url_pc)
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
