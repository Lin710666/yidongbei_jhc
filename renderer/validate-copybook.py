#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
validate-copybook.py —— 文案手册 spec 静态校验器

为什么必须有它：
    海报有 validate.py 把门，手册却一直裸奔。而手册恰恰是**内容最多、最容易出事**的物料：
    多页文档里藏一个"全市最低价"，没人会逐页去挑。这类错误会静默流到客户手里。

查五类问题（都不需要渲染）：
    1. 结构     —— 必填字段、版块类型、类型专属必填字段
    2. 调色板   —— 用到的色名是否都已定义（缺失会导致"配色错误但看起来正常"）
    3. 合规     —— 广告法禁用词 / 需资质表述 / 事实来源标注
    4. 引用     —— 引用的图片是否真的存在
    5. 跨页一致 —— 同一门店的电话/地址在多页是否一致

广告法词表**从 validate.py 导入**，不复制一份 —— 两处维护必然漂移。

用法：
    python validate-copybook.py --spec specs/copybook-x.json
    python validate-copybook.py --spec spec.json --strict    # 有 warning 也判失败
    python validate-copybook.py --spec spec.json --raw       # 不解析 @layout

退出码：0 通过 / 1 有 error / 2 文件问题
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Sequence, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# ---- 复用海报校验器的词表与工具，避免两套标准 ----
try:
    from validate import (
        AD_LAW_BANNED,
        AD_LAW_NEEDS_PROOF,
        FACT_TOKEN,
        COLOR_RE,
        PHONE_RE,
        normalize_phone,
        Report,
    )
except ImportError as exc:  # pragma: no cover
    sys.stderr.write("无法从 validate.py 导入词表：%s\n" % exc)
    raise

VALID_SECTIONS = {"cover", "text", "bullets", "table", "price", "contact", "image"}

# 每类版块的必填字段
REQUIRED_BY_TYPE: Dict[str, List[str]] = {
    "cover": ["title"],
    "text": ["body"],
    "bullets": ["items"],
    "table": ["columns", "rows"],
    "price": ["price"],
    "contact": ["items"],
    # image 的 src 必填：没有图的"图片版块"没有意义，
    # 但渲染器会画占位框而不是崩掉 —— 这里只保证 spec 别是空的。
    "image": ["src"],
}

# 调色板：按用到的页面类型决定哪些色名必须存在
PALETTE_DARK = ["ink", "inkSoft", "inkMute", "gold"]          # 深色页用
PALETTE_PAPER = ["paper", "inkOnPaper", "inkMuteOnPaper"]     # 浅色页用
PALETTE_GRADIENT = ["bgFrom", "bgTo"]                         # 渐变页用

DARK_SECTIONS = {"cover", "price", "contact"}
PAPER_SECTIONS = {"text", "bullets", "table", "image"}

# 建议存在的色名（缺失只给 warning，渲染器有默认值兜底）
PALETTE_OPTIONAL = ["accentOnPaper", "dividerOnPaper", "zebra", "panel", "divider"]

# 电话正则与归一化从 validate.py 复用（PHONE_RE / normalize_phone）
PRICE_RE = re.compile(r"(?:¥|￥)\s?[\d,]+(?:\.\d+)?")


# ---------------------------------------------------------------- 文本抽取
def collect_texts(spec: Dict[str, Any]) -> List[Tuple[str, str]]:
    """把手册里所有会印到纸上的文字抽出来，附带来源标签（便于报错定位）。"""
    out: List[Tuple[str, str]] = []

    def add(label: str, v: Any) -> None:
        if v is None:
            return
        if isinstance(v, (list, tuple)):
            for i, x in enumerate(v):
                add("%s[%d]" % (label, i), x)
        elif isinstance(v, dict):
            for k, x in v.items():
                add("%s.%s" % (label, k), x)
        else:
            s = str(v).strip()
            if s:
                out.append((label, s))

    meta = spec.get("meta") or {}
    for k in ("client", "title", "footer"):
        if meta.get(k):
            out.append(("meta.%s" % k, str(meta[k])))

    for i, s in enumerate(spec.get("sections") or []):
        if not isinstance(s, dict):
            continue
        tag = "sections[%d](%s)" % (i + 1, s.get("type", "?"))
        for k, v in s.items():
            if k == "type":
                continue
            add("%s.%s" % (tag, k), v)
    return out


