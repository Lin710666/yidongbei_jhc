#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
depth-worker.py —— 单目深度估计工作进程（被 lib/depth.js 以子进程方式调用）

输入一张图（通常是等距柱状全景图），输出一张**归一化的灰度高度图 PNG**：
越亮 = 越近。前端拿它去位移网格，就能得到"脚下的起伏地形"。

为什么用子进程而不是把 torch 塞进 Node：
    Node 里没有可用的深度推理方案，而项目又要求零第三方依赖（指 Node 侧）。
    Python 侧本来就是独立环境，用子进程把界限划清楚：Node 只管调度与缓存，
    Python 只负责"图进、高度图出"，互相不污染。

用的模型是 Depth-Anything-V2-Small（约 95MB），相对深度、无需标定，
在本机 RTX 5060 上单张约 1.4 秒。模型目录由 --model 指定；
缺失时会给出**怎么装**的明确提示，而不是抛一段看不懂的栈。

用法：
    python depth-worker.py --model <模型目录> --input <图片> --output <高度图.png>
退出码：0 成功；2 模型不可用；3 输入有问题；1 其它异常。
stdout 只输出一行 JSON（结果摘要），日志走 stderr —— 与 MCP 服务同一个原则。
"""

import argparse
import json
import os
import sys
import time


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def fail(code, msg):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(code)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True, help='Depth-Anything-V2 模型目录')
    ap.add_argument('--input', required=True, help='输入图片路径')
    ap.add_argument('--output', required=True, help='输出高度图 PNG 路径')
    ap.add_argument('--max-side', type=int, default=1024, help='推理前把长边缩到这个尺寸（省显存、提速）')
    args = ap.parse_args()

    if not os.path.isdir(args.model):
        fail(2, f'模型目录不存在：{args.model}\n'
                f'请先运行 tools\\获取深度模型.ps1（会从 hf-mirror 下载约 95MB），'
                f'或用 WENLV_DEPTH_MODEL 指定已有目录。')
    if not os.path.isfile(os.path.join(args.model, 'model.safetensors')):
        fail(2, f'模型目录里没有 model.safetensors：{args.model}\n'
                f'下载可能中断了，重新运行 tools\\获取深度模型.ps1 即可。')
    if not os.path.isfile(args.input):
        fail(3, f'输入图片不存在：{args.input}')

    t0 = time.time()
    try:
        import numpy as np
        import torch
        from PIL import Image
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation
    except Exception as e:  # noqa: BLE001
        fail(2, f'缺少 Python 依赖：{e}\n'
                f'需要 torch / transformers / pillow / numpy。'
                f'可以复用本机已有的 AI 环境（设 WENLV_PYTHON 指向它的 python.exe）。')

    try:
        proc = AutoImageProcessor.from_pretrained(args.model)
        model = AutoModelForDepthEstimation.from_pretrained(args.model)
        model.eval()

        use_cuda = torch.cuda.is_available()
        if use_cuda:
            model = model.to('cuda')
            # 半精度：实测能把显存占用砍掉近一半，输出差异肉眼不可见
            try:
                model = model.half()
            except Exception:
                pass
        log(f'[depth] 模型就绪 cuda={use_cuda} 载入 {time.time()-t0:.1f}s')

        img = Image.open(args.input).convert('RGB')
        # 长边限制：全景图动辄 4096×2048，直接推理又慢又吃显存；
        # 高度图最后本来也要降采样给前端用，先缩再推没有损失。
        w, h = img.size
        if max(w, h) > args.max_side:
            scale = args.max_side / max(w, h)
            img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)

        inputs = proc(images=img, return_tensors='pt')
        if use_cuda:
            inputs = {k: (v.to('cuda').half() if v.dtype == torch.float32 else v.to('cuda'))
                      for k, v in inputs.items()}

        t1 = time.time()
        with torch.no_grad():
            pred = model(**inputs).predicted_depth
        infer_s = time.time() - t1

        pred = torch.nn.functional.interpolate(
            pred.unsqueeze(1).float(), size=img.size[::-1], mode='bicubic', align_corners=False
        ).squeeze().cpu().numpy()

        lo, hi = float(pred.min()), float(pred.max())
        norm = (pred - lo) / max(1e-6, hi - lo)

        os.makedirs(os.path.dirname(os.path.abspath(args.output)) or '.', exist_ok=True)
        Image.fromarray((norm * 255).astype(np.uint8)).save(args.output, optimize=True)

        print(json.dumps({
            "ok": True,
            "output": args.output,
            "width": int(img.size[0]),
            "height": int(img.size[1]),
            "inferSeconds": round(infer_s, 2),
            "totalSeconds": round(time.time() - t0, 2),
            "cuda": bool(use_cuda),
            "rawMin": round(lo, 3),
            "rawMax": round(hi, 3),
        }, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001
        import traceback
        log(traceback.format_exc())
        fail(1, f'深度推理失败：{e}')


if __name__ == '__main__':
    main()
