#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
copybook.py —— 多页 PDF 文案手册渲染器

存在的理由：海报是"一张图"，文案手册是"一份文档"。
两者共用同一套设计语言（色板、字体、版式节奏），但文档多了三个海报没有的东西：
  1. 阅读节奏（封面 → 导语 → 卖点 → 详情 → 价格 → 联系方式）
  2. 分页与页码
  3. 跨页统一的页眉页脚

设计原则与海报一致：
  · 文字永远走引擎渲染，AI 只负责图像层
  · 纯函数：同样的 JSON 永远得到同样的 PDF
  · 色值走调色板变量，换主题只改一处

依赖：Pillow（本项目已有，自带 PDF 多页输出，不需要 reportlab）

用法：
    python copybook.py --spec specs/copybook-x.json --out out/x.pdf
    python copybook.py --spec specs/copybook-x.json --out out/x.pdf --png-dir out/x-pages
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

from PIL import Image, ImageDraw

# 复用海报引擎的调色板与背景能力 —— 单一实现来源，避免两处漂移
#
# v8.0 合并项目时 `poster-forge/` 改名成了 `renderer/`。
# 这里**两个名字都认**，并支持 PF_FORGE_ROOT 显式指定 ——
# 写死目录名的话，改名之后手册会静默地找不到引擎
# （实测：合并后 /api/health 报 渲染器=False）。
_HERE = os.path.dirname(os.path.abspath(__file__))
_FORGE = None
for _cand in (os.environ.get("PF_FORGE_ROOT"),
              os.path.join(_HERE, "..", "renderer"),
              os.path.join(_HERE, "..", "poster-forge")):
    if _cand and os.path.isfile(os.path.join(_cand, "render.py")):
        _FORGE = os.path.abspath(_cand)
        break
if _FORGE and _FORGE not in sys.path:
    sys.path.insert(0, _FORGE)

from bg import make_background, resolve_color, BGError  # noqa: E402

# 字体表与海报引擎保持一致
FONT_FILES = {
    "bold": r"C:\Windows\Fonts\msyhbd.ttc",
    "sans": r"C:\Windows\Fonts\msyh.ttc",
    "light": r"C:\Windows\Fonts\msyhl.ttc",
    "heavy": r"C:\Windows\Fonts\simhei.ttf",
    "song": r"C:\Windows\Fonts\simsun.ttc",
    "kai": r"C:\Windows\Fonts\simkai.ttf",
    "deng": r"C:\Windows\Fonts\Deng.ttf",
    "dengb": r"C:\Windows\Fonts\Dengb.ttf",
    "zhong": r"C:\Windows\Fonts\STZHONGS.TTF",
}

_font_cache: Dict[Tuple[str, int], Any] = {}


class CopybookError(Exception):
    """手册 spec 不合法。"""


def load_font(name: str, size: int):
    key = (name, size)
    if key in _font_cache:
        return _font_cache[key]
    from PIL import ImageFont

    path = FONT_FILES.get(name) or FONT_FILES["sans"]
    if not os.path.isfile(path):
        for cand in FONT_FILES.values():
            if os.path.isfile(cand):
                path = cand
                break
    if not os.path.isfile(path):
        raise CopybookError("找不到可用字体，请检查 FONT_FILES 表")
    f = ImageFont.truetype(path, size)
    _font_cache[key] = f
    return f


def measure(text: str, font) -> Tuple[int, int]:
    if not text:
        return (0, font.size)
    b = font.getbbox(text)
    return (b[2] - b[0], b[3] - b[1])


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return (
        0x2E80 <= o <= 0x9FFF
        or 0xF900 <= o <= 0xFAFF
        or 0xFF00 <= o <= 0xFFEF
        or 0x3000 <= o <= 0x303F
    )


def wrap(text: str, font, max_w: int) -> List[str]:
    """按像素宽度折行；CJK 逐字可断，拉丁按词。"""
    out: List[str] = []
    for hard in str(text).split("\n"):
        tokens: List[str] = []
        buf = ""
        for ch in hard:
            if _is_cjk(ch) or ch.isspace():
                if buf:
                    tokens.append(buf)
                    buf = ""
                tokens.append(ch)
            else:
                buf += ch
        if buf:
            tokens.append(buf)

        cur = ""
        for t in tokens:
            if measure(cur + t, font)[0] <= max_w or not cur:
                cur += t
            else:
                out.append(cur.rstrip())
                cur = "" if t.isspace() else t
        out.append(cur.rstrip())
    return out


