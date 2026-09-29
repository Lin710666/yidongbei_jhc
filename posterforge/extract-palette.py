#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""extract-palette.py —— 从图片里提取"版式灵感"配色元数据。

只输出**颜色数值**，不复制、不嵌入任何图片内容 ——
这是「联网轮换」的版权边界：拿来的图有版权（Bing/图库），
但"这张图的色调倾向"是事实数据，不是作品本身。

用法：
    python extract-palette.py <图片路径> [<图片路径> ...]
输出：一行 JSON，每个文件一个 {file, from, to, accent, warmth}
"""
from __future__ import annotations

import io
import json
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def hexof(rgb):
    return "#%02x%02x%02x" % tuple(int(max(0, min(255, c))) for c in rgb)


def extract(path):
    from PIL import Image

    im = Image.open(path).convert("RGB")
    # 缩到小图再统计，速度快且能抹掉噪点
    im = im.resize((80, 80), Image.LANCZOS)
    px = list(im.getdata())

    # 按明度排序取三档：暗部 / 中间调 / 亮部 —— 对应"底色→过渡→强调色"
    px_sorted = sorted(px, key=lambda p: 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2])
    n = len(px_sorted)

    def avg(chunk):
        if not chunk:
            return (128, 128, 128)
        r = sum(p[0] for p in chunk) / len(chunk)
        g = sum(p[1] for p in chunk) / len(chunk)
        b = sum(p[2] for p in chunk) / len(chunk)
        return (r, g, b)

    dark = avg(px_sorted[: max(1, n // 5)])
    mid = avg(px_sorted[n // 2 - n // 10 : n // 2 + n // 10])
    bright = avg(px_sorted[-max(1, n // 5):])

    # 暖度：R 减 B 的归一到 0~1。用于决定今天适合推暖调还是冷调模板。
    r = sum(p[0] for p in px) / n
    b = sum(p[2] for p in px) / n
    warmth = max(0.0, min(1.0, 0.5 + (r - b) / 255.0))

    return {
        "file": path.replace("\\", "/").split("/")[-1],
        "from": hexof(dark),
        "to": hexof(mid),
        "accent": hexof(bright),
        "warmth": round(warmth, 3),
    }


def main():
    paths = [p for p in sys.argv[1:] if p]
    out = []
    for p in paths:
        try:
            out.append(extract(p))
        except Exception as e:
            print("跳过 %s：%s" % (p, e), file=sys.stderr)
    sys.stdout.write(json.dumps({"ok": True, "palettes": out}, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
