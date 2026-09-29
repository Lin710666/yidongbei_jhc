#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
site/build_assets.py —— 一次性生成站点所需的模板缩略图与案例图。

为什么用脚本批量生成而不是手工做图：
  1. 站点要展示「热门模板」，模板本身就是 poster-forge 的产物 —— 自洽。
  2. 规格化的东西用代码生成才可维护：改一次主题，全部缩略图跟着变。
  3. 不依赖任何外部素材，纯本地可复现。

输出：
  site/public/thumbs/tpl-*.png    模板缩略图（竖版，用于模板网格）
  site/public/thumbs/case-*.png   案例图（横版 16:9，用于爆火案例视频区封面）
"""

from __future__ import annotations

import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE_ROOT = HERE                      # site/
REPO_ROOT = os.path.dirname(HERE)     # deepseck/
FORGE_ROOT = os.path.join(REPO_ROOT, "poster-forge")
sys.path.insert(0, FORGE_ROOT)
sys.path.insert(0, SITE_ROOT)

import render as R  # noqa: E402

OUT = os.path.join(HERE, "public", "thumbs")
os.makedirs(OUT, exist_ok=True)


# ---------------------------------------------------------------- 主题
THEMES = {
    "teal": {
        "bgFrom": "#0b2a30", "bgTo": "#1d5f66", "ink": "#ffffff", "inkSoft": "#d6ecec",
        "inkMute": "#9fc4c6", "gold": "#e8c37a", "price": "#ffdb8f",
        "panel": "#06202a", "divider": "#ffffff2e",
    },
    "warm": {
        "bgFrom": "#33110d", "bgTo": "#7a2d17", "ink": "#fff6ef", "inkSoft": "#ffe3d0",
        "inkMute": "#e0a98c", "amber": "#ffb347", "price": "#ffd48a",
        "panel": "#2a0f0a", "divider": "#ffffff30",
    },
    "midnight": {
        "bgFrom": "#101826", "bgTo": "#26344a", "ink": "#ffffff", "inkSoft": "#e6edf7",
        "inkMute": "#a7b6cb", "accent": "#8fd6c2", "accent2": "#ffd08a",
        "gold": "#8fd6c2", "price": "#ffd08a",
        "panel": "#0a111c", "divider": "#ffffff2e",
    },
    "plum": {
        "bgFrom": "#1a0f28", "bgTo": "#4a2350", "ink": "#ffffff", "inkSoft": "#eddff5",
        "inkMute": "#b79cc9", "gold": "#ffc8e0", "amber": "#ffc8e0", "price": "#ffd9ec",
        "accent": "#ffc8e0", "accent2": "#cfd8ff",
        "panel": "#140a1e", "divider": "#ffffff2e",
    },
    "pine": {
        "bgFrom": "#0c1f16", "bgTo": "#1f4a35", "ink": "#ffffff", "inkSoft": "#d8ece1",
        "inkMute": "#9dbfae", "gold": "#c9e8a0", "amber": "#c9e8a0", "price": "#dcf0b4",
        "accent": "#c9e8a0", "accent2": "#a8e6c0",
        "panel": "#08170f", "divider": "#ffffff2e",
    },
    "ink": {
        "bgFrom": "#141414", "bgTo": "#3a3a3a", "ink": "#ffffff", "inkSoft": "#e0e0e0",
        "inkMute": "#a0a0a0", "gold": "#d4b483", "amber": "#d4b483", "price": "#e8cfa0",
        "accent": "#d4b483", "accent2": "#b9c6d4",
        "panel": "#0d0d0d", "divider": "#ffffff2e",
    },
}


def grad(theme: str) -> dict:
    """统一的背景配置：渐变 + 两个柔焦光斑（对应参考站的暖色辉光）。"""
    return {
        "type": "gradient", "from": "bgFrom", "to": "bgTo", "angle": 130,
        "blobs": [
            {"x": 0.16, "y": 0.14, "r": 0.42, "color": "#ffffff22", "blur": 0.18},
            {"x": 0.88, "y": 0.78, "r": 0.40, "color": "#00000055", "blur": 0.20},
        ],
    }


def accent_of(pal: dict) -> str:
    """挑一个存在的强调色名。每个主题的色板键不同，这里做显式回退。"""
    for k in ("gold", "amber", "accent", "accent2", "price"):
        if k in pal:
            return k
    raise KeyError("主题缺少可用强调色: %s" % sorted(pal))


# ---------------------------------------------------------------- 竖版模板
# 模板 -> AI 背景文件（slug），与 gen-backgrounds.mjs 的清单保持一致
BG_SLUGS = {
    "tpl-hotel-autumn": "seaside-sunset",
    "tpl-rest-lunch": "wok-fire",
    "tpl-scenic": "bamboo-mist",
    "tpl-hotel-snow": "snow-mountain",
    "tpl-night-market": "night-market",
    "tpl-tea": "tea-hillside",
    "tpl-museum": "hanfu-lantern",
    "tpl-seaside": "island-dawn",
}


def bg_for(tid: str, theme: str) -> dict:
    """
    背景优先级：AI 生成的真实照片 > 纯渐变。

    用照片时不加光斑 —— 光斑是为了给纯色渐变增加体积感，
    压在照片上只会显脏。
    """
    slug = BG_SLUGS.get(tid)
    if slug:
        p = os.path.join(SITE_ROOT, "public", "bg", slug + ".jpg")
        if os.path.isfile(p):
            # 渲染器把 public/ 注册成图片搜索根，写站点相对路径即可
            return {"type": "image", "image": "bg/" + slug + ".jpg", "blobs": []}
    return grad(theme)


def scrim_layers() -> list:
    """
    照片背景上的可读性蒙版。

    纯照片上压白字会读不清 —— 这是"好看但不可用"的典型失败。
    三段式渐变蒙版：顶部轻、中部中、底部重
    （底部信息量最大：价格与联系方式）。
    """
    return [
        {"type": "shape", "name": "scrimTop", "shape": "rect",
         "box": [0.0, 0.0, 1.0, 0.34], "fill": "#000000", "opacity": 0.34},
        {"type": "shape", "name": "scrimMid", "shape": "rect",
         "box": [0.0, 0.34, 1.0, 0.66], "fill": "#000000", "opacity": 0.46},
        {"type": "shape", "name": "scrimBottom", "shape": "rect",
         "box": [0.0, 0.66, 1.0, 1.0], "fill": "#000000", "opacity": 0.62},
    ]


def vertical_spec(tid: str, theme: str, brand: str, title: str, sub: str,
                  price_label: str, price: str, phone: str, address: str,
                  eyebrow: str = "") -> dict:
    pal = THEMES[theme]
    accent = accent_of(pal)
    price_key = "price"
    bg = bg_for(tid, theme)
    on_photo = bg.get("type") == "image"

    layers = ([*scrim_layers()] if on_photo else []) + [
        {"type": "text", "name": "brand", "text": brand, "x": 0.074, "y": 0.058,
         "font": "bold", "size": 34, "color": accent,
         "shadow": {"color": "#00000088", "dx": 0, "dy": 2, "blur": 8}},
        {"type": "shape", "name": "rule0", "shape": "rect",
         "box": {"box": [0.074, 0.108], "size": [0.09, 0.004]}, "fill": accent, "radius": 3},
        {"type": "text", "name": "title", "text": title, "x": 0.074, "y": 0.212,
         "font": "heavy", "size": 104, "lineHeight": 1.18, "color": "ink",
         "fit": {"maxSize": 104, "minSize": 52, "maxWidth": 0.85, "maxHeight": 0.22, "maxLines": 2},
         "shadow": {"color": "#00000099", "dx": 0, "dy": 4, "blur": 14}},
        {"type": "text", "name": "sub", "text": sub, "x": 0.074, "y": 0.500,
         "font": "sans", "size": 32, "lineHeight": 1.56, "color": "inkSoft",
         "fit": {"maxSize": 32, "minSize": 22, "maxWidth": 0.78, "maxHeight": 0.15, "maxLines": 3}},
        {"type": "shape", "name": "pricePanel", "shape": "rect",
         "box": [0.074, 0.688, 0.926, 0.778], "fill": "panel", "radius": 22, "opacity": 0.72},
        {"type": "shape", "name": "priceEdge", "shape": "rect",
         "box": {"box": [0.074, 0.688], "size": [0.010, 0.090]}, "fill": accent, "radius": 6},
        {"type": "text", "name": "priceNote", "text": price_label, "x": 0.112, "y": 0.733,
         "font": "sans", "size": 26, "color": "inkMute", "valign": "center"},
        {"type": "text", "name": "price", "text": price, "x": 0.902, "y": 0.733,
         "align": "right", "font": "heavy", "size": 72, "color": price_key, "valign": "center",
         "shadow": {"color": "#00000088", "dx": 0, "dy": 3, "blur": 10}},
        {"type": "shape", "name": "divider", "shape": "rect",
         "box": {"box": [0.074, 0.842], "size": [0.852, 0.0014]}, "fill": "divider", "radius": 2},
        {"type": "text", "name": "phone", "text": phone, "x": 0.074, "y": 0.868,
         "font": "bold", "size": 29, "color": "ink"},
        {"type": "text", "name": "address", "text": address, "x": 0.074, "y": 0.910,
         "font": "sans", "size": 22, "color": "inkMute",
         "fit": {"maxSize": 22, "minSize": 16, "maxWidth": 0.84, "maxLines": 2}},
    ]
    if eyebrow:
        layers.insert(3, {"type": "text", "name": "eyebrow", "text": eyebrow,
                          "x": 0.074, "y": 0.168, "font": "sans", "size": 28, "color": "inkSoft"})

    return {
        "meta": {"id": tid, "audience": "hotel", "client": brand,
                 "facts_source": "站点演示数据（build_assets.py 生成）"},
        "canvas": {"width": 1080, "height": 1440},
        "quality": {"sharpen": True},
        "theme": {"palette": pal},
        "background": bg,
        "layers": layers,
    }


# ---------------------------------------------------------------- 横版案例
def wide_spec(cid: str, theme: str, brand: str, title: str, sub: str,
              price: str, price_label: str) -> dict:
    pal = THEMES[theme]
    accent = accent_of(pal)
    return {
        "meta": {"id": cid, "audience": "restaurant", "client": brand,
                 "facts_source": "站点演示数据（build_assets.py 生成）"},
        "canvas": {"width": 1280, "height": 720},
        "quality": {"sharpen": True},
        "theme": {"palette": pal},
        "background": grad(theme),
        "layers": [
            {"type": "text", "name": "brand", "text": brand, "x": 0.062, "y": 0.098,
             "font": "bold", "size": 30, "color": accent,
             "shadow": {"color": "#00000088", "dx": 0, "dy": 2, "blur": 8}},
            {"type": "text", "name": "title", "text": title, "x": 0.062, "y": 0.268,
             "font": "heavy", "size": 92, "lineHeight": 1.18, "color": "ink",
             "fit": {"maxSize": 92, "minSize": 44, "maxWidth": 0.56, "maxHeight": 0.34, "maxLines": 2},
             "shadow": {"color": "#00000099", "dx": 0, "dy": 4, "blur": 12}},
            {"type": "text", "name": "sub", "text": sub, "x": 0.062, "y": 0.646,
             "font": "sans", "size": 26, "lineHeight": 1.5, "color": "inkSoft",
             "fit": {"maxSize": 26, "minSize": 18, "maxWidth": 0.54, "maxHeight": 0.20, "maxLines": 2}},
            {"type": "shape", "name": "pricePanel", "shape": "rect",
             "box": [0.660, 0.240, 0.944, 0.720], "fill": "panel", "radius": 24, "opacity": 0.66},
            {"type": "text", "name": "priceNote", "text": price_label, "x": 0.802, "y": 0.348,
             "align": "center", "font": "sans", "size": 22, "color": "inkMute"},
            {"type": "text", "name": "price", "text": price, "x": 0.802, "y": 0.492,
             "align": "center", "font": "heavy", "size": 84, "color": "price",
             "shadow": {"color": "#00000088", "dx": 0, "dy": 3, "blur": 10}},
            {"type": "shape", "name": "divider", "shape": "rect",
             "box": {"box": [0.062, 0.860], "size": [0.560, 0.0016]}, "fill": "divider", "radius": 2},
            {"type": "text", "name": "contact", "text": sub, "x": 0.062, "y": 0.900,
             "font": "sans", "size": 22, "color": "inkMute",
             "fit": {"maxSize": 22, "minSize": 15, "maxWidth": 0.58, "maxLines": 1}},
        ],
    }


# ---------------------------------------------------------------- 数据
TEMPLATES = [
    ("tpl-hotel-autumn", "teal", "山海楼·海景度假酒店", "住三晚\n送一晚",
     "全海景露台房 · 含双早 · 免费停车\n赠双人温泉 1 次", "三晚连住 · 每晚均价", "￥688",
     "预订 0592-8888-6666", "厦门市思明区环岛南路 1288 号", "秋季错峰 · 限量 200 间"),
    ("tpl-rest-lunch", "warm", "灶王爷·私房菜", "四菜一汤\n两人吃",
     "当日现炒 · 米饭例汤无限续\n午市 11:00–14:00", "工作日套餐价", "￥68",
     "订座 138-0000-1234", "城西老街 12 号", "工作日午市专享"),
    ("tpl-scenic", "pine", "云栖竹海景区", "踏青\n正当时",
     "万亩竹海 · 负氧离子 3 万个/cm³\n索道往返 + 讲解器全含", "成人票 · 含往返索道", "￥120",
     "咨询 0571-6666-8888", "浙江省湖州市安吉县云栖路 1 号", "春季限定 · 提前 1 天预约"),
    ("tpl-hotel-snow", "ink", "长白雪岭温泉酒店", "滑雪\n泡汤",
     "雪山景观房 · 私汤入户\n双人滑雪票 + 雪具租赁", "两晚套餐 · 含双早", "￥1288",
     "预订 0433-5555-7777", "吉林省延边州安图县长白山路 88 号", "雪季预售 · 12 月 1 日起"),
    ("tpl-night-market", "plum", "江畔星光夜市", "夜市\n开街",
     "80 家小吃 · 非遗手作 · 江景灯光秀\n每晚 18:00–24:00", "消费券满减", "￥30",
     "招商 0791-2222-3333", "江西省南昌市东湖区江畔大道 66 号", "国庆档期 · 连开 15 天"),
    ("tpl-tea", "pine", "半山茶事", "春茶\n上新",
     "明前龙井 · 手工炒制\n茶山体验 + 茶点一份", "双人茶席体验", "￥168",
     "预约 0571-9999-1111", "杭州市西湖区龙井村半山 7 号", "清明前限量 300 份"),
    ("tpl-museum", "teal", "汉风博物馆", "汉服\n免费穿",
     "凭门票免费租借汉服 · 专业妆造\n每日 9:00–17:00 · 周一闭馆", "门票 · 含汉服体验", "￥60",
     "咨询 029-8888-2222", "陕西省西安市雁塔区文博路 9 号", "暑期特别企划"),
    ("tpl-seaside", "midnight", "东极岛观日出", "看\n第一缕光",
     "海岛民宿 · 含往返船票\n日出观景台接送 + 海鲜早餐", "两天一夜 · 双人", "￥899",
     "预订 0580-3333-6666", "浙江省舟山市普陀区东极镇", "日出最佳季 4–6 月"),
]


def main() -> int:
    print("生成模板缩略图 ...")
    for (tid, theme, brand, title, sub, plabel, price, phone, addr, eyebrow) in TEMPLATES:
        spec = vertical_spec(tid, theme, brand, title, sub, plabel, price, phone, addr, eyebrow)
        img = R.render(spec)
        path = os.path.join(OUT, tid + ".png")
        img.save(path, "PNG", optimize=True)
        print("  %-20s %dx%d  %6.0f KB" % (tid, img.width, img.height, os.path.getsize(path) / 1024))

    # 案例图（case-01..06）已不再生成。
    # 首页的「爆火案例」区块按需求删除后，这些图成了零引用的死资产，
    # 而且它们的内容是编造的播放量/点赞数 + 编造的价格（含 ￥899），
    # 与其留着占地和误导，不如彻底去掉。原案例文案留档在 site/deleted-cases.json。
    # wide_spec() 一并保留 —— 横版 banner 仍是支持的版式。

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
