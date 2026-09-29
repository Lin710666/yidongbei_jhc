#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
poster-forge / validate.py —— spec 静态校验器

为什么需要它：spec 由 LLM 产出，模型一定会犯三类错，而这三类错**不需要渲染就能查**：

  1. 结构错 —— 字段名写错、类型不对、缺必填项。渲染时才报错，浪费一次调用。
  2. 令牌错 —— 用了调色板里不存在的颜色名。表现是"静默取默认色"，
     出一张配色错误但看起来正常的图，最难查。
  3. 合规错 —— 广告法禁用词、编造的价格/电话、缺联系方式。
     这是 B2B 物料，出错是业务事故，不是渲染瑕疵。

用法：
    python validate.py --spec specs/hotel-autumn.json
    python validate.py --spec spec.json --strict     # 有 warning 也判失败

退出码：0 通过 / 1 有 error / 2 文件问题
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- 规则表
# 广告法禁用/高风险词（《广告法》第九条等）。命中即 error —— 这类词在
# 文旅/酒店/餐饮物料里出现，是会被投诉和处罚的，不是风格问题。
AD_LAW_BANNED = [
    "国家级", "世界级", "最高级", "最佳", "最好", "最优", "最强", "最便宜", "最低价",
    "第一品牌", "全国第一", "全市第一", "销量第一", "排名第一",
    "绝无仅有", "独一无二", "百分百", "100%", "永久", "根治", "特效",
    "国家免检", "免检产品", "央视上榜",
]

# 需要资质才能用的表述：出现即 warning，提示人工确认资质
AD_LAW_NEEDS_PROOF = ["特级", "极品", "首家", "独家", "领先", "权威", "驰名商标", "老字号"]

# 事实类字段：模型不得凭空生成，必须能回溯到 meta.facts_source
# 电话要容忍分隔符（138-0000-1234 / 138 0000 1234 / 13800001234 都是合法写法）。
# 用显式分组而不是量词：`1[3-9][\d\-\s]{9,12}\d` 这类写法会因回溯吃掉尾号，
# 实测把 "13800001234" 变成匹配失败。显式写清段数才不会退化。
_MOBILE = r"(?:1[3-9]\d{9}|1[3-9]\d[\-\s]?\d{4}[\-\s]?\d{4})"
# 座机两种写法都要认：
#   0592-88886666   区号 + 8 位连写（标准）
#   0592-8888-6666  区号 + 4 + 4（物料里常见的虚构格式）
# 必须显式分支。用 `\d{7,8}(?:[\-\s]?\d{4})?` 是错的 ——
# 连写形式会被前一个量词吃掉，导致 4+4 永远匹配不上。
_LANDLINE = r"(?:0\d{2,3}[\-\s]?\d{7,8}|0\d{2,3}[\-\s]?\d{3,4}[\-\s]?\d{4})"
_SERVICE = r"(?:400[\-\s]?\d{3}[\-\s]?\d{4})"
PHONE_RE = re.compile(r"%s|%s|%s" % (_MOBILE, _LANDLINE, _SERVICE))
FACT_TOKEN = re.compile(r"(?:(?:¥|￥|\$)\s?\d[\d,]*|%s|%s|%s)" % (_MOBILE, _LANDLINE, _SERVICE))


def normalize_phone(raw: str) -> str:
    """去掉分隔符，便于比较"是不是同一个号码"。"""
    return re.sub(r"[\s\-]", "", raw)

VALID_FONTS = {"bold", "sans", "light", "heavy", "song", "kai", "deng", "dengb", "zhong"}
VALID_ELEMENT_TYPES = {"shape", "text", "image", "qr", "group"}
VALID_SHAPES = {"rect", "circle", "line"}
COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


class Report:
    """收集 error / warning，最后统一输出。"""

    def __init__(self) -> None:
        self.errors: List[str] = []
        self.warnings: List[str] = []

    def error(self, where: str, msg: str) -> None:
        self.errors.append("%s: %s" % (where, msg))

    def warn(self, where: str, msg: str) -> None:
        self.warnings.append("%s: %s" % (where, msg))

    def ok(self) -> bool:
        return not self.errors

    def dump(self) -> None:
        for e in self.errors:
            print("  [ERROR] %s" % e)
        for w in self.warnings:
            print("  [WARN ] %s" % w)
        if not self.errors and not self.warnings:
            print("  全部通过")