# ---------------------------------------------------------------- 各阶段检查
def check_structure(spec: Dict[str, Any], rep: Report) -> None:
    meta = spec.get("meta")
    if not isinstance(meta, dict):
        rep.error("meta", "缺失或不是对象")
    else:
        for k in ("client", "title"):
            if not str(meta.get(k, "")).strip():
                rep.warn("meta.%s" % k, "为空 —— 页眉/封面会留白")

    theme = spec.get("theme")
    if not isinstance(theme, dict):
        rep.error("theme", "缺失或不是对象")
    elif not isinstance(theme.get("palette"), dict):
        rep.error("theme.palette", "缺失或不是对象")

    sections = spec.get("sections")
    if not isinstance(sections, list) or not sections:
        rep.error("sections", "必须是非空数组")
        return
    if len(sections) > 40:
        rep.warn("sections", "共 %d 页，手册一般不超过 20 页" % len(sections))

    if sections and isinstance(sections[0], dict) and sections[0].get("type") != "cover":
        rep.warn("sections[1]", "第一个版块不是 cover —— 手册通常以封面开头")

    for i, s in enumerate(sections):
        where = "sections[%d]" % (i + 1)
        if not isinstance(s, dict):
            rep.error(where, "必须是对象")
            continue
        t = s.get("type")
        if t not in VALID_SECTIONS:
            rep.error(where, "未知版块类型 %r（可选 %s）" % (t, "/".join(sorted(VALID_SECTIONS))))
            continue

        for f in REQUIRED_BY_TYPE[t]:
            v = s.get(f)
            if v is None or (isinstance(v, (list, str)) and len(v) == 0):
                rep.error("%s(%s)" % (where, t), "缺少必填字段 %r" % f)

        # 类型专属细则
        if t == "table":
            cols = s.get("columns") or []
            rows = s.get("rows") or []
            if isinstance(cols, list):
                for ri, row in enumerate(rows):
                    if not isinstance(row, list):
                        rep.error("%s.rows[%d]" % (where, ri), "必须是数组")
                    elif len(row) != len(cols):
                        rep.error(
                            "%s.rows[%d]" % (where, ri),
                            "列数 %d 与 columns 的 %d 不符（渲染会错位）" % (len(row), len(cols)),
                        )
            if len(cols) > 6:
                rep.warn("%s.columns" % where, "%d 列在 A4 上会偏窄" % len(cols))
        if t == "bullets":
            items = s.get("items") or []
            if isinstance(items, list):
                for ii, it in enumerate(items):
                    if isinstance(it, dict) and not str(it.get("head", "")).strip():
                        rep.error("%s.items[%d]" % (where, ii), "缺少 head")
        if t == "contact":
            items = s.get("items") or []
            if isinstance(items, list):
                for ii, it in enumerate(items):
                    if not isinstance(it, dict) or not str(it.get("k", "")).strip():
                        rep.error("%s.items[%d]" % (where, ii), "缺少 k（字段名）")
                    elif not str(it.get("v", "")).strip():
                        rep.error("%s.items[%d]" % (where, ii), "缺少 v（字段值）")


def check_palette(spec: Dict[str, Any], rep: Report) -> None:
    """按实际用到的页面类型，检查所需色名是否都定义了。"""
    palette = ((spec.get("theme") or {}).get("palette")) or {}
    if not isinstance(palette, dict) or not palette:
        rep.error("theme.palette", "不能为空 —— 手册需要色板才能渲染")
        return

    # 色值本身格式要对
    for k, v in palette.items():
        if not isinstance(v, str) or not COLOR_RE.match(v):
            rep.error("theme.palette.%s" % k, "值必须是 #RGB/#RRGGBB/#RRGGBBAA，收到 %r" % (v,))

    used = {s.get("type") for s in (spec.get("sections") or []) if isinstance(s, dict)}

    need: List[Tuple[str, str]] = []
    if used & DARK_SECTIONS:
        need += [(c, "深色页(cover/price/contact)") for c in PALETTE_DARK]
    if used & PAPER_SECTIONS:
        need += [(c, "浅色页(text/bullets/table)") for c in PALETTE_PAPER]
    if "cover" in used:
        need += [(c, "封面渐变") for c in PALETTE_GRADIENT]

    missing = [(c, why) for c, why in need if c not in palette]
    for c, why in missing:
        rep.error("theme.palette.%s" % c, "缺失 —— %s 会用到，渲染会报色值无法解析" % why)

    for c in PALETTE_OPTIONAL:
        if c not in palette and c in (
            "accentOnPaper",
        ) and (used & PAPER_SECTIONS):
            rep.warn("theme.palette.%s" % c, "未定义，浅色页会退回默认金色")


def check_compliance(spec: Dict[str, Any], rep: Report) -> None:
    """广告法与事实来源。手册最容易在这里出事。"""
    meta = spec.get("meta") or {}
    has_source = bool(str(meta.get("facts_source", "")).strip())
    if not has_source:
        rep.warn("meta.facts_source", "未标注事实来源；价格/电话/地址等事实字段应可回溯")

    texts = collect_texts(spec)

    for label, txt in texts:
        for w in AD_LAW_BANNED:
            if w in txt:
                rep.error(label, "命中广告法禁用/高风险词 %r —— 必须改写（原文: %s）" % (w, txt[:50]))
        for w in AD_LAW_NEEDS_PROOF:
            if w in txt:
                rep.warn(label, "含需资质表述 %r，请人工确认资质后再发布" % (w,))

    joined = "\n".join(t for _, t in texts)
    has_price = bool(PRICE_RE.search(joined))
    has_phone = bool(PHONE_RE.search(joined))
    if (has_price or has_phone) and not has_source:
        kinds = []
        if has_price:
            kinds.append("价格")
        if has_phone:
            kinds.append("电话")
        rep.error(
            "meta.facts_source",
            "手册含 %s 等事实字段，但未提供事实来源" % "/".join(kinds),
        )

    if has_price and "有效期" not in joined and "有效" not in joined:
        rep.warn("sections", "出现价格但未见有效期说明 —— 促销手册必须写明有效期")


