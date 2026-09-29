#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
poster-forge / bg.py —— 背景与调色板（重写版，单一职责）

存在的理由：原 render.py 里的调色板解析与背景生成在反复改动中变得难以推理
（同名变量多、分支交叉），出现"主题不生效但图看起来正常"的隐性 bug。
这里把这两件事单独拎出来，写成不依赖全局状态的可测单元：

    resolve_color(value, palette)   # 纯函数，显式传 palette，无模块级状态
    make_background(bg, size, palette)
    linear_gradient(size, c1, c2, angle)

显式优于隐式：palette 作为参数传递，不再靠"谁先调用 set_palette"这种时序约定。
"""

from __future__ import annotations

import math
import os
from typing import Any, Dict, Optional, Tuple

from PIL import Image, ImageDraw, ImageFilter, ImageOps


class BGError(Exception):
    """背景/颜色参数不合法。"""


RGBA = Tuple[int, int, int, int]


# ------------------------------------------------------------------ 颜色
def parse_hex(value: Any, default: Optional[RGBA] = None) -> Optional[RGBA]:
    """'#RGB' / '#RRGGBB' / '#RRGGBBAA' / [r,g,b(,a)] -> RGBA"""
    if value is None:
        return default
    if isinstance(value, (list, tuple)):
        vals = [int(max(0, min(255, v))) for v in value]
        if len(vals) == 3:
            vals.append(255)
        if len(vals) != 4:
            raise BGError("颜色数组须为 3 或 4 个分量: %r" % (value,))
        return (vals[0], vals[1], vals[2], vals[3])
    if not isinstance(value, str):
        raise BGError("颜色类型无法识别: %r" % (value,))
    s = value.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) == 6:
        s += "ff"
    if len(s) != 8:
        raise BGError("颜色格式无法识别: %r" % (value,))
    try:
        return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), int(s[6:8], 16))
    except ValueError:
        raise BGError("颜色格式无法识别: %r" % (value,))


def resolve_color(value: Any, palette: Optional[Dict[str, str]] = None) -> Optional[RGBA]:
    """
    解析颜色：既支持 '#RRGGBB' 字面量，也支持调色板变量名。
    palette 显式传入 —— 不读任何模块级状态，因此不存在"时序导致主题失效"。
    """
    if value is None:
        return None
    if not isinstance(value, str):
        return parse_hex(value)

    key = value.strip()
    pal = palette or {}
    seen = set()
    while key in pal:
        if key in seen:
            raise BGError("调色板循环引用: %r" % (value,))
        seen.add(key)
        key = pal[key]

    if not key.startswith("#"):
        raise BGError(
            "色值令牌无法解析: %r（不在调色板 %s 中，也不是 #RRGGBB）"
            % (value, sorted(pal.keys()))
        )
    return parse_hex(key)


def interpolate(c1: RGBA, c2: RGBA, t: float) -> RGBA:
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return (
        int(round(c1[0] + (c2[0] - c1[0]) * t)),
        int(round(c1[1] + (c2[1] - c1[1]) * t)),
        int(round(c1[2] + (c2[2] - c1[2]) * t)),
        int(round(c1[3] + (c2[3] - c1[3]) * t)),
    )


# ------------------------------------------------------------------ 渐变
def linear_gradient(size: Tuple[int, int], c1: RGBA, c2: RGBA, angle_deg: float = 135.0) -> Image.Image:
    """
    任意角度线性渐变。
    做法：造一张 (1, diag) 的竖直渐变条 -> 横向拉成方阵 -> 旋转 -> 按目标尺寸居中裁切。
    """
    w, h = size
    diag = int(math.hypot(w, h)) + 2

    strip = Image.new("RGBA", (1, diag))
    px = strip.load()
    for y in range(diag):
        px[0, y] = interpolate(c1, c2, y / max(1, diag - 1))

    grad = strip.resize((diag, diag), Image.BILINEAR)
    grad = grad.rotate(-float(angle_deg), resample=Image.BICUBIC, expand=False)

    left = (diag - w) // 2
    top = (diag - h) // 2
    return grad.crop((left, top, left + w, top + h))


# ------------------------------------------------------------------ 光斑
def add_blob(img: Image.Image, blob: Dict[str, Any], palette: Optional[Dict[str, str]] = None) -> Image.Image:
    """柔焦光斑：画圆 -> 高斯模糊 -> alpha 叠加。给纯色/渐变基底体积感。"""
    w, h = img.size
    cx = int(w * float(blob.get("x", 0.5)))
    cy = int(h * float(blob.get("y", 0.5)))
    r = int(min(w, h) * float(blob.get("r", 0.3)))
    color = resolve_color(blob.get("color", "#ffffff40"), palette)
    opacity = float(blob.get("opacity", 1.0))
    color = (color[0], color[1], color[2], max(0, min(255, int(color[3] * opacity))))

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    layer = layer.filter(ImageFilter.GaussianBlur(float(blob.get("blur", 0.12)) * min(w, h)))
    return Image.alpha_composite(img, layer)


# ------------------------------------------------------------------ 背景
def cover_crop(img: Image.Image, size: Tuple[int, int]) -> Image.Image:
    """等比放大 + 居中裁切，避免拉伸变形。"""
    w, h = size
    # 背景图同样要过 EXIF 方向，否则手机拍的背景会横着铺
    img = ImageOps.exif_transpose(img)
    scale = max(w / img.width, h / img.height)
    img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))), Image.LANCZOS)
    left = (img.width - w) // 2
    top = (img.height - h) // 2
    return img.crop((left, top, left + w, top + h)).convert("RGBA")


def apply_scrim(base: "Image.Image", scrim: Dict[str, Any], palette: Optional[Dict[str, str]] = None) -> "Image.Image":
    """
    给底图压一层**竖向渐变**遮罩，让上层白字在浅色画面上也读得清。

    为什么必须做进渲染器：前端早先是拿 6 块半透明矩形拼的近似渐变，
    在深色渐变上不明显，但换成浅色照片（清晨薄雾那种）就露出**一道一道的横条**，
    看着像渲染坏了。真正的逐行渐变只有渲染器做得到。

    scrim 形如：
      {"top": 0.30, "bottom": 0.78, "start": 0.0, "end": 1.0, "color": "#000000"}
    top/bottom：渐变起点/终点的透明度；start/end：覆盖的纵向范围（0~1）。
    """
    if not isinstance(scrim, dict) or not scrim:
        return base
    w, h = base.size
    color = resolve_color(scrim.get("color", "#000000"), palette) or (0, 0, 0)
    a_top = max(0.0, min(1.0, float(scrim.get("top", 0.30))))
    a_bot = max(0.0, min(1.0, float(scrim.get("bottom", 0.78))))
    y0 = int(round(max(0.0, min(1.0, float(scrim.get("start", 0.0)))) * h))
    y1 = int(round(max(0.0, min(1.0, float(scrim.get("end", 1.0)))) * h))
    if y1 <= y0:
        return base

    # 逐行画 1px 高的矩形。1440 行就是 1440 次 draw，比整图逐像素快得多。
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    span = float(y1 - y0)
    for y in range(y0, y1):
        t = (y - y0) / span
        alpha = int(round(255 * (a_top + (a_bot - a_top) * t)))
        if alpha <= 0:
            continue
        d.rectangle([0, y, w, y + 1], fill=(color[0], color[1], color[2], alpha))
    return Image.alpha_composite(base.convert("RGBA"), layer)


def make_background(
    bg: Dict[str, Any],
    size: Tuple[int, int],
    palette: Optional[Dict[str, str]] = None,
    base_dir: str = ".",
) -> Image.Image:
    """
    生成基底图层。

    bg 形如：
      {"type": "gradient", "from": "bgFrom", "to": "bgTo", "angle": 130, "blobs": [...]}
      {"type": "solid", "color": "#102030"}
      {"type": "image", "image": "assets/x.png", "scrim": {"top":0.3,"bottom":0.78}}
    """
    if bg is None:
        bg = {}
    if not isinstance(bg, dict):
        raise BGError("background 必须是对象，收到 %r" % (type(bg).__name__,))

    kind = bg.get("type") or "gradient"

    if kind == "image":
        path = bg.get("image")
        if not path:
            raise BGError("background.type=image 但缺少 image 路径")
        full = path if os.path.isabs(path) else os.path.join(base_dir, path)
        if not os.path.isfile(full):
            raise BGError("背景图不存在: %s" % full)
        base = cover_crop(Image.open(full).convert("RGB"), size)

    elif kind == "solid":
        base = Image.new("RGBA", size, resolve_color(bg.get("color", "#101820"), palette))

    elif kind == "gradient":
        c1 = resolve_color(bg.get("from", "#12303f"), palette)
        c2 = resolve_color(bg.get("to", "#2f6f7a"), palette)
        base = linear_gradient(size, c1, c2, float(bg.get("angle", 135)))

    else:
        raise BGError("未知 background.type: %r（可选 gradient/solid/image）" % (kind,))

    # 图片底图可以带一层竖向渐变遮罩（文字可读性靠它）
    if kind == "image" and bg.get("scrim"):
        base = apply_scrim(base, bg["scrim"], palette)

    for blob in bg.get("blobs") or []:
        base = add_blob(base, blob, palette)

    return base
