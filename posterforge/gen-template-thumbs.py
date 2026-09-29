# -*- coding: utf-8 -*-
"""gen-template-thumbs.py —— 给模板库批量生成缩略图（540x720 JPEG）。

为什么要重新做：模板库从 8 套扩到 41 套后，34 套没有缩略图 ——
选择器里图是空的、预览弹层里是裂图。verify-clean 抓到了这条。

为什么不用老的 build_assets.py 那条路：它依赖 public/bg/*.jpg 这 8 张底图，
而那批**已按需求删除**（改为"没图就 AI 自生成"）。所以这里：

  1. 用 aigen.py（本地 SDXL-Turbo）现生成 7 张"情绪底图"放到 .work 下
  2. 按模板的题材挑一张，套 render.py 渲成 1080x1440
  3. 缩到 540x720 存成 public/thumbs/<id>.jpg

**只留成品缩略图，不重建 public/bg/ 背景库** —— 保持"背景要么用用户的图、
要么 AI 现生成"这个既定方向，不再往仓库里塞一批常驻底图。

情绪底图按题材复用（7 张覆盖 41 套），而不是每套生成一张：
  · 省时间（7 张约 45 秒，41 张要 4 分钟）
  · 同题材的模板本来就该长得像，视觉上也更整齐
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
SITE_ROOT = HERE
REPO_ROOT = os.path.dirname(HERE)
FORGE = os.path.join(REPO_ROOT, "poster-forge")
sys.path.insert(0, FORGE)

PY_AIGEN = r"E:\ComfyUI_windows_portable\python_embeded\python.exe"
BG_DIR = os.path.join(HERE, ".work", "tplbg")
THUMB_DIR = os.path.join(HERE, "public", "thumbs")

# ---------------------------------------------------------------- 情绪底图
# 每张对应一类题材。prompt 全英文（扩散模型画中文必糊），末尾禁文字。
MOODS = {
    "snow": ("snowy mountain resort at sunrise, pine forest, warm golden light on snow, "
             "cinematic wide shot, no text, no words, no watermark, clean space at the bottom"),
    "island": ("seaside at dawn, calm ocean, distant island silhouette, soft pink and blue sky, "
               "cinematic, no text, no words, no watermark, clean space at the bottom"),
    "market": ("lively night market street, warm lantern glow, food stalls, bokeh lights, "
               "cinematic, no text, no words, no watermark, clean space at the bottom"),
    "tea": ("terraced tea plantation in morning mist, rolling green hills, soft light, "
            "cinematic, no text, no words, no watermark, clean space at the bottom"),
    "heritage": ("traditional Chinese courtyard at dusk, red lanterns, wooden beams, "
                 "warm ambient light, cinematic, no text, no words, no watermark, clean space at the bottom"),
    "outdoor": ("mountain meadow campsite at golden hour, tents, distant ridges, "
                "cinematic, no text, no words, no watermark, clean space at the bottom"),
    "night": ("city waterfront at night, reflection on water, soft city lights, deep blue sky, "
              "cinematic, no text, no words, no watermark, clean space at the bottom"),
}

# 题材 -> 情绪底图。按标签关键词匹配，顺序即优先级。
RULES = [
    (["雪", "温泉", "滑雪"], "snow"),
    (["海岛", "日出", "海", "船"], "island"),
    (["夜市", "市集", "年货", "小吃", "火锅", "烧烤", "餐饮", "套餐", "夜宵", "美食"], "market"),
    (["茶", "春", "花", "踏青", "红叶", "时令", "采摘"], "tea"),
    (["文博", "展览", "演出", "讲座", "非遗", "汉服", "剧场", "文化", "研学"], "heritage"),
    (["露营", "户外", "赛事", "运动", "马拉松"], "outdoor"),
    (["夜游", "灯光", "跨年", "元宵", "中秋", "直播"], "night"),
]

# 不配图的题材：通知/公告/招募/招聘/招商这类，纯文字版式本来就不该有照片底
NO_PHOTO_TAGS = ["公告", "通知", "招聘", "招商", "招募", "会员"]


def run(cmd, timeout=600):
    p = subprocess.run(cmd, capture_output=True, cwd=HERE, timeout=timeout)
    out = (p.stdout + p.stderr).decode("utf-8", "replace")
    return p.returncode, out


def ensure_backgrounds(force=False):
    os.makedirs(BG_DIR, exist_ok=True)
    made = 0
    for slug, prompt in MOODS.items():
        out = os.path.join(BG_DIR, slug + ".png")
        if os.path.isfile(out) and not force:
            print("  已存在 %s" % slug)
            continue
        print("  生成 %s ..." % slug)
        rc, log = run([PY_AIGEN, os.path.join(HERE, "aigen.py"),
                       "--prompt", prompt, "--out", out,
                       "--width", "768", "--height", "1024", "--steps", "4", "--seed", "11"],
                      timeout=900)
        if rc != 0 or not os.path.isfile(out):
            print("    ✗ 失败: %s" % log.strip().split("\n")[-1][:160])
            continue
        made += 1
        print("    ✓ %s" % out)
    return made


def pick_mood(t):
    tags = " ".join(t.get("tags") or []) + " " + (t.get("title") or "") + " " + (t.get("brief") or "")
    if any(k in tags for k in NO_PHOTO_TAGS):
        return None
    for keys, slug in RULES:
        if any(k in tags for k in keys):
            return slug
    return None


def build_spec(t, bg_slug):
    """构造竖版海报 spec。字段与 poster-layout / render 的约定一致。"""
    tone = t.get("tone")
    tone = 0.5 if not isinstance(tone, (int, float)) else tone
    # 调性映射到三套主题色
    if tone >= 0.66:
        pal = {"bgFrom": "#2a1206", "bgTo": "#5a2a12", "ink": "#fff6ec", "inkSoft": "#f0dcc8",
               "inkMute": "#c4a98f", "gold": "#f0b070", "panel": "#1a0c05", "divider": "#ffffff2e"}
    elif tone <= 0.33:
        pal = {"bgFrom": "#08181f", "bgTo": "#123642", "ink": "#f2fbff", "inkSoft": "#d3e8ef",
               "inkMute": "#9db8c2", "gold": "#8fd0dd", "panel": "#061218", "divider": "#ffffff2e"}
    else:
        pal = {"bgFrom": "#0b2429", "bgTo": "#1d4f57", "ink": "#f4fbfa", "inkSoft": "#d6ecec",
               "inkMute": "#9fc4c6", "gold": "#e8c37a", "panel": "#08202a", "divider": "#ffffff2e"}

    lines = [l.strip() for l in (t.get("brief") or "").split("\n") if l.strip()]
    title = (t.get("title") or "")[:14]
    sub = "\n".join(lines[:2])[:48] if lines else ""

    # BG_DIR 已被 register_image_root 注册为搜索根，
    # 所以这里写的是**相对该根**的路径，不要再加目录前缀
    # （踩过：写成 "_tplbg/snow.png" 会被解析成 <root>/_tplbg/snow.png）
    background = ({"type": "image", "image": bg_slug + ".png", "blobs": []}
                  if bg_slug else
                  {"type": "gradient", "from": "bgFrom", "to": "bgTo", "angle": 130,
                   "blobs": [{"x": 0.16, "y": 0.14, "r": 0.42, "color": "#ffffff22", "blur": 0.18},
                             {"x": 0.88, "y": 0.80, "r": 0.40, "color": "#00000055", "blur": 0.20}]})

    layers = []
    if bg_slug:
        # 照片底要压渐变遮罩，否则白字读不清（用渲染器的真渐变 scrim）
        pass  # scrim 写在 background.scrim 里
        background["scrim"] = {"top": 0.20, "bottom": 0.82}

    layers.append({"type": "text", "name": "brand", "text": "○○（填你的店名）",
                   "x": 0.068, "y": 0.052, "font": "bold", "size": 30, "color": "gold"})
    layers.append({"type": "text", "name": "eyebrow", "text": "PosterForge · 模板示例",
                   "x": 0.068, "y": 0.178, "font": "sans", "size": 24, "color": "inkSoft"})
    layers.append({"type": "text", "name": "title", "text": title,
                   "x": 0.068, "y": 0.222, "font": "heavy", "size": 104, "color": "ink",
                   "lineHeight": 1.16,
                   "fit": {"maxSize": 104, "minSize": 44, "maxWidth": 0.864, "maxHeight": 0.215, "maxLines": 2}})
    layers.append({"type": "shape", "name": "rule", "shape": "rect",
                   "box": [0.068, 0.492, 0.132], "size": [0.004, 0.008], "fill": "gold"})
    if sub:
        layers.append({"type": "text", "name": "subtitle", "text": sub,
                       "x": 0.068, "y": 0.542, "font": "sans", "size": 30, "color": "inkSoft",
                       "lineHeight": 1.55,
                       "fit": {"maxSize": 30, "minSize": 20, "maxWidth": 0.864, "maxHeight": 0.12, "maxLines": 3}})
    layers.append({"type": "shape", "name": "footerRule", "shape": "rect",
                   "box": [0.068, 0.836, 0.932], "size": [0.002, 0.0015],
                   "fill": "#ffffff", "opacity": 0.22})
    layers.append({"type": "text", "name": "footerNote", "text": "在输入里写「电话：…」或「地址：…」，就会印在这条线上",
                   "x": 0.068, "y": 0.862, "font": "sans", "size": 22, "color": "inkMute"})

    return {
        "canvas": {"width": 1080, "height": 1440},
        "meta": {"id": "thumb-" + t["id"], "audience": t.get("audience") or "hotel",
                 "client": "模板示例", "facts_source": "模板库示例内容（占位符，非真实数据）"},
        "theme": {"palette": pal},
        "background": background,
        "layers": layers,
    }


def main():
    force = "--force-bg" in sys.argv
    print("=== 1. 准备情绪底图 ===")
    ensure_backgrounds(force=force)

    # 渲染器把 public/ 注册成图片搜索根；把 .work/tplbg 也挂进去
    os.environ["PF_IMAGE_ROOT"] = os.path.join(HERE, "public")
    import render as R  # noqa: E402
    R.register_image_root(BG_DIR)
    print("  已把 %s 注册为图片搜索根" % BG_DIR)

    with open(os.path.join(HERE, "templates.json"), encoding="utf-8") as f:
        templates = json.load(f)["templates"]

    print()
    print("=== 2. 逐套渲染缩略图（目标 %d 套）===" % len(templates))
    os.makedirs(THUMB_DIR, exist_ok=True)
    ok = 0
    skipped = 0
    failed = []
    for i, t in enumerate(templates, 1):
        out = os.path.join(THUMB_DIR, t["id"] + ".jpg")
        if os.path.isfile(out) and not force and "--all" not in sys.argv:
            skipped += 1
            continue
        slug = pick_mood(t)
        if slug and not os.path.isfile(os.path.join(BG_DIR, slug + ".png")):
            slug = None
        try:
            spec = build_spec(t, slug)
            img = R.render(R.build_spec(spec))
            img = img.convert("RGB").resize((540, 720), 1)  # 1 = LANCZOS
            img.save(out, "JPEG", quality=88, optimize=True)
            ok += 1
            print("  [%2d/%d] %-22s %-9s %5.0f KB" % (i, len(templates), t["id"], slug or "渐变底",
                                                      os.path.getsize(out) / 1024))
        except Exception as e:
            failed.append((t["id"], str(e)[:120]))
            print("  [%2d/%d] %-22s ✗ %s" % (i, len(templates), t["id"], str(e)[:110]))

    print()
    print("生成 %d 套，跳过已存在 %d 套，失败 %d 套" % (ok, skipped, len(failed)))
    for tid, msg in failed[:10]:
        print("   ✗ %s: %s" % (tid, msg))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