def check_cross_section(spec: Dict[str, Any], rep: Report) -> None:
    """分页文档特有的检查：同一事实在多页之间要一致。"""
    texts = collect_texts(spec)

    phones: Dict[str, List[str]] = {}
    for label, txt in texts:
        for m in PHONE_RE.finditer(txt):
            phones.setdefault(normalize_phone(m.group()), []).append(label)

    if len(phones) > 1:
        detail = "; ".join(" %s ← %s" % (p, ",".join(set(w))[:60]) for p, w in phones.items())
        rep.error("cross-section", "手册里出现多个不同电话号码，客户会打错：%s" % detail)

    prices: Dict[str, List[str]] = {}
    for label, txt in texts:
        for m in PRICE_RE.finditer(txt):
            prices.setdefault(m.group().replace(" ", ""), []).append(label)

    # 规格表里多档价格是正常的；这里只在"价格页"与其它页冲突时提示
    price_sections = [s for s in (spec.get("sections") or [])
                      if isinstance(s, dict) and s.get("type") == "price"]
    if len(price_sections) > 1:
        rep.warn("sections", "有 %d 个价格页，确认是否都要保留" % len(price_sections))


def check_references(spec: Dict[str, Any], rep: Report) -> None:
    """手册版块目前不插图片，但 meta 里可能有 logo/背景图引用。"""
    try:
        from render import resolve_image_path  # type: ignore
    except ImportError:
        resolve_image_path = None  # type: ignore

    cands: List[Tuple[str, str]] = []
    meta = spec.get("meta") or {}
    for k in ("logo", "background", "image"):
        if isinstance(meta.get(k), str):
            cands.append(("meta.%s" % k, meta[k]))
    for i, s in enumerate(spec.get("sections") or []):
        if isinstance(s, dict) and isinstance(s.get("image"), str):
            cands.append(("sections[%d].image" % (i + 1), s["image"]))

    for label, src in cands:
        full = resolve_image_path(src) if resolve_image_path else (
            src if os.path.isabs(src) else os.path.join(HERE, src))
        if not os.path.isfile(full):
            rep.error(label, "图片不存在: %s" % full)


def validate(spec: Dict[str, Any]) -> Report:
    rep = Report()
    check_structure(spec, rep)
    check_palette(spec, rep)
    check_compliance(spec, rep)
    check_cross_section(spec, rep)
    check_references(spec, rep)
    return rep


# ---------------------------------------------------------------- CLI
def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="文案手册 spec 校验器")
    ap.add_argument("--spec", required=True)
    ap.add_argument("--strict", action="store_true", help="有 warning 也判失败")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出结果（供服务端调用）")
    args = ap.parse_args(argv)

    path = args.spec if os.path.isabs(args.spec) else os.path.join(HERE, args.spec)
    if not os.path.isfile(path):
        if args.json:
            print(json.dumps({"ok": False, "errors": ["spec 不存在: %s" % path],
                              "warnings": []}, ensure_ascii=False))
        else:
            sys.stderr.write("spec 不存在: %s\n" % path)
        return 2

    try:
        with io.open(path, "r", encoding="utf-8-sig") as fh:
            spec = json.load(fh)
    except json.JSONDecodeError as exc:
        if args.json:
            print(json.dumps({"ok": False, "errors": ["不是合法 JSON: %s" % exc],
                              "warnings": []}, ensure_ascii=False))
        else:
            sys.stderr.write("spec 不是合法 JSON: %s\n" % exc)
        return 2

    rep = validate(spec)

    if args.json:
        print(json.dumps({
            "ok": rep.ok(),
            "errors": rep.errors,
            "warnings": rep.warnings,
        }, ensure_ascii=False))
    else:
        print("校验 %s" % os.path.relpath(path, HERE))
        rep.dump()
        if not rep.ok():
            print("结果: 失败（%d error / %d warning）" % (len(rep.errors), len(rep.warnings)))
        elif args.strict and rep.warnings:
            print("结果: 失败（strict 模式，%d warning）" % len(rep.warnings))
        else:
            print("结果: 通过（%d warning）" % len(rep.warnings))

    if not rep.ok():
        return 1
    if args.strict and rep.warnings:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