# ==================================================================== 渲染器
class Copybook:
    """A4 竖版文档渲染器。所有几何以 300 DPI 像素计算。"""

    DPI = 300
    W = int(8.27 * DPI)   # 2481
    H = int(11.69 * DPI)  # 3507
    M = int(0.86 * DPI)   # 页边距 ~0.86 英寸

    def __init__(self, spec: Dict[str, Any]) -> None:
        self.spec = spec
        self.theme = spec.get("theme") or {}
        self.palette: Dict[str, str] = self.theme.get("palette") or {}
        self.meta = spec.get("meta") or {}
        if not self.palette:
            raise CopybookError("theme.palette 不能为空 —— 手册需要色板才能渲染")

        self.pages: List[Image.Image] = []
        self.base_dir = _HERE

    # ---------------------------------------------------------- 工具
    def color(self, v: Any, default: Optional[str] = None):
        try:
            return resolve_color(v, self.palette)
        except BGError:
            if default is not None:
                return resolve_color(default, self.palette)
            raise

    def text_h(self, font, line_h: float = 1.5) -> int:
        return int(round(font.size * line_h))

    def draw_para(
        self,
        dr: ImageDraw.ImageDraw,
        xy: Tuple[int, int],
        text: str,
        font,
        color,
        max_w: int,
        line_h: float = 1.62,
        align: str = "left",
    ) -> int:
        """画一段折行文本，返回消耗的高度。"""
        x, y = xy
        lh = self.text_h(font, line_h)
        for line in wrap(text, font, max_w):
            lw, _ = measure(line, font)
            lx = x if align == "left" else (x + (max_w - lw) // 2 if align == "center" else x + max_w - lw)
            off = -font.getbbox(line)[1] if line else 0
            dr.text((lx, y + off), line, font=font, fill=color)
            y += lh
        return y - xy[1]

    # ---------------------------------------------------------- 页面骨架
    def new_page(self, bg_kind: str = "content") -> Image.Image:
        """
        新建一页。

        性能要点：同一文档里所有浅色页的底色完全相同。而生成一张 A4@300DPI 的
        渐变背景要做大尺寸 rotate + 高斯模糊，单页就要数秒 —— 6 页文档里 3 页是
        浅色页，逐页重建等于白算两遍。所以按类型缓存基底，命中直接 copy()
        （copy 比重新生成便宜两个数量级）。

          cover   —— 满幅渐变封面
          content —— 浅色内容页（阅读舒适）
          accent  —— 深色强调页（数据/价格）
        """
        cache = getattr(self, "_bg_cache", None)
        if cache is None:
            cache = self._bg_cache = {}

        if bg_kind in cache:
            return cache[bg_kind].copy()

        if bg_kind == "cover":
            bg = {
                "type": "gradient",
                "from": "bgFrom",
                "to": "bgTo",
                "angle": 145,
                "blobs": [
                    {"x": 0.22, "y": 0.16, "r": 0.42, "color": "#ffffff18", "blur": 0.16},
                    {"x": 0.86, "y": 0.82, "r": 0.38, "color": "#00000033", "blur": 0.20},
                ],
            }
        elif bg_kind == "accent":
            bg = {
                "type": "gradient",
                "from": "panel",
                "to": "bgFrom",
                "angle": 130,
                "blobs": [{"x": 0.80, "y": 0.20, "r": 0.40, "color": "#ffffff14", "blur": 0.18}],
            }
        else:
            bg = {"type": "solid", "color": "paper"}

        img = make_background(bg, (self.W, self.H), self.palette, self.base_dir)
        cache[bg_kind] = img
        return img.copy()

    def add_running_heads(self, img: Image.Image, page_no: int, total: int, dark: bool) -> None:
        """页眉页脚 + 页码。dark=True 表示深色底（用浅字）。"""
        dr = ImageDraw.Draw(img)
        ink = self.color("ink" if dark else "inkOnPaper")
        mute = self.color("inkMute" if dark else "inkMuteOnPaper")
        f_small = load_font("sans", int(0.095 * self.DPI))
        f_tiny = load_font("sans", int(0.082 * self.DPI))

        # 页眉左：客户名；右：文档名
        # 注意页眉页脚都要落在内容边距之内，贴到纸边会显得像排版事故。
        client = str(self.meta.get("client", ""))
        title = str(self.meta.get("title", ""))
        y_head = int(self.M * 0.60)
        if client:
            dr.text((self.M, y_head), client, font=f_small, fill=mute)
        if title:
            tw, _ = measure(title, f_small)
            dr.text((self.W - self.M - tw, y_head), title, font=f_small, fill=mute)

        # 页眉下的细线
        rule_y = y_head + self.text_h(f_small, 1.55)
        dr.line([(self.M, rule_y), (self.W - self.M, rule_y)],
                fill=self.color("divider" if dark else "dividerOnPaper", "#ffffff2e"),
                width=max(1, self.DPI // 240))

        # 页脚：左 生成方，右 页码
        f_tiny = load_font("sans", int(0.080 * self.DPI))
        y_foot = self.H - int(self.M * 0.78)
        note = str(self.meta.get("footer", "由 PosterForge 生成"))
        dr.text((self.M, y_foot), note, font=f_tiny, fill=mute)
        pn = "%d / %d" % (page_no, total)
        pw, _ = measure(pn, f_tiny)
        dr.text((self.W - self.M - pw, y_foot), pn, font=f_tiny, fill=mute)

    # ---------------------------------------------------------- 各版块
    def sec_cover(self, s: Dict[str, Any]) -> Image.Image:
        img = self.new_page("cover")
        dr = ImageDraw.Draw(img)
        x = self.M
        y = int(self.H * 0.22)
        max_w = self.W - 2 * self.M

        if s.get("eyebrow"):
            f = load_font("sans", int(0.115 * self.DPI))
            dr.text((x, y), str(s["eyebrow"]), font=f, fill=self.color("gold", "#e8c37a"))
            y += self.text_h(f, 2.4)

        f_t = load_font("heavy", int(0.30 * self.DPI))
        for line in wrap(str(s.get("title", "")), f_t, max_w):
            dr.text((x, y), line, font=f_t, fill=self.color("ink", "#ffffff"))
            y += self.text_h(f_t, 1.22)
        y += int(0.03 * self.DPI)

        # 装饰短线
        dr.line([(x, y), (x + int(0.62 * self.DPI), y)], fill=self.color("gold", "#e8c37a"),
                width=max(2, self.DPI // 110))
        y += int(0.14 * self.DPI)

        if s.get("subtitle"):
            f_s = load_font("sans", int(0.135 * self.DPI))
            for line in wrap(str(s["subtitle"]), f_s, max_w):
                dr.text((x, y), line, font=f_s, fill=self.color("inkSoft", "#d6ecec"))
                y += self.text_h(f_s, 1.72)

        # 底部装饰短线，给封面下半页一个视觉落点
        # （纯留白在深色底上会显得"内容没写完"）
        ry = int(self.H * 0.615)
        dr.line([(x, ry), (x + int(1.05 * self.DPI), ry)],
                fill=self.color("gold", "#e8c37a"), width=max(1, self.DPI // 300))

        # 底部信息条
        if s.get("footer"):
            f_f = load_font("bold", int(0.10 * self.DPI))
            fy = self.H - self.M - self.text_h(f_f, 1.6)
            dr.text((x, fy), str(s["footer"]), font=f_f, fill=self.color("gold", "#e8c37a"))

        self.pages.append(img)
        return img

    def sec_text(self, s: Dict[str, Any]) -> Image.Image:
        img = self.new_page("content")
        dr = ImageDraw.Draw(img)
        y = self._content_top(dr, s)
        max_w = self.W - 2 * self.M

        f_b = load_font("sans", int(0.108 * self.DPI))
        for para in s.get("body", []):
            y += self.draw_para(dr, (self.M, y), str(para), f_b,
                                self.color("inkOnPaper", "#1e1a17"), max_w, line_h=1.78)
            y += int(0.055 * self.DPI)
        self.pages.append(img)
        return img

    def sec_bullets(self, s: Dict[str, Any]) -> Image.Image:
        img = self.new_page("content")
        dr = ImageDraw.Draw(img)
        y = self._content_top(dr, s)
        max_w = self.W - 2 * self.M
        f_i = load_font("bold", int(0.112 * self.DPI))
        f_b = load_font("sans", int(0.100 * self.DPI))
        accent = self.color("accentOnPaper", self.palette.get("gold", "#b98b3f"))

        for it in s.get("items", []):
            if isinstance(it, str):
                head, body = it, ""
            else:
                head, body = str(it.get("head", "")), str(it.get("body", ""))
            # 左侧强调块
            dr.rounded_rectangle(
                [self.M, y + int(0.012 * self.DPI), self.M + int(0.035 * self.DPI), y + int(0.10 * self.DPI)],
                radius=int(0.014 * self.DPI), fill=accent,
            )
            tx = self.M + int(0.085 * self.DPI)
            dr.text((tx, y), head, font=f_i, fill=self.color("inkOnPaper", "#1e1a17"))
            y += self.text_h(f_i, 1.5)
            if body:
                y += self.draw_para(dr, (tx, y), body, f_b,
                                    self.color("inkMuteOnPaper", "#57504a"),
                                    max_w - int(0.085 * self.DPI), line_h=1.72)
            y += int(0.055 * self.DPI)
        self.pages.append(img)
        return img

    def sec_table(self, s: Dict[str, Any]) -> Image.Image:
        img = self.new_page("content")
        dr = ImageDraw.Draw(img)
        y = self._content_top(dr, s)
        max_w = self.W - 2 * self.M
        cols = s.get("columns", [])
        rows = s.get("rows", [])
        if not cols:
            raise CopybookError("table 版块缺少 columns")
        cw = max_w // len(cols)

        f_h = load_font("bold", int(0.096 * self.DPI))
        f_c = load_font("sans", int(0.094 * self.DPI))
        rh = int(0.30 * self.DPI)

        # 表头
        dr.rounded_rectangle([self.M, y, self.W - self.M, y + int(0.24 * self.DPI)],
                             radius=int(0.02 * self.DPI),
                             fill=self.color("accentOnPaper", self.palette.get("gold", "#b98b3f")))
        for i, c in enumerate(cols):
            dr.text((self.M + i * cw + int(0.05 * self.DPI), y + int(0.055 * self.DPI)),
                    str(c), font=f_h, fill=self.color("ink", "#ffffff"))
        y += int(0.30 * self.DPI)

        # 数据行（隔行浅底，便于横向阅读）
        for ri, row in enumerate(rows):
            if ri % 2 == 1:
                dr.rectangle([self.M, y, self.W - self.M, y + rh], fill=self.color("zebra", "#00000010"))
            for ci, cell in enumerate(row[: len(cols)]):
                dr.text((self.M + ci * cw + int(0.05 * self.DPI), y + int(0.055 * self.DPI)),
                        str(cell), font=f_c, fill=self.color("inkOnPaper", "#1e1a17"))
            y += rh

        # 表格底线
        dr.line([(self.M, y), (self.W - self.M, y)], fill=self.color("dividerOnPaper", "#00000022"),
                width=max(1, self.DPI // 200))
        self.pages.append(img)
        return img

    def sec_price(self, s: Dict[str, Any]) -> Image.Image:
        img = self.new_page("accent")
        dr = ImageDraw.Draw(img)
        y = self._content_top(dr, s, dark=True)
        max_w = self.W - 2 * self.M

        f_n = load_font("sans", int(0.105 * self.DPI))
        f_p = load_font("heavy", int(0.34 * self.DPI))
        f_u = load_font("sans", int(0.095 * self.DPI))

        dr.text((self.M, y), str(s.get("note", "价格")), font=f_n, fill=self.color("inkMute", "#9fc4c6"))
        y += self.text_h(f_n, 1.9)

        price = str(s.get("price", ""))
        dr.text((self.M, y), price, font=f_p, fill=self.color("gold", "#e8c37a"))
        pw, _ = measure(price, f_p)
        if s.get("unit"):
            dr.text((self.M + pw + int(0.08 * self.DPI), y + int(0.16 * self.DPI)),
                    str(s["unit"]), font=f_u, fill=self.color("inkMute", "#9fc4c6"))
        y += self.text_h(f_p, 1.3)

        if s.get("includes"):
            dr.text((self.M, y), "包含：", font=f_n, fill=self.color("inkSoft", "#d6ecec"))
            y += self.text_h(f_n, 1.7)
            f_b = load_font("sans", int(0.100 * self.DPI))
            for it in s["includes"]:
                y += self.draw_para(dr, (self.M + int(0.05 * self.DPI), y), "· " + str(it), f_b,
                                    self.color("inkSoft", "#d6ecec"), max_w - int(0.05 * self.DPI), line_h=1.7)
        self.pages.append(img)
        return img

    def sec_image(self, s: Dict[str, Any]) -> Image.Image:
        """整页图片版块：一张实拍图 + 可选标题与说明。

        为什么手册需要这一种：原先 VALID_SECTIONS 里只有
        cover/text/bullets/table/price/contact —— **没有任何位置能放图**。
        用户在手册模式里传了照片，照片却无处可去，只留下一条
        "这张图会作为海报底图"的提示在骗人。

        src 允许三种写法（依次回退）：
          · 绝对路径
          · 相对站点根（public/ 的上一级）
          · 相对 public/（形如 /uploads/xxx.jpg）
        """
        img = self.new_page("content")
        dr = ImageDraw.Draw(img)
        y = self._content_top(dr, s)
        max_w = self.W - 2 * self.M

        if s.get("heading"):
            f_h = load_font("heavy", int(0.155 * self.DPI))
            dr.text((self.M, y), str(s["heading"]), font=f_h, fill=self.color("ink", "#1e1a17"))
            y += self.text_h(f_h, 1.55)

        src = str(s.get("src", ""))
        cap_h = int(0.16 * self.DPI) if s.get("caption") else 0
        box_h = self.H - y - self.M - cap_h
        box_w = max_w

        photo = None
        for cand in self._image_candidates(src):
            if os.path.isfile(cand):
                try:
                    photo = Image.open(cand).convert("RGB")
                    break
                except Exception:
                    photo = None
        if photo is not None and box_h > 0:
            # cover 铺满：等比放大到盖住框，再居中裁切（不留白边）
            ratio = max(box_w / photo.width, box_h / photo.height)
            nw, nh = max(1, int(photo.width * ratio)), max(1, int(photo.height * ratio))
            photo = photo.resize((nw, nh), Image.LANCZOS)
            left = (nw - box_w) // 2
            top = (nh - box_h) // 2
            img.paste(photo.crop((left, top, left + box_w, top + box_h)), (self.M, y))
            dr.rectangle([self.M, y, self.M + box_w, y + box_h], outline=self.color("dividerOnPaper", "#00000022"), width=2)
            y += box_h
        else:
            # 图缺失时不留白洞 —— 画一个占位框并说明，比空白页诚实
            dr.rectangle([self.M, y, self.M + box_w, y + max(1, box_h)],
                         outline=self.color("dividerOnPaper", "#00000022"), width=2)
            f_e = load_font("sans", int(0.095 * self.DPI))
            dr.text((self.M + int(0.06 * self.DPI), y + int(0.06 * self.DPI)),
                    "（图片未能载入：%s）" % (src or "未提供路径"),
                    font=f_e, fill=self.color("inkMuteOnPaper", "#57504a"))
            y += max(1, box_h)

        if s.get("caption"):
            f_c = load_font("sans", int(0.092 * self.DPI))
            y += int(0.035 * self.DPI)
            self.draw_para(dr, (self.M, y), str(s["caption"]), f_c,
                           self.color("inkMuteOnPaper", "#57504a"), max_w, line_h=1.6)

        self.pages.append(img)
        return img

    def _image_candidates(self, src: str) -> List[str]:
        """把 spec 里的图片路径解析成若干候选绝对路径。"""
        if not src:
            return []
        if os.path.isabs(src):
            return [src]
        here = os.path.dirname(os.path.abspath(__file__))       # site/
        rel = src.lstrip("/\\")
        return [
            os.path.join(here, rel),
            os.path.join(here, "public", rel),
            os.path.join(os.path.dirname(here), rel),
        ]

    def sec_contact(self, s: Dict[str, Any]) -> Image.Image:
        img = self.new_page("accent")
        dr = ImageDraw.Draw(img)
        y = self._content_top(dr, s, dark=True)
        max_w = self.W - 2 * self.M

        f_t = load_font("bold", int(0.145 * self.DPI))
        dr.text((self.M, y), str(s.get("title", "联系方式")), font=f_t, fill=self.color("gold", "#e8c37a"))
        y += self.text_h(f_t, 1.8)

        f_k = load_font("sans", int(0.098 * self.DPI))
        f_v = load_font("bold", int(0.112 * self.DPI))
        for item in s.get("items", []):
            k, v = str(item.get("k", "")), str(item.get("v", ""))
            dr.text((self.M, y), k, font=f_k, fill=self.color("inkMute", "#9fc4c6"))
            dr.text((self.M + int(0.95 * self.DPI), y), v, font=f_v, fill=self.color("ink", "#ffffff"))
            y += self.text_h(f_v, 1.86)

        if s.get("qr_note"):
            y += int(0.06 * self.DPI)
            y += self.draw_para(dr, (self.M, y), str(s["qr_note"]), f_k,
                                self.color("inkMute", "#9fc4c6"), max_w, line_h=1.7)
        self.pages.append(img)
        return img

    def _content_top(self, dr: ImageDraw.ImageDraw, s: Dict[str, Any], dark: bool = False) -> int:
        """画版块标题，返回正文起始 y。"""
        y = int(self.M * 1.16)
        if s.get("heading"):
            f = load_font("heavy", int(0.155 * self.DPI))
            dr.text((self.M, y), str(s["heading"]), font=f,
                    fill=self.color("ink" if dark else "inkOnPaper", "#ffffff" if dark else "#1e1a17"))
            y += self.text_h(f, 1.42)
            dr.line([(self.M, y), (self.M + int(0.70 * self.DPI), y)],
                    fill=self.color("gold", "#e8c37a"), width=max(2, self.DPI // 120))
            y += int(0.13 * self.DPI)
        if s.get("lead"):
            f = load_font("sans", int(0.104 * self.DPI))
            y += self.draw_para(dr, (self.M, y), str(s["lead"]), f,
                                self.color("inkSoft" if dark else "inkMuteOnPaper", "#d6ecec" if dark else "#57504a"),
                                self.W - 2 * self.M, line_h=1.74)
            y += int(0.06 * self.DPI)
        return y

    # ---------------------------------------------------------- 主流程
    def render(self) -> List[Image.Image]:
        sections = self.spec.get("sections")
        if not isinstance(sections, list) or not sections:
            raise CopybookError("sections 不能为空")

        # 第一遍：占位收集（页码需要总数，所以先渲染再补页眉页脚）
        handlers = {
            "cover": self.sec_cover,
            "text": self.sec_text,
            "bullets": self.sec_bullets,
            "table": self.sec_table,
            "price": self.sec_price,
            "contact": self.sec_contact,
            "image": self.sec_image,
        }
        for i, s in enumerate(sections):
            kind = s.get("type", "text")
            h = handlers.get(kind)
            if h is None:
                raise CopybookError("未知版块类型 %r（第 %d 个），可选 %s"
                                    % (kind, i + 1, "/".join(sorted(handlers))))
            h(s)

        total = len(self.pages)
        for i, img in enumerate(self.pages):
            sec = sections[i]
            dark = sec.get("type") in ("cover", "price", "contact")
            self.add_running_heads(img, i + 1, total, dark)
        return self.pages


# ==================================================================== CLI
def render_copybook(spec: Dict[str, Any]) -> List[Image.Image]:
    return Copybook(spec).render()


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="copybook：多页 PDF 文案手册渲染器")
    ap.add_argument("--spec", required=True, help="手册 spec JSON")
    ap.add_argument("--out", help="输出 PDF 路径")
    ap.add_argument("--png-dir", help="同时导出每页 PNG 到该目录")
    args = ap.parse_args(argv)

    path = args.spec if os.path.isabs(args.spec) else os.path.join(_HERE, args.spec)
    if not os.path.isfile(path):
        sys.stderr.write("spec 不存在: %s\n" % path)
        return 2
    with open(path, "r", encoding="utf-8-sig") as fh:
        spec = json.load(fh)

    try:
        pages = render_copybook(spec)
    except (CopybookError, BGError) as exc:
        sys.stderr.write("渲染失败: %s\n" % exc)
        return 1

    out = args.out or os.path.join(_HERE, "out", os.path.splitext(os.path.basename(path))[0] + ".pdf")
    out = out if os.path.isabs(out) else os.path.join(_HERE, out)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    first, rest = pages[0], pages[1:]
    first.save(out, "PDF", resolution=float(Copybook.DPI), save_all=True, append_images=rest)

    if args.png_dir:
        d = args.png_dir if os.path.isabs(args.png_dir) else os.path.join(_HERE, args.png_dir)
        os.makedirs(d, exist_ok=True)
        for i, p in enumerate(pages, 1):
            p.save(os.path.join(d, "page-%02d.png" % i), "PNG", optimize=True)

    print("已渲染: %s  (%d 页, %dx%d px/页 @ %d DPI)"
          % (out, len(pages), Copybook.W, Copybook.H, Copybook.DPI))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
