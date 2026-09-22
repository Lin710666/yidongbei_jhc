# -*- coding: utf-8 -*-
"""
桌面版后端入口。

和 `uvicorn app.main:app` 等价，但多两件桌面场景必须做的事：

  1. **端口**从环境变量读（HIKI_PORT），而不是写死 8000 ——
     安装到别人机器上时 8000 可能被占，桌面壳会挑一个空闲端口传进来。

  2. 启动前把 `public/`（前端）的位置告诉后端。
     打包成 exe 后 main.py 里按 __file__ 推断会因为临时解包目录而失效，
     桌面壳会把真实路径放进 STATIC_DIR。

  3. 打印一行机器可读的 "HIKI_READY <port>"，桌面壳据此判断"可以打开窗口了"，
     不必盲目轮询（也方便人肉排错时看控制台）。
"""
import os
import sys

# 冻结后必须把 exe 所在目录加进 sys.path，bundle 里的 app 包才 import 得到
if getattr(sys, "frozen", False):
    sys.path.insert(0, os.path.dirname(sys.executable))
    # PyInstaller 把 --paths 的内容打包进 _MEIPASS，这里再兜一下
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        sys.path.insert(0, meipass)


def main() -> int:
    import uvicorn

    port = int(os.getenv("HIKI_PORT", "8000"))
    host = os.getenv("HIKI_HOST", "127.0.0.1")

    print(f"[hiki-backend] 启动 uvicorn {host}:{port}", flush=True)
    if os.getenv("STATIC_DIR"):
        print(f"[hiki-backend] 前端目录 {os.getenv('STATIC_DIR')}", flush=True)

    # 桌面版默认只走本地：没有云端 key 时 auto 本来也会落到本地
    os.environ.setdefault("LLM_POLICY", "auto")

    config = uvicorn.Config(
        "app.main:app",
        host=host,
        port=port,
        log_level=os.getenv("HIKI_LOG_LEVEL", "info"),
        access_log=False,
    )
    server = uvicorn.Server(config)

    # 等监听成功后打一行机器可读的标记
    import threading

    def announce():
        import time
        for _ in range(600):                      # 最多等 60 秒
            time.sleep(0.1)
            if getattr(server, "started", False):
                print(f"HIKI_READY {port}", flush=True)
                return
        print("[hiki-backend] 等待就绪超时", flush=True)

    threading.Thread(target=announce, daemon=True).start()
    server.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