# ---------------------------------------------------------------- 校验
def walk_elements(layers: Any, path: str = "layers") -> List[Tuple[str, dict]]:
    """展开 group，返回 (路径, 元素) 列表。"""
    out: List[Tuple[str, dict]] = []
    if not isinstance(layers, list):
        return out
    for i, el in enumerate(layers):
        if not isinstance(el, dict):
            out.append(("%s[%d]" % (path, i), {"_notdict": el}))
            continue
        name = el.get("name") or "%s[%d]" % (path, i)
        out.append((name, el))
        if el.get("type") == "group":
            out.extend(walk_elements(el.get("layers"), "%s/%s" % (path, name)))
    return out


def check_palette(spec: dict, rep: Report) -> None:
    palette = ((spec.get("theme") or {}).get("palette")) or {}
    if not isinstance(palette, dict):
        rep.error("theme.palette", "必须是对象")
        return
    for k, v in palette.items():
        if not isinstance(v, str) or not COLOR_RE.match(v):
            rep.error("theme.palette.%s" % k, "值必须是 #RGB/#RRGGBB/#RRGGBBAA，收到 %r" % (v,))


def resolve_token(value: Any, palette: Dict[str, str]) -> Optional[Tuple[str, bool]]:
    """
    返回 (解析后的色值, 是否有效)。支持调色板名与字面量。
    """
    if value is None:
        return None
    if not isinstance(value, str):
        return ("<非字符串>", False)
    key = value.strip()
    seen = set()
    while key in palette:
        if key in seen:
            return ("<循环引用>", False)
        seen.add(key)
        key = palette[key]
    if COLOR_RE.match(key):
        return (key, True)
    return (value, False)


def check_colors(spec: dict, rep: Report) -> None:
    palette = ((spec.get("theme") or {}).get("palette")) or {}
    bg = spec.get("background") or {}
    color_fields = {
        "from": "background.from",
        "to": "background.to",
        "color": "background.color",
    }
    for key, label in color_fields.items():
        if key in bg:
            _, valid = resolve_token(bg[key], palette) or ("", True)
            if not valid:
                rep.error(label, "颜色令牌无法解析: %r（不在调色板中）" % (bg[key],))
    for blob_i, blob in enumerate(bg.get("blobs") or []):
        if isinstance(blob, dict) and "color" in blob:
            _, valid = resolve_token(blob["color"], palette) or ("", True)
            if not valid:
                rep.error("background.blobs[%d].color" % blob_i, "颜色令牌无法解析: %r" % (blob["color"],))

    for name, el in walk_elements(spec.get("layers")):
        for f in ("color", "fill", "stroke", "bg", "fg"):
            if f in el and el[f] is not None:
                _, valid = resolve_token(el[f], palette) or ("", True)
                if not valid:
                    rep.error("%s.%s" % (name, f), "颜色令牌无法解析: %r（不在调色板中）" % (el[f],))
        sh = el.get("shadow")
        if isinstance(sh, dict) and "color" in sh:
            _, valid = resolve_token(sh["color"], palette) or ("", True)
            if not valid:
                rep.error("%s.shadow.color" % name, "颜色令牌无法解析: %r" % (sh["color"],))
        st = el.get("stroke")
        if isinstance(st, dict) and "color" in st:
            _, valid = resolve_token(st["color"], palette) or ("", True)
            if not valid:
                rep.error("%s.stroke.color" % name, "颜色令牌无法解析: %r" % (st["color"],))


def check_structure(spec: dict, rep: Report) -> None:
    canvas = spec.get("canvas")
    if not isinstance(canvas, dict):
        rep.error("canvas", "缺失或不是对象")
        return
    for k in ("width", "height"):
        v = canvas.get(k)
        if not isinstance(v, int) or not (64 <= v <= 20000):
            rep.error("canvas.%s" % k, "必须是 64..20000 的整数，收到 %r" % (v,))

    if not isinstance(spec.get("layers"), list) or not spec["layers"]:
        rep.error("layers", "必须是非空数组")

    for name, el in walk_elements(spec.get("layers")):
        if "_notdict" in el:
            rep.error(name, "图层必须是对象，收到 %r" % (el["_notdict"],))
            continue
        t = el.get("type")
        if t not in VALID_ELEMENT_TYPES:
            rep.error(name, "未知 type=%r（可选 %s）" % (t, "/".join(sorted(VALID_ELEMENT_TYPES))))
            continue
        if t == "group":
            continue
        if t == "text":
            if not str(el.get("text", "")).strip():
                rep.error(name, "text 为空")
            if "font" in el and el["font"] not in VALID_FONTS:
                rep.error(name, "未知 font=%r（可选 %s）" % (el["font"], "/".join(sorted(VALID_FONTS))))
        if t in ("shape", "image", "qr") and "box" not in el:
            rep.error(name, "缺少 box")
        if t == "shape" and el.get("shape", "rect") not in VALID_SHAPES:
            rep.error(name, "未知 shape=%r" % (el.get("shape"),))
        if t == "image" and not el.get("src"):
            rep.error(name, "缺少 src")
        if t == "qr" and not el.get("data"):
            rep.error(name, "缺少 data")
        box = el.get("box")
        if isinstance(box, list) and len(box) not in (2, 4):
            rep.error(name, "box 数组必须是 2 或 4 个元素，收到 %d 个" % len(box))
        if isinstance(box, dict):
            if "box" not in box or "size" not in box:
                rep.error(name, 'box 对象必须是 {"box":[x,y], "size":[w,h]}')


