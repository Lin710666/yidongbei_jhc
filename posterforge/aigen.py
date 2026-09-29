#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""aigen.py —— 不依赖 ComfyUI 的本地出图。

为什么另起一个出图器：ComfyUI 那套要用户手动点启动器（而且启动器上印着
MiniMax-H3 的字样，与实际用的 Qwen-Image 不符），链路里多一个必须常驻的服务。
这里直接用 diffusers 加载模型，进程内出图，不启任何服务器。

模型：SDXL-Turbo（D:\\models\\sdxl-turbo，fp16 diffusers 布局）
  选它的理由：1~4 步就能出图，在 8GB 卡上几秒完成；而底图上面要压遮罩、
  叠文字，对极致细节的需求不高。

必须用 ComfyUI 便携版的 Python 跑 —— 只有它装了 CUDA 版的 torch 与 diffusers：
    E:\\ComfyUI_windows_portable\\python_embeded\\python.exe aigen.py --prompt "..." --out x.png

输出：stdout 打印**一行** JSON，便于 Node 侧解析。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import time
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

DEFAULT_MODEL = os.environ.get("PF_AIGEN_MODEL", r"D:\models\sdxl-turbo")
OLLAMA = os.environ.get("PF_OLLAMA", "http://127.0.0.1:11434")

_pipe = None  # 进程内缓存（为将来做常驻 worker 留的口子）


def log(*a):
    print(*a, file=sys.stderr)


