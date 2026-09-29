#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
poster-forge renderer
=====================

把一份「结构化文档」渲染成成品海报。

设计原则（这套东西存在的理由）：
  1. 文字、logo、二维码、价格 永远走本引擎，永远不进扩散模型
     —— 扩散模型画不准中文，而 B2B 客户对文字准确性是零容忍。
  2. render(spec) 是纯函数：同样的 spec 永远得到同样的图。
     可复现 => 可测试 => 可回滚。模型换代不影响业务代码。
  3. AI 只出现在两个可替换的适配器位置：
       - 「生成 spec」（LLM）        -> 调用方的事，本引擎不关心
       - 「生成背景图/抠图」（图像模型）-> 本引擎只负责把它当图片放进去

用法：
    python render.py --spec specs/hotel-autumn.json
    python render.py --spec specs/restaurant-lunch.json --out out/x.png
    python render.py --spec spec.json --overrides '{"canvas":{"width":1080,"height":1080}}'
"""

from __future__ import annotations

import argparse
import copy
import io
import json
import os
import sys
from typing import Any, Iterable, List, Optional, Sequence, Tuple

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps
except ImportError:  # pragma: no cover
    sys.stderr.write("需要 Pillow：E:\\devenv\\Scripts\\python.exe -m pip install pillow\n")
    raise

try:
    from bg import make_background as make_bg
    from bg import resolve_color as resolve_color_bg
except ImportError:  # pragma: no cover
    sys.stderr.write("缺少同目录的 bg.py（背景/调色板模块）\n")
    raise

# qrcode 是可选依赖：没装就跳过二维码图元，并给出明确警告。
try:
    import qrcode  # type: ignore

    HAS_QRCODE = True
except ImportError:
    HAS_QRCODE = False


HERE = os.path.dirname(os.path.abspath(__file__))

# 图片搜索根。默认只有 poster-forge 自身；
# 站点会把 public/ 也注册进来 —— 用户上传的照片存在那里，
# 而 spec 里的路径是相对站点的（如 "uploads/xxx.png"）。
# 不做这件事会出现"上传成功但渲染报图片不存在"。
IMAGE_ROOTS = [HERE]


def register_image_root(path: str) -> None:
    """注册额外的图片搜索根（插到最前，优先于 poster-forge）。"""
    p = os.path.abspath(path)
    if p not in IMAGE_ROOTS:
        IMAGE_ROOTS.insert(0, p)


def resolve_image_path(src: str) -> str:
    """把 spec 里的 src 解析成真实文件路径；绝对路径原样返回。"""
    if not src:
        return src
    if os.path.isabs(src):
        return src
    for root in IMAGE_ROOTS:
        cand = os.path.join(root, src)
        if os.path.isfile(cand):
            return cand
    # 全部不存在时返回首个候选，让报错指向最可能的位置
    return os.path.join(IMAGE_ROOTS[0], src)


def validate_image_roots() -> None:
    """启动时把 PF_IMAGE_ROOT 指定的目录注册为图片搜索根。

    站点（site/server.mjs）会把它的 public/ 传进来 —— 用户上传的照片存那里，
    而 spec 里的路径是相对站点的。用环境变量而不是命令行参数，
    故意避免 argparse 把多余参数吞掉带来的意外。
    """
    extra = os.environ.get("PF_IMAGE_ROOT")
    if not extra:
        return
    for one in extra.split(os.pathsep):
        one = one.strip()
        if one and os.path.isdir(one):
            register_image_root(one)


validate_image_roots()


# ---------------------------------------------------------------- 字体注册表
# 声明式引用：spec / layout 里只写字号，字体走这里。
# Windows 字体名 -> 文件。换机器只需改这一张表。
FONT_FILES = {
    # 黑体族（宣传物料主力）
    "bold": r"C:\Windows\Fonts\msyhbd.ttc",      # 微软雅黑 Bold
    "sans": r"C:\Windows\Fonts\msyh.ttc",        # 微软雅黑 Regular
    "light": r"C:\Windows\Fonts\msyhl.ttc",      # 微软雅黑 Light
    "heavy": r"C:\Windows\Fonts\simhei.ttf",     # 黑体（更粗，标题用）
    # 备选风格
    "song": r"C:\Windows\Fonts\simsun.ttc",      # 宋体
    "kai": r"C:\Windows\Fonts\simkai.ttf",       # 楷体
    "deng": r"C:\Windows\Fonts\Deng.ttf",        # 等线
    "dengb": r"C:\Windows\Fonts\Dengb.ttf",      # 等线 Bold
    "zhong": r"C:\Windows\Fonts\STZHONGS.TTF",   # 华文中宋
}
DEFAULT_FONT = "sans"


class RenderError(Exception):
    """输入不合法 —— 这是给调用方看的错误，不是崩溃。"""


# ---------------------------------------------------------------- 小工具
def parse_color(value: Any, default: Optional[Tuple[int, ...]] = None) -> Optional[Tuple[int, ...]]:
    """'#RRGGBB' / '#RRGGBBAA' / [r,g,b] / [r,g,b,a] -> RGBA 元组"""
    if value is None:
        return default
    if isinstance(value, (list, tuple)):
        vals = [int(max(0, min(255, v))) for v in value]
        if len(vals) == 3:
            vals.append(255)
        if len(vals) != 4:
            raise RenderError("颜色数组必须是 3 或 4 个分量: %r" % (value,))
        return tuple(vals)  # type: ignore[return-value]
    if isinstance(value, str):
        s = value.strip().lstrip("#")
        if len(s) == 3:
            s = "".join(c * 2 for c in s)
        if len(s) == 6:
            s += "ff"
        if len(s) != 8:
            raise RenderError("颜色格式无法识别: %r" % (value,))
        try:
            return tuple(int(s[i : i + 2], 16) for i in (0, 2, 4, 6))  # type: ignore[return-value]
        except ValueError:
            raise RenderError("颜色格式无法识别: %r" % (value,))
    raise RenderError("颜色类型无法识别: %r" % (value,))


# ---------------------------------------------------------------- 调色板
# 图层里可以写调色板变量名（如 "gold"、"accent"）而不是写死色值。
# 这是"换主题即换整张海报气质"的实现基础：色值只在一处定义。
_PALETTE: dict = {}


def set_palette(theme: Optional[dict]) -> None:
    global _PALETTE
    palette = (theme or {}).get("palette") or {}
    _PALETTE = dict(palette)


def resolve_color(value: Any) -> Optional[Tuple[int, ...]]:
    """
    把颜色描述解析成 RGBA。实现委托给 bg.resolve_color（单一实现来源），
    这里只负责把当前主题的 palette 传进去。
    """
    return resolve_color_bg(value, _PALETTE)


def interpolate(c1: Tuple[int, ...], c2: Tuple[int, ...], t: float) -> Tuple[int, ...]:
    """两个颜色按 t∈[0,1] 线性插值，含 alpha。"""
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(c1, c2))  # type: ignore[return-value]


def to_hex(c: Tuple[int, ...]) -> str:
    return "#%02x%02x%02x%02x" % c


# ---------------------------------------------------------------- 字体
_font_cache: dict = {}


def load_font(name: str, size: int) -> "ImageFont.FreeTypeFont":
    """按注册名 + 字号取字体，带缓存。"""
    key = (name, size)
    if key in _font_cache:
        return _font_cache[key]
    path = FONT_FILES.get(name)
    if path is None or not os.path.isfile(path):
        # 优雅降级：找不到就用系统里第一个能加载的 CJK 字体
        for cand in FONT_FILES.values():
            if os.path.isfile(cand):
                path = cand
                break
        if path is None:
            raise RenderError("找不到任何可用字体，请检查 FONT_FILES 表")
        sys.stderr.write("[warn] 字体 %r 不可用，降级到 %s\n" % (name, os.path.basename(path)))
    font = ImageFont.truetype(path, size)
    _font_cache[key] = font
    return font


def is_cjk(ch: str) -> bool:
    """判断是否 CJK/全角字符 —— 决定换行时能否逐字断开。"""
    o = ord(ch)
    return (
        0x2E80 <= o <= 0x9FFF      # CJK 部首 ～ 统一表意文字
        or 0xF900 <= o <= 0xFAFF   # 兼容表意文字
        or 0xFF00 <= o <= 0xFFEF   # 全角形式
        or 0x3000 <= o <= 0x303F   # CJK 标点
    )


def text_tokens(text: str) -> List[str]:
    """
    把文本切成换行单元：
      - 显式 \n 保留为硬换行标记
      - CJK 逐字可断
      - 拉丁按词聚合，词内不断（避免 "Beach" 断成 "Bea/ ch"）
    """
    tokens: List[str] = []
    buf = ""
    for ch in text:
        if ch == "\n":
            if buf:
                tokens.append(buf)
                buf = ""
            tokens.append("\n")
            continue
        if is_cjk(ch) or ch.isspace():
            if buf:
                tokens.append(buf)
                buf = ""
            if not ch.isspace():
                tokens.append(ch)
            else:
                tokens.append(" ")
        else:
            buf += ch
    if buf:
        tokens.append(buf)
    return tokens


# 可以在其后断行的标点（中文排版的"避头尾"简化版）。
# 破折号、书名号等成对出现的标点不在此列，避免把右半拉走。
BREAK_AFTER = "，、。；：！？·・）】》」』…—"


def wrap_text(text: str, font: "ImageFont.FreeTypeFont", max_width: int) -> List[str]:
    """
    按像素宽度折行，尊重显式换行。

    两条规则，顺序不能反：
      1. **优先在标点/空格处断**（中文排版的避头尾简化版）。
      2. 找不到断点才逐字断，并且断完做一次"避孤字"调整。

    踩过的坑：标题「清晨·水墨西湖」在 104pt 下一行放不下，旧实现逐字断在
    "水墨西"后面，把"子"孤零零甩到第二行；「双人套餐 4 菜 1 汤」也一样，
    末行只剩"汤"。中文排版本来就不该在词中间断，空格和标点才是天然断点。
    """
    lines: List[str] = []
    for hard_line in text.split("\n"):
        tokens = [t for t in text_tokens(hard_line) if t != "\n"]
        current: List[str] = []
        for tok in tokens:
            trial = current + [tok]
            if measure("".join(trial), font)[0] <= max_width or not current:
                current = trial
                continue

            # --- 放不下了：先找"标点/空格之后"的回退点 ---
            best = -1
            for i in range(len(current) - 1, -1, -1):
                if current[i] == " " or (current[i] and current[i][-1] in BREAK_AFTER):
                    best = i
                    break
            joined = "".join(current)
            if best >= 0:
                first = "".join(current[: best + 1])
                rest = "".join(current[best + 1 :])
                # 回退不能把首行弄得太短（否则为了避字把行拆得很难看）
                if measure(first.rstrip(), font)[0] >= max_width * 0.30 and len(first.strip()) >= 3:
                    lines.append(first.rstrip())
                    current = ([rest] if rest else []) + [tok]
                    continue

            lines.append(joined.rstrip())
            current = [tok]

        if current:
            lines.append("".join(current).rstrip())

    # 避孤字：末行只剩**一个字**最刺眼（"…促销"可以接受，"…销"不行）。
    # 所以只针对单字末行，从上一行末尾挪词单元下来；必要时连挪两轮。
    for _ in range(2):
        if len(lines) < 2 or not lines[-1] or len(lines[-1]) > 1:
            break
        toks = text_tokens(lines[-2])
        if len(toks) < 2:
            break
        moved = toks[-1]
        cand_prev = "".join(toks[:-1]).rstrip()
        cand_last = (moved + lines[-1]).strip()
        if len(cand_prev) >= 4:
            lines[-2] = cand_prev
            lines[-1] = cand_last
        else:
            break
    return lines


def measure(text: str, font: "ImageFont.FreeTypeFont") -> Tuple[int, int]:
    """(宽, 高) —— 用 getbbox 的真实墨迹范围，避免不同字体的行高差异。"""
    if not text:
        return (0, font.size)
    box = font.getbbox(text)
    return (box[2] - box[0], box[3] - box[1])


def fit_font_size(
    text: str,
    font_name: str,
    max_size: int,
    min_size: int,
    max_width: Optional[int],
    max_height: Optional[int],
    max_lines: Optional[int],
) -> Tuple["ImageFont.FreeTypeFont", List[str]]:
    """
    二分找最大可用字号：让文本在给定位数/宽高内恰好放得下。
    这是"版式自适应"的核心 —— 文案长短不定，标题不能溢出也不能太小。
    """
    lo, hi = min_size, max_size
    best_font = load_font(font_name, min_size)
    best_lines = wrap_text(text, best_font, max_width or 10**9)
    while lo <= hi:
        mid = (lo + hi) // 2
        font = load_font(font_name, mid)
        lines = wrap_text(text, font, max_width or 10**9)
        line_h = int(round(mid * 1.28))
        fits = True
        if max_lines and len(lines) > max_lines:
            fits = False
        if max_width and any(measure(l, font)[0] > max_width for l in lines):
            fits = False
        if max_height and len(lines) * line_h > max_height:
            fits = False
        if fits:
            best_font, best_lines = font, lines
            lo = mid + 1
        else:
            hi = mid - 1
    return best_font, best_lines


# ---------------------------------------------------------------- 图层：背景
# 背景/调色板逻辑在 bg.py（显式传 palette，无模块级时序状态）。
def make_background(bg: dict, size: Tuple[int, int], palette: Optional[dict] = None) -> "Image.Image":
    """
    bg     : background 配置本身（不是整个 spec！）
    palette: 调色板；不传则从最近的 set_palette 状态取。

    注意：背景图也要走 resolve_image_path —— 否则会出现
    "图层里的图片找得到、背景图却找不到"这种两套解析逻辑并存的问题。
    """
    if palette is None:
        palette = _PALETTE
    if bg and bg.get("type") == "image" and bg.get("image"):
        bg = dict(bg)
        bg["image"] = resolve_image_path(bg["image"])
    return make_bg(bg or {}, size, palette, HERE)


# ---------------------------------------------------------------- 图层：形状
def draw_shape(canvas: "Image.Image", el: dict, scale: float = 1.0) -> None:
    """矩形/圆角矩形/圆/线条。所有几何值都是画布坐标（已由布局解析成像素）。"""
    w, h = canvas.size
    kind = el.get("type", "rect")
    box = _resolve_box(el, (w, h))
    if box is None:
        return
    x0, y0, x1, y1 = box

    fill = resolve_color(el.get("fill"))
    outline = resolve_color(el.get("stroke"))
    stroke_w = int(round(float(el.get("strokeWidth", 0)) * scale))
    radius = int(round(float(el.get("radius", 0)) * scale))
    opacity = float(el.get("opacity", 1.0))

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    if kind == "line":
        if outline:
            d.line([x0, y0, x1, y1], fill=outline, width=max(1, stroke_w))
    elif kind == "circle":
        d.ellipse([x0, y0, x1, y1], fill=fill, outline=outline, width=stroke_w)
    elif kind == "rect" and radius > 0:
        d.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill, outline=outline, width=stroke_w)
    else:
        d.rectangle([x0, y0, x1, y1], fill=fill, outline=outline, width=stroke_w)

    # 圆角描边在 PIL 里会盖住内边，这里按需再压一层内部填充，保证「描边+填充」都对
    if kind == "rect" and radius > 0 and fill and outline and stroke_w > 0:
        d.rounded_rectangle(
            [x0 + stroke_w, y0 + stroke_w, x1 - stroke_w, y1 - stroke_w],
            radius=max(0, radius - stroke_w),
            fill=fill,
        )

    if opacity < 1.0:
        a = layer.getchannel("A").point(lambda v: int(v * opacity))
        layer.putalpha(a)
    canvas.alpha_composite(layer)


def _resolve_box(el: dict, size: Tuple[int, int]) -> Optional[Tuple[int, int, int, int]]:
    """把元素的位置描述解析成像素坐标 (x0,y0,x1,y1)。"""
    w, h = size
    if el.get("type") == "line":
        pts = el.get("points") or [[0, 0], [1, 0]]
        (ax, ay), (bx, by) = pts[0], pts[1]
        return (int(w * ax), int(h * ay), int(w * bx), int(h * by))

    box = el.get("box")
    # 规范写法：{"box": [x, y], "size": [w, h]}（坐标为画布比例）
    if isinstance(box, dict):
        pos = box.get("box") or [0, 0]
        size_wh = box.get("size") or el.get("size") or [0, 0]
        if len(pos) != 2 or len(size_wh) != 2:
            raise RenderError("box 对象写法必须是 {box:[x,y], size:[w,h]}，收到: %r" % (box,))
        x, y = pos
        sw, sh = size_wh
        return (int(w * x), int(h * y), int(w * (x + sw)), int(h * (y + sh)))

    if box:
        if len(box) == 2:  # [x,y] + el["size"]
            x, y = box
            sw, sh = el.get("size", [0, 0])
            return (int(w * x), int(h * y), int(w * (x + sw)), int(h * (y + sh)))
        if len(box) == 4:  # [x0,y0,x1,y1]
            x0, y0, x1, y1 = box
            return (int(w * x0), int(h * y0), int(w * x1), int(h * y1))
    return None


# ---------------------------------------------------------------- 图层：文本
def draw_text(canvas: "Image.Image", el: dict) -> None:
    """
    文本图元。要点：
      - 自动折行 + 自动缩字号（fit）
      - 左右对齐、行高倍率
      - 阴影 / 描边 —— 保证文字压在照片上也读得清
    """
    w, h = canvas.size
    text = el.get("text")
    if text is None:
        return
    text = str(text)
    if not text.strip():
        return

    font_name = el.get("font", DEFAULT_FONT)
    size = int(el.get("size", 40))

    def _px(v, base):
        """比例（<=1）转像素；否则视为已是像素。"""
        return int(base * float(v)) if v is not None and float(v) <= 1 else (int(v) if v is not None else None)

    # 宽度上限可以写在元素级，也可以写在 fit 里。
    # **必须两处都读** —— 早先只读元素级，导致
    # `fit: { maxWidth: 0.864 }` 这种写法被完全忽略，
    # 长句不折行、直接溢出被裁掉（实测"风大记得带外套"被切掉）。
    fit = el.get("fit") or {}
    max_width = _px(el.get("maxWidth", fit.get("maxWidth")), w)

    if el.get("fit"):
        max_h = _px(fit.get("maxHeight"), h)
        font, lines = fit_font_size(
            text,
            font_name,
            max_size=int(fit.get("maxSize", size)),
            min_size=int(fit.get("minSize", 18)),
            max_width=max_width,
            max_height=max_h,
            max_lines=fit.get("maxLines"),
        )
    else:
        font = load_font(font_name, size)
        lines = wrap_text(text, font, max_width or 10**9)

    line_h = int(round(font.size * float(el.get("lineHeight", 1.28))))

    # 兜底：万一还有某行超出 maxWidth（非 fit 模式、或极端长词），
    # 强制到能放下为止。**被裁掉的文字比缩小字号严重得多** ——
    # 裁剪是静默丢内容，用户看不到自己写的东西。
    if max_width:
        guard = 0
        while any(measure(l, font)[0] > max_width for l in lines) and font.size > 12 and guard < 60:
            font = load_font(font_name, font.size - 1)
            lines = wrap_text(text, font, max_width)
            line_h = int(round(font.size * float(el.get("lineHeight", 1.28))))
            guard += 1

    color = resolve_color(el.get("color", "#ffffff"))
    align = el.get("align", "left")
    valign = el.get("valign", "top")

    block_h = line_h * len(lines)
    x = int(w * float(el.get("x", 0.0)))
    y = int(h * float(el.get("y", 0.0)))
    # 允许用 [0,1] 之外的值做溢出定位（如居中锚点），这里不做钳制

    if valign == "center":
        y -= block_h // 2
    elif valign == "bottom":
        y -= block_h

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    shadow = el.get("shadow")
    stroke = el.get("stroke")

    for i, line in enumerate(lines):
        lw, _ = measure(line, font)
        if align == "center":
            lx = x - lw // 2
        elif align == "right":
            lx = x - lw
        else:
            lx = x
        ly = y + i * line_h

        # 字体 bbox 顶部通常有空白，用 offset 修正首行基线，让视觉上沿对齐
        off = -font.getbbox(line)[1] if line else 0
        ly_adj = ly + off

        if shadow:
            sc = resolve_color(shadow.get("color", "#00000080"))
            sdx = int(shadow.get("dx", 0))
            sdy = int(shadow.get("dy", 3))
            sblur = float(shadow.get("blur", 0))
            if sblur > 0:
                sl = Image.new("RGBA", (w, h), (0, 0, 0, 0))
                ImageDraw.Draw(sl).text((lx + sdx, ly_adj + sdy), line, font=font, fill=sc)
                sl = sl.filter(ImageFilter.GaussianBlur(sblur))
                layer.alpha_composite(sl)
            else:
                d.text((lx + sdx, ly_adj + sdy), line, font=font, fill=sc)

        if stroke:
            sw = int(stroke.get("width", 2))
            d.text(
                (lx, ly_adj),
                line,
                font=font,
                fill=color,
                stroke_width=sw,
                stroke_fill=resolve_color(stroke.get("color", "#000000")),
            )
        else:
            d.text((lx, ly_adj), line, font=font, fill=color)

    canvas.alpha_composite(layer)


# ---------------------------------------------------------------- 图层：图片
def draw_image(canvas: "Image.Image", el: dict) -> None:
    """贴入图片，支持 cover/contain、圆角裁切、透明度。"""
    w, h = canvas.size
    path = el.get("src") or el.get("image")
    if not path:
        raise RenderError("image 图元缺少 src")
    path = resolve_image_path(path)
    if not os.path.isfile(path):
        raise RenderError("图片不存在: %s" % path)

    src = Image.open(path)
    # EXIF 方向校正：手机竖拍的照片实际存成横向 + Orientation 标签，
    # 不处理会横着进版式。这是"看起来能用但结果错"的典型 bug，
    # 所以放在最靠近加载的一步统一处理。
    src = ImageOps.exif_transpose(src)
    src = src.convert("RGBA")
    box = el.get("box")
    if not box:
        raise RenderError("image 图元缺少 box")
    if isinstance(box, dict):
        pos = box.get("box") or [0, 0]
        size_wh = box.get("size") or el.get("size") or [0, 0]
        bx, by = pos
        bw, bh = size_wh
    elif len(box) == 4:  # [x0,y0,x1,y1]
        bx, by, x1, y1 = box
        bw, bh = x1 - bx, y1 - by
    else:  # [x,y] + el["size"]
        bx, by = box
        bw, bh = el.get("size", [0, 0])
    x0, y0 = int(w * bx), int(h * by)
    tw, th = int(w * bw), int(h * bh)
    if tw <= 0 or th <= 0:
        raise RenderError("image 图元尺寸非法: %r" % (box,))

    mode = el.get("fit", "cover")
    if mode == "cover":
        scale = max(tw / src.width, th / src.height)
        nw, nh = max(1, int(src.width * scale)), max(1, int(src.height * scale))
        src = src.resize((nw, nh), Image.LANCZOS)
        left, top = (nw - tw) // 2, (nh - th) // 2
        tile = src.crop((left, top, left + tw, top + th))
    else:  # contain
        scale = min(tw / src.width, th / src.height)
        nw, nh = max(1, int(src.width * scale)), max(1, int(src.height * scale))
        src = src.resize((nw, nh), Image.LANCZOS)
        tile = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
        tile.alpha_composite(src, ((tw - nw) // 2, (th - nh) // 2))

    radius = int(round(float(el.get("radius", 0)) * min(tw, th)))
    if radius > 0:
        mask = Image.new("L", (tw, th), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, tw - 1, th - 1], radius=radius, fill=255)
        tile.putalpha(ImageChops.multiply(tile.getchannel("A"), mask))

    tiles = el.get("tiles")
    if tiles:  # 把该图切成 N 份排成网格（多房型、多菜品、多张打卡照）
        count = max(1, int(tiles))
        gap = int(w * float(el.get("gap", 0.015)))
        # 网格形状：1→1x1，2→2x1，4→2x2，其余→3x1
        cols, rows = {1: (1, 1), 2: (2, 1), 4: (2, 2)}.get(count, (3, 1))
        cell_w = tw if cols == 1 else (tw - gap * (cols - 1)) // cols
        sub_h = th if rows == 1 else (th - gap * (rows - 1)) // rows
        for i in range(count):
            r_i, c_i = divmod(i, cols)
            # 从已 cover 的 tile 里按比例取区域，保证每格内容不重复、比例正确
            sx0 = int(tile.width * (c_i / cols))
            sx1 = int(tile.width * ((c_i + 1) / cols))
            sy0 = int(tile.height * (r_i / rows))
            sy1 = int(tile.height * ((r_i + 1) / rows))
            cell = tile.crop((sx0, sy0, sx1, sy1)).resize((cell_w, sub_h), Image.LANCZOS)
            if radius > 0:
                m = Image.new("L", (cell_w, sub_h), 0)
                ImageDraw.Draw(m).rounded_rectangle(
                    [0, 0, max(0, cell_w - 1), max(0, sub_h - 1)], radius=radius, fill=255)
                cell.putalpha(ImageChops.multiply(cell.getchannel("A"), m))
            canvas.alpha_composite(cell, (x0 + c_i * (cell_w + gap), y0 + r_i * (sub_h + gap)))
        return

    opacity = float(el.get("opacity", 1.0))
    if opacity < 1.0:
        a = tile.getchannel("A").point(lambda v: int(v * opacity))
        tile.putalpha(a)

    # 图片描边（多图网格用它代替统一外框 —— 2 行时外框会切过第二行）
    stroke = resolve_color(el.get("stroke"))
    if stroke is not None:
        sw = float(el.get("strokeWidth", 2))
        # 随图尺寸缩放：小图上 2px 会显得过重
        sw = max(1.0, sw * min(tw, th) / (0.5 * w))
        ring = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
        rd = ImageDraw.Draw(ring)
        if radius > 0:
            rd.rounded_rectangle([0, 0, tw - 1, th - 1], radius=radius, outline=stroke, width=int(round(sw)))
        else:
            rd.rectangle([0, 0, tw - 1, th - 1], outline=stroke, width=int(round(sw)))
        tile = Image.alpha_composite(tile, ring)

    canvas.alpha_composite(tile, (x0, y0))


# ---------------------------------------------------------------- 图层：二维码
def draw_qr(canvas: "Image.Image", el: dict) -> None:
    """二维码图元。qrcode 未安装时明确警告并跳过（不静默失败）。"""
    if not HAS_QRCODE:
        sys.stderr.write(
            "[warn] spec 里有 qr 图元，但 qrcode 未安装，已跳过。"
            "安装：python -m pip install qrcode\n"
        )
        return
    data = el.get("data")
    if not data:
        return
    w, h = canvas.size
    qr = qrcode.QRCode(border=1, box_size=10, error_correction=qrcode.constants.ERROR_CORRECT_M)
    qr.add_data(str(data))
    qr.make(fit=True)
    img = qr.make_image(fill_color=el.get("fg", "#000000"), back_color=el.get("bg", "#ffffff")).convert("RGBA")

    box = el.get("box")
    if not box:
        return
    bx, by, bw, bh = box
    side = int(min(w * bw, h * bh))
    img = img.resize((side, side), Image.NEAREST)

    # 白色底板 + 圆角，避免二维码压在花背景上扫不出来（扫码可靠性）
    pad = int(side * 0.08)
    plate = Image.new("RGBA", (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
    pd = ImageDraw.Draw(plate)
    radius = int((side + pad * 2) * float(el.get("radius", 0.12)))
    pd.rounded_rectangle(
        [0, 0, plate.width - 1, plate.height - 1], radius=max(0, radius), fill=resolve_color(el.get("bg", "#ffffff"))
    )
    plate.alpha_composite(img, (pad, pad))
    canvas.alpha_composite(plate, (int(w * bx), int(h * by)))


# ---------------------------------------------------------------- 装饰
def draw_ornaments(canvas: "Image.Image", spec: dict, scale: float) -> None:
    """四角装饰线 —— 让"政务/高端"版式不显得空。纯几何，可安全缩放到任意尺寸。"""
    orn = (spec.get("theme") or {}).get("ornaments")
    if not orn:
        return
    w, h = canvas.size
    color = resolve_color(orn.get("color", "#d8b46a"))
    length = int(min(w, h) * float(orn.get("length", 0.08)))
    inset = int(min(w, h) * float(orn.get("inset", 0.035)))
    thick = max(1, int(round(float(orn.get("width", 3)) * scale)))

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    corners = [
        (inset, inset, 1, 1),
        (w - inset, inset, -1, 1),
        (inset, h - inset, 1, -1),
        (w - inset, h - inset, -1, -1),
    ]
    for cx, cy, sx, sy in corners:
        d.line([cx, cy, cx + sx * length, cy], fill=color, width=thick)
        d.line([cx, cy, cx, cy + sy * length], fill=color, width=thick)
    canvas.alpha_composite(layer)


# ---------------------------------------------------------------- 主流程
ELEMENT_DRAWERS = {
    "shape": draw_shape,
    "text": draw_text,
    "image": draw_image,
    "qr": draw_qr,
}


def resolve(root: dict, value: Any, depth: int = 0) -> Any:
    """
    递归解析 @layout: 引用。
    layout 提供「版式骨架」，spec 提供「内容」——两者分离是关键：
    换版式不用改内容，换内容不用改版式。
    """
    if depth > 8:
        raise RenderError("@layout 引用层级过深，可能存在循环引用")
    if isinstance(value, str) and value.startswith("@layout:"):
        name = value[len("@layout:") :]
        path = os.path.join(HERE, "layouts", name + ".json")
        if not os.path.isfile(path):
            raise RenderError("找不到 layout: %s (期望 %s)" % (name, path))
        with open(path, "r", encoding="utf-8") as fh:
            return resolve(root, json.load(fh), depth + 1)
    if isinstance(value, dict):
        return {k: resolve(root, v, depth + 1) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(root, v, depth + 1) for v in value]
    return value


def deep_merge(base: Any, override: Any) -> Any:
    """spec 覆盖 layout：dict 递归合并，list/标量整体替换。"""
    if isinstance(base, dict) and isinstance(override, dict):
        out = dict(base)
        for k, v in override.items():
            out[k] = deep_merge(base[k], v) if k in base else v
        return out
    return override


def build_spec(source: dict, overrides: Optional[dict] = None) -> dict:
    """把 spec 文件 + 可选 overrides 合成最终 spec。"""
    spec = copy.deepcopy(source)
    if spec.get("layout"):
        spec = deep_merge(resolve(spec, spec["layout"]), spec)
        spec.pop("layout", None)
    spec = resolve(spec, spec)
    if overrides:
        spec = deep_merge(spec, overrides)
    return spec


def render(spec: dict) -> "Image.Image":
    """spec -> PIL Image。纯函数：同样的 spec 必然得到同样的像素。"""
    canvas_cfg = spec.get("canvas") or {}
    w = int(canvas_cfg.get("width", 1080))
    h = int(canvas_cfg.get("height", 1440))
    scale = w / 1080.0  # 相对基准宽度缩放所有"物理"尺寸

    if w <= 0 or h <= 0 or w > 20000 or h > 20000:
        raise RenderError("canvas 尺寸非法: %dx%d" % (w, h))

    set_palette(spec.get("theme"))
    palette = (spec.get("theme") or {}).get("palette") or {}
    canvas = make_background(spec.get("background") or {}, (w, h), palette)

    # 图层顺序 = 数组顺序，后者压前者。显式，可预期。
    for el in spec.get("layers") or []:
        kind = el.get("type")
        if kind == "group":
            for sub in el.get("layers") or []:
                drawer = ELEMENT_DRAWERS.get(sub.get("type"))
                if drawer is None:
                    raise RenderError("未知图元类型: %r" % (sub.get("type"),))
                drawer(canvas, sub)  # type: ignore[arg-type]
            continue
        drawer = ELEMENT_DRAWERS.get(kind)
        if drawer is None:
            raise RenderError("未知图元类型: %r" % (kind,))
        drawer(canvas, el)  # type: ignore[arg-type]

    draw_ornaments(canvas, spec, scale)

    out = canvas.convert("RGB")
    if spec.get("quality", {}).get("sharpen"):
        out = out.filter(ImageFilter.UnsharpMask(radius=1.6, percent=60, threshold=3))
    return out


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="poster-forge：结构化文档 -> 成品海报")
    ap.add_argument("--spec", required=True, help="spec JSON 路径")
    ap.add_argument("--out", help="输出 PNG 路径（默认 out/<spec名>.png）")
    ap.add_argument("--overrides", help="JSON 字符串，覆盖 spec 字段")
    # 图片根目录：spec 里的图片路径（uploads/xxx.jpg、uploads/.bgcache/bg-x.png）
    # 是**相对站点 public 目录**的，而渲染器默认只认自己所在目录 ——
    # 不登记这个根目录，凡是引用图片的规格都会解析失败。
    # 可重复传，先传的优先。
    ap.add_argument("--image-root", action="append", default=[],
                    help="spec 中相对图片路径的查找根目录（可重复）")
    args = ap.parse_args(argv)

    # 先登记的优先于默认的 HERE
    for _root in reversed([r for r in args.image_root if r]):
        if os.path.isdir(_root):
            register_image_root(os.path.abspath(_root))

    spec_path = args.spec if os.path.isabs(args.spec) else os.path.join(HERE, args.spec)
    if not os.path.isfile(spec_path):
        sys.stderr.write("spec 不存在: %s\n" % spec_path)
        return 2

    # utf-8-sig：容忍 BOM（LLM 或 Windows 工具写出的 JSON 常带 BOM）
    with open(spec_path, "r", encoding="utf-8-sig") as fh:
        raw = json.load(fh)

    overrides = json.loads(args.overrides) if args.overrides else None

    try:
        spec = build_spec(raw, overrides)
        img = render(spec)
    except RenderError as exc:
        sys.stderr.write("渲染失败: %s\n" % exc)
        return 1

    out = args.out
    if not out:
        out = os.path.join(HERE, "out", os.path.splitext(os.path.basename(spec_path))[0] + ".png")
    out = out if os.path.isabs(out) else os.path.join(HERE, out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out, "PNG")

    # 附带落一份最终 spec —— 物料可追溯：这张图是用哪份 spec 渲的
    with open(os.path.splitext(out)[0] + ".spec.json", "w", encoding="utf-8") as fh:
        json.dump(spec, fh, ensure_ascii=False, indent=2)

    print("已渲染: %s  (%dx%d)" % (out, img.width, img.height))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