def check_compliance(spec: dict, rep: Report) -> None:
    """广告法与事实性检查。这是 B2B 物料最关键的一关。"""
    meta = spec.get("meta") or {}
    has_source = bool(meta.get("facts_source"))
    if not has_source:
        rep.warn("meta.facts_source", "未标注事实来源；价格/电话/地址等事实字段应可回溯")

    # 收集全部文本
    texts: List[Tuple[str, str]] = []
    for name, el in walk_elements(spec.get("layers")):
        if el.get("type") == "text" and el.get("text"):
            texts.append((name, str(el["text"])))
    for k in ("name", "description"):
        if meta.get(k):
            texts.append(("meta.%s" % k, str(meta[k])))

    for name, txt in texts:
        for w in AD_LAW_BANNED:
            if w in txt:
                rep.error("%s" % name, "命中广告法禁用/高风险词 %r —— 必须改写（文本: %s）" % (w, txt[:40]))
        for w in AD_LAW_NEEDS_PROOF:
            if w in txt:
                rep.warn("%s" % name, "含需资质表述 %r，请人工确认资质后再发布" % (w,))

    # 事实字段必须能回溯
    has_fact = any(FACT_TOKEN.search(t) for _, t in texts)
    if has_fact and not has_source:
        rep.error("meta.facts_source", "物料含价格/电话等事实字段，但未提供事实来源")


def check_references(spec: dict, rep: Report) -> None:
    """图片路径是否存在 —— 渲染时才报错太晚。

    走 render.resolve_image_path 解析，这样站点注册的额外搜索根
    （如 public/uploads）也能被识别，避免"上传成功却校验不通过"。
    """
    try:
        from render import resolve_image_path  # type: ignore
    except ImportError:
        resolve_image_path = None  # type: ignore

    for name, el in walk_elements(spec.get("layers")):
        if el.get("type") != "image":
            continue
        src = el.get("src")
        if not src:
            continue
        if resolve_image_path is not None:
            full = resolve_image_path(src)
        else:
            full = src if os.path.isabs(src) else os.path.join(HERE, src)
        if not os.path.isfile(full):
            rep.error(name, "图片不存在: %s" % full)


def validate(spec: dict) -> Report:
    rep = Report()
    check_structure(spec, rep)
    check_palette(spec, rep)
    check_colors(spec, rep)
    check_references(spec, rep)
    check_compliance(spec, rep)
    return rep


# ---------------------------------------------------------------- CLI
def main(argv: Optional[Sequence[str]] = None) -> int:
    try:
        from render import build_spec  # 复用同一套 layout 解析，保证校验的是最终 spec
    except ImportError:
        build_spec = None  # type: ignore

    ap = argparse.ArgumentParser(description="poster-forge spec 校验器")
    ap.add_argument("--spec", required=True)
    ap.add_argument("--strict", action="store_true", help="有 warning 也判失败")
    ap.add_argument("--raw", action="store_true", help="不解析 layout，直接校验原始 spec")
    args = ap.parse_args(argv)

    path = args.spec if os.path.isabs(args.spec) else os.path.join(HERE, args.spec)
    if not os.path.isfile(path):
        sys.stderr.write("spec 不存在: %s\n" % path)
        return 2
    with open(path, "r", encoding="utf-8-sig") as fh:
        try:
            spec = json.load(fh)
        except json.JSONDecodeError as exc:
            sys.stderr.write("spec 不是合法 JSON: %s\n" % exc)
            return 2

    if not args.raw and build_spec is not None:
        try:
            spec = build_spec(spec)
        except Exception as exc:
            sys.stderr.write("layout 解析失败: %s\n" % exc)
            return 1

    print("校验 %s" % os.path.relpath(path, HERE))
    rep = validate(spec)
    rep.dump()

    if not rep.ok():
        print("结果: 失败（%d error / %d warning）" % (len(rep.errors), len(rep.warnings)))
        return 1
    if args.strict and rep.warnings:
        print("结果: 失败（strict 模式，%d warning）" % len(rep.warnings))
        return 1
    print("结果: 通过（%d warning）" % len(rep.warnings))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