def emit(obj):
    """把结果作为**唯一一行** JSON 打到 stdout。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def unload_ollama():
    """8GB 卡上，常驻的对话模型和出图模型放不下两张，出图前先把它们请出去。"""
    try:
        tags = json.load(urllib.request.urlopen(OLLAMA + "/api/tags", timeout=6))
    except Exception as e:
        log("[aigen] 取 Ollama 模型列表失败（不影响出图）:", e)
        return 0
    n = 0
    for m in tags.get("models", []):
        try:
            body = json.dumps({"model": m["name"], "prompt": "", "keep_alive": 0}).encode()
            req = urllib.request.Request(OLLAMA + "/api/generate", data=body,
                                        headers={"content-type": "application/json"})
            urllib.request.urlopen(req, timeout=12).read()
            n += 1
        except Exception:
            pass
    if n:
        log("[aigen] 已卸载 %d 个 Ollama 模型腾显存" % n)
        time.sleep(1.5)
    return n


def load_pipe(model_dir: str, dtype_name: str = "fp16"):
    global _pipe
    if _pipe is not None:
        return _pipe

    import torch
    from diffusers import AutoPipelineForText2Image

    if not os.path.isdir(model_dir):
        raise RuntimeError("模型目录不存在：%s（请先跑 ms-download.py）" % model_dir)

    dtype = torch.float16 if dtype_name == "fp16" else torch.float32
    t0 = time.time()
    # variant="fp16" 对应下载到的 *.fp16.safetensors
    try:
        pipe = AutoPipelineForText2Image.from_pretrained(
            model_dir, torch_dtype=dtype, variant="fp16", use_safetensors=True)
    except Exception as e:
        log("[aigen] variant=fp16 加载失败（%s），退回不带 variant 再试" % type(e).__name__)
        pipe = AutoPipelineForText2Image.from_pretrained(
            model_dir, torch_dtype=dtype, use_safetensors=True)

    pipe.set_progress_bar_config(disable=True)
    if torch.cuda.is_available():
        # 【关键】必须用 model cpu offload，不能整模型塞进显存。
        # 实测（RTX 5060 8GB，768x1024 / 4 步）：
        #   整模型上卡 → 显存 7.96/7.96 GB 打满 → 46~66 秒（在疯狂换入换出）
        #   cpu offload → 显存 1.17/7.96 GB      → 8.2 秒
        # 原因：SDXL fp16 权重约 5GB，8GB 卡塞下后没有空间给高分辨率激活值，
        # 于是每一步都在显存与内存之间倒腾。offload 只保留当前模块在卡上，反而快得多。
        pipe.enable_model_cpu_offload()
        # VAE 钉 fp16：diffusers 默认把 SDXL VAE 上转 fp32 解码（防 NaN），
        # 代价是慢且吃显存。实测本模型「应保持 float32」的模块列表为空，钉 fp16 安全。
        try:
            pipe.vae.to(dtype=torch.float16)
        except Exception as e:
            log("[aigen] VAE 转 fp16 失败（不影响正确性）:", e)
    else:
        log("[aigen] 警告：CUDA 不可用，将在 CPU 上出图（非常慢）")

    log("[aigen] 模型加载完成 %.1fs（cpu offload 模式）" % (time.time() - t0))
    _pipe = pipe
    return pipe


def generate(prompt: str, out: str, width: int, height: int, steps: int, seed: int,
             guidance: float, negative: str = ""):
    import torch
    from PIL import Image

    pipe = load_pipe(DEFAULT_MODEL)
    g = torch.Generator(device="cpu").manual_seed(int(seed))

    kwargs = dict(prompt=prompt, num_inference_steps=int(steps),
                  guidance_scale=float(guidance), width=int(width), height=int(height),
                  generator=g)
    # SDXL-Turbo 的 CFG 必须为 0，此时传 negative_prompt 无意义且会报错，故按需加
    if negative and float(guidance) > 0:
        kwargs["negative_prompt"] = negative

    t0 = time.time()
    img = pipe(**kwargs).images[0]
    ms = int((time.time() - t0) * 1000)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    if img.mode != "RGB":
        img = img.convert("RGB")
    img.save(out, "PNG", optimize=True)
    return ms, img.size


def serve():
    """常驻 worker：从 stdin 读一行一条 JSON 命令，结果写回 stdout 一行。

    为什么要常驻：冷进程每次都要把权重搬上卡。
    实测 768x1024 / 4 步：
        冷进程（含首次上卡）  20.3s
        常驻进程后续每次      8.2s
    差的就是这一次搬运。server.mjs 负责按需拉起、空闲一段时间后关掉。

    协议（一行一条 JSON）：
        → {"cmd":"ping"}
        ← {"ok":true,"ready":true}
        → {"cmd":"gen","prompt":"…","out":"…","width":768,"height":1024,"steps":4,"seed":0}
        ← {"ok":true,"out":"…","ms":8200}
        → {"cmd":"exit"}
    """
    log("[aigen] worker 启动，预加载模型…")
    try:
        load_pipe(DEFAULT_MODEL)
    except Exception as e:
        emit({"ok": False, "fatal": "模型加载失败: %s: %s" % (type(e).__name__, str(e)[:200])})
        return 1
    emit({"ok": True, "ready": True, "pid": os.getpid()})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"ok": False, "error": "命令不是合法 JSON: %s" % e})
            continue

        cmd = req.get("cmd")
        if cmd == "exit":
            emit({"ok": True, "bye": True})
            return 0
        if cmd == "ping":
            emit({"ok": True, "ready": True})
            continue
        if cmd == "gen":
            try:
                if req.get("unload_ollama"):
                    unload_ollama()
                ms, size = generate(
                    req["prompt"], req["out"],
                    int(req.get("width", 768)), int(req.get("height", 1024)),
                    int(req.get("steps", 4)), int(req.get("seed", 0)),
                    float(req.get("guidance", 0.0)), req.get("negative", ""))
                emit({"ok": True, "out": os.path.abspath(req["out"]), "ms": ms,
                      "steps": req.get("steps", 4), "seed": req.get("seed", 0),
                      "size": list(size), "engine": "diffusers/SDXL-Turbo"})
            except Exception as e:
                import traceback
                traceback.print_exc(file=sys.stderr)
                emit({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:300])})
            continue
        emit({"ok": False, "error": "未知命令: %r" % cmd})
    return 0


def main():
    ap = argparse.ArgumentParser(description="本地出图（diffusers，不依赖 ComfyUI）")
    ap.add_argument("--prompt")
    ap.add_argument("--out")
    ap.add_argument("--width", type=int, default=768)
    ap.add_argument("--height", type=int, default=1024)
    ap.add_argument("--steps", type=int, default=4, help="SDXL-Turbo 建议 1~4")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--guidance", type=float, default=0.0, help="Turbo 必须为 0")
    ap.add_argument("--negative", default="")
    ap.add_argument("--unload-ollama", action="store_true", help="出图前腾出显存")
    ap.add_argument("--preload", action="store_true", help="只加载模型不出图（预热用）")
    ap.add_argument("--selftest", action="store_true", help="加载模型并出一张测试图，验证链路")
    ap.add_argument("--serve", action="store_true", help="常驻 worker 模式（stdin/stdout JSON）")
    args = ap.parse_args()

    if args.serve:
        return serve()

    try:
        if args.unload_ollama:
            unload_ollama()
        if args.preload:
            t0 = time.time()
            load_pipe(DEFAULT_MODEL)
            emit({"ok": True, "preloaded": True, "ms": int((time.time() - t0) * 1000)})
            return 0
        if args.selftest:
            out = args.out or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                           ".work", "aigen-selftest.png")
            ms, size = generate(
                args.prompt or ("misty lake at dawn, distant pavilion, weeping willow, "
                                "soft light, cinematic, no text, no watermark"),
                out, args.width, args.height, args.steps, args.seed, args.guidance)
            emit({"ok": True, "out": os.path.abspath(out), "ms": ms, "size": list(size),
                  "engine": "diffusers/SDXL-Turbo"})
            return 0
        if not args.prompt or not args.out:
            emit({"ok": False, "error": "需要 --prompt 与 --out（或用 --serve / --selftest）"})
            return 2
        ms, size = generate(args.prompt, args.out, args.width, args.height,
                            args.steps, args.seed, args.guidance, args.negative)
        emit({"ok": True, "out": os.path.abspath(args.out), "ms": ms,
              "steps": args.steps, "seed": args.seed, "size": list(size),
              "engine": "diffusers/SDXL-Turbo"})
        return 0
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit({"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:300])})
        return 1


if __name__ == "__main__":
    sys.exit(main())
