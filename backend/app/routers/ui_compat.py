"""UI 兼容层：让 5.0 的 AIRI 风格网页界面跑在 HikiTravel 的后端上。

## 为什么要这一层

融合版的前端是 5.0 的 `public/`（Live2D 虚拟人物 + 可点击词云 + 全屏结果卡），
它原本对着 5.0 那套 Node 后端说话，一共要 34 个接口。后端换成 HikiTravel 的
FastAPI 之后，两边对不上，所以这里做一层翻译：

  · 静态目录类（状态 / 能力清单 / 角色卡 / 背景 / 音色 / …）
      → 直接返回从 5.0 导出的清单 `app/data/*.json`，并按磁盘实际内容过滤，
        免得清单里写着「有 3 套 Live2D」而磁盘上一套都没有。
  · 记忆 / 定位 / 全景 / 图片转 3D / Blender / 语音等可选功能
      → 返回「未启用」结构的空壳。前端本来就有降级路径，不会崩。
  · 生成（`POST /api/wenlv/generate`，SSE）
      → 这是唯一有真逻辑的接口，见下面 generate_stream 的说明。

## 生成这一条怎么接的

  · type=plan      走 HikiTravel 的编排器（意图 → 矛盾检测 → 高德检索 → 规划），
                   再把结构化 TravelPlan 渲染成 5.0 界面认识的 Markdown。
  · type=marketing / product / intake
                   HikiTravel 没有这三条业务链路，但它的 LLM 客户端可以复用。
                   所以直接沿用 2.2 引擎导出的系统提示词（app/data/prompts/），
                   交给同一个本机 Ollama 生成。提示词是从原引擎导出的原文，
                   不是重写的，行为与 5.0 一致。
"""
from __future__ import annotations

import json
import math
import re
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional
from urllib.parse import quote, unquote

from fastapi import APIRouter, Request

from ..cards_store import CardStore
from ..config import settings
from ..llm.client import LLMClient
from ..models.preference import Travelers, UserPreference
from ..orchestrator import get_orchestrator

router = APIRouter(prefix="/api")
# 与原生 api 路由共用同一个编排器（省一次知识索引构建）
orchestrator = get_orchestrator()
llm = LLMClient()


def _llm_route_status() -> Dict[str, Any]:
    """把模型路由的真实状态翻译成前端认的结构。

    前端读的是 localFirst.{policy,chat,vision,embed,canFallbackToLocal}：
      · policy  —— 给人看的一句话（走云端 / 走本地 / 都没配）
      · chat/vision/embed —— 各条链路的实际通道
      · canFallbackToLocal —— auto 模式下云端失败能不能落到本地
    """
    try:
        st = llm.status()
    except Exception:  # noqa: BLE001 —— 状态接口不能因为探测失败而 500
        return {"policy": "状态探测失败", "chat": "unknown", "vision": "unknown",
                "embed": "local", "canFallbackToLocal": True}
    pol, act = st["policy"], st["active"]
    if pol == "local":
        text = "只用本地 Ollama（数据不出机器）"
    elif pol == "cloud":
        text = "只用云端服务" if act == "cloud" else "只用云端，但还没配好（缺地址/key/模型名）"
    elif act == "cloud":
        text = "云端优先：网络不好或超时会自动落到本地"
    elif act == "local":
        text = "云端优先（未配外部服务）→ 当前走本地 Ollama"
    else:
        text = "云端和本地都不可用：请配 CLOUD_* 或启动 Ollama"
    return {
        "policy": text,
        "chat": act, "vision": act, "embed": "local",
        "canFallbackToLocal": pol != "cloud",
        "cloudConfigured": st["cloud"]["configured"],
        "localReady": st["local"]["configured"],
    }

# ---------------------------------------------------------------------------
# 静态数据：从 5.0 导出的 UI 清单 + 2.2 引擎导出的提示词
# ---------------------------------------------------------------------------
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
PROMPT_DIR = DATA_DIR / "prompts"
#: 静态资源根目录（5.0 的 public/），用来核对清单里的素材是否真的在磁盘上
PUBLIC_DIR = Path(__file__).resolve().parents[3] / "public"


def _load(name: str, default: Any) -> Any:
    """读一份导出的 JSON 清单；文件缺失时返回默认值，不让整个服务起不来。"""
    path = DATA_DIR / f"{name}.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _load_prompt(kind: str, suffix: str) -> str:
    """读 2.2 引擎导出的系统提示词 / 用户模板。"""
    try:
        return (PROMPT_DIR / f"{kind}.{suffix}.txt").read_text(encoding="utf-8")
    except OSError:
        return ""


CATALOG = _load("capabilities", {})
#: 角色卡是有状态的（设置页要改、要落盘），所以交给 CardStore 管，
#: app/data/cards.json 只作为首次启动的内置样例。
CARD_STORE = CardStore(Path(settings.data_dir))
BACKGROUNDS = _load("backgrounds", {"ok": True, "bundled": [], "procedural": [], "custom": []})
MODELS3D = _load("models3d", {"ok": True, "formats": {}, "bundled": [], "custom": []})
SPEAKERS = _load("tts-speakers", {"ok": True, "speakers": []})
#: 定位导航页用的内置景点坐标，从 5.0 的 lib/geo.js 原样导出（29 个景点 / 5 座城市）
GEO = _load("geo", {"gazetteer": [], "cityCenters": {}})
#: 词云的词表。**这份不是从 5.0 导出的** —— 导出的那份写的是上个项目的东西
#: （营销平台 / 文创产品概念 / 机体记忆 / 声音设置 / 形象…），本项目根本没有那些能力。
#: 这份按当前项目真实有的东西重写：
#:   · 条件词 → 工作台表单的字段与可选值（兴趣 6 项 / 节奏 3 项 / 交通 4 项 / 讨厌 3 项 / 忌口 4 项）
#:   · 产物词 → PlanView 实际渲染出来的区块（概览 / 天气 / 时间轴 / 费用 / 推荐池 / 跳转…）
#:   · 动作词 → 本项目真有的操作
#: 每一项都有出处，见 README「词云」一节。
WORDCLOUD = _load("wordcloud", {"groups": [], "words": []})

#: Live2D 与 3D 模型的真身都在 public/ 下，清单只用来描述元数据。
L2D_DIR = PUBLIC_DIR / "models"
M3D_DIR = PUBLIC_DIR / "models3d"


def _live2d() -> List[Dict[str, Any]]:
    """Live2D 清单：只留磁盘上确实装了的那几套。"""
    items = CATALOG.get("live2d") or []
    if not L2D_DIR.is_dir():
        return []
    have = {p.name for p in L2D_DIR.iterdir() if p.is_dir()}
    return [it for it in items if it.get("id") in have]


def _models3d_bundled() -> List[Dict[str, Any]]:
    """清单里声明、且 public/models3d/<目录> 真的存在的 3D 模型。

    ★ 原版这里有两个坑，都会让模型"登记了却不出现"：

    1. **用 id 当目录名去比对**。原来是 `it["id"] in have`，
       但 id 和目录名并不一致（id=vrm-seed-san，目录=seed-san；
       id=vrm-vrm1-sample，目录=vrm1-sample）——
       于是**两个 VRM 示例从来没显示出来过**。改成从 url 里取目录名。

    2. **`or` 短路吞掉了整份清单**。原来是
       `CATALOG...bundled or MODELS3D.bundled or []`：
       CATALOG（capabilities.json）里只要非空，MODELS3D（models3d.json）
       就**完全读不到** —— 往 models3d.json 里加条目等于白加。
       改成两份合并去重。
    """
    if not M3D_DIR.is_dir():
        return []
    have = {p.name for p in M3D_DIR.iterdir() if p.is_dir()}

    merged: List[Dict[str, Any]] = []
    seen = set()
    for src in ((CATALOG.get("models3d") or {}).get("bundled"),
                MODELS3D.get("bundled")):
        for it in (src or []):
            if not isinstance(it, dict):
                continue
            key = it.get("id") or it.get("url")
            if not key or key in seen:
                continue
            seen.add(key)
            merged.append(it)

    def _dir_of(it: Dict[str, Any]) -> str:
        """从 /models3d/<目录>/xxx.glb 里取 <目录>；取不到退回 id。"""
        parts = [x for x in str(it.get("url") or "").split("/") if x]
        if len(parts) >= 2 and parts[0] == "models3d":
            return parts[1]
        return str(it.get("id") or "")

    return [it for it in merged if _dir_of(it) in have]


# ---------------------------------------------------------------------------
# 一、状态与能力清单
# ---------------------------------------------------------------------------
def _match_model(models: List[str], needle: str) -> str:
    """在 ollama 已装模型里找一个名字含 needle 的，返回它的完整名字（带 tag）。"""
    for name in models:
        if needle in name:
            return name
    return ""


def _pick_vision_model(models: List[str]) -> str:
    """挑一个真正的视觉模型。

    这里必须真的去匹配多模态模型，不能像早先那样直接拿对话模型顶上——
    否则前端状态灯会显示「视觉就绪」，而实际调用必然失败。
    优先小参数（3b），显存只有 8 GiB，大模型会和规划抢 GPU。
    """
    cands = [m for m in models if "vl" in m.lower() or "vision" in m.lower()]
    if not cands:
        return ""
    cands.sort(key=lambda m: (0 if "3b" in m.lower() else 1, len(m)))
    return cands[0]


@router.get("/status")
def status() -> Dict[str, Any]:
    """总状态。前端启动、状态灯、设置页都读它。"""
    models = []
    try:
        import httpx

        r = httpx.get(f"{settings.ollama_base_url}/api/tags", timeout=3.0)
        models = [m.get("name", "") for m in (r.json().get("models") or [])]
    except Exception:  # noqa: BLE001 - 探测失败就当没有，不阻断页面
        models = []
    chat_model = _match_model(models, settings.ollama_model.split(":")[0]) or settings.ollama_model
    embed_model = _match_model(models, settings.ollama_embed_model.split(":")[0]) \
        or settings.ollama_embed_model
    vision_model = _pick_vision_model(models)
    return {
        "ok": True,
        "ollama": {
            "running": bool(models),
            "url": settings.ollama_base_url,
            "models": models,
            "chatModel": chat_model,
            "visionModel": vision_model,
            "embedModel": embed_model,
            "ready": bool(models),
            "localReady": bool(models),
            # 真实的路由状态：走云端还是本地、有没有配外部服务、能不能回落。
            # 原来这里写死一句"只走本地、未接入外部模型服务" —— 那是接入云端之前的事，
            # 现在客户端的 LLMClient.status() 才是真的。
            "localFirst": _llm_route_status(),
        },
        "tts": {"running": False, "url": "", "models": [], "code": "NO_TTS",
                "error": "融合版暂时没接语音合成；规划与文案生成不受影响。"},
        "memory": {"total": 0, "withEmbedding": 0, "usableEmbedding": 0, "staleEmbedding": 0,
                   "facts": 0, "turns": 0, "embedModel": embed_model,
                   "mode": "未启用", "file": ""},
        "cards": {"total": len(CARD_STORE.listing()["cards"]),
                  "activeId": (CARD_STORE.active() or {}).get("id", "")},
        "wenlv": {"entityCount": CATALOG.get("entityCount", 0),
                  "cities": CATALOG.get("cities", [])},
        "live2d": _live2d(),
        "amap": {"configured": bool(orchestrator.retrieve.amap.key)},
        # 以下均为结构正确的空壳：前端全部走 || 降级路径，不会白屏
        "openapi": {"configured": False, "configPath": ""},
        "prefs": {"configPath": "", "tools": 0},
        "web": {"enabled": False},
        "location": {"enabled": False, "hasLocation": False, "status": "off"},
        "pano": {"enabled": False, "items": 0, "maxMB": 300},
        "img23d": {"modelPresent": False, "jobs": 0},
        "stt": {"enabled": False, "running": False},
        "gpu": {"available": False},
        "scenery": {"enabled": True, "mode": "procedural"},
        "blender": {"enabled": False},
        "dataDir": str(DATA_DIR),
    }


@router.post("/parse-preference")
def parse_preference(body: Dict[str, Any]) -> Dict[str, Any]:
    """只解析**文字里真的说到的**字段，返回一个「部分画像」。

    给「输入框优先」那条路用：用户在对话框里打的字，要盖过气泡里点过的选项，
    但**只能盖过他真说到的那些字段** —— 否则输入框里随便一句话就会把气泡选的
    城市/天数一起冲掉。

    所以这里不能返回完整 UserPreference（那样没提到的字段会带上默认值，
    调用方分不清"用户说了"还是"默认值"）。规则见 intent_skill.parse_partial。

    返回的键名与 UserPreference 一致，调用方按需映射成工作台表单的字段。
    """
    text = str((body or {}).get("text") or "").strip()
    if not text:
        return {"ok": True, "fields": {}}
    try:
        from ..skills.intent_skill import IntentSkill

        fields = IntentSkill(llm=llm).parse_partial(text)
    except Exception as exc:  # noqa: BLE001 - 解析失败不该阻断生成
        return {"ok": False, "fields": {}, "error": str(exc)}
    return {"ok": True, "fields": fields}


@router.get("/capabilities")
def capabilities() -> Dict[str, Any]:
    """能力清单：词云、选项、音色、形象、角色卡。前端的词云就按它渲染。"""
    cap = dict(CATALOG)
    cap["ok"] = True
    _apply_current_wordcloud(cap)
    cap["live2d"] = _live2d()
    m3d = dict(cap.get("models3d") or {})
    m3d["bundled"] = _models3d_bundled()
    m3d.setdefault("custom", [])
    cap["models3d"] = m3d
    cap["myVoices"] = []
    return cap


def _apply_current_wordcloud(cap: Dict[str, Any]) -> None:
    """把词云换成**当前项目**的词表，并顺带修掉几个跟着一起错的字段。

    5.0 导出的 capabilities.json 里，词云写的是上个项目的能力
    （营销平台 / 文创产品概念 / 机体记忆 / 声音设置 / 形象 …）。本项目没有这些，
    留着会让用户点到一个不存在的东西，所以整块换掉。

    跟着一起换的还有：
      · cities      —— 原来列的是 5.0 样本库覆盖的城市，这里改成词表里真正提供的
      · entityCount —— 原来是 5.0 样本库的实体数 117。本项目的"本地样本库"
                        其实是 RAG 知识库那几条，报 117 是假话，改成真实条数。
      · features    —— 原来写的是 5.0 的四大能力，这里换成本项目真有的。
    """
    words = WORDCLOUD.get("words") or []
    groups = WORDCLOUD.get("groups") or []
    if not words:
        return          # 文件缺失就保留原样，不至于把词云整个弄空

    cap["wordCloud"] = words
    cap["wordCloudGroups"] = groups
    cap["cities"] = [w["word"] for w in words
                     if w.get("group") == "目的地" and w.get("action") == "pick"]

    # 本地样本库真实条数（RAG 知识片段）
    try:
        from ..rag.repository import get_all_chunks

        cap["entityCount"] = len(get_all_chunks())
    except Exception:  # noqa: BLE001 - 读不到就别改，留给原来的值
        pass

    cap["features"] = [
        {"id": "plan", "name": "个性化行程规划", "desc": "四段式流水线：意图识别 → 异常拦截 → 数据检索 → 规划生成", "icon": "🗺️"},
        {"id": "realtime", "name": "高德实时数据", "desc": "景点 / 餐厅 / 酒店 / 天气 / 路线都是实时取的", "icon": "📡"},
        {"id": "guard", "name": "需求矛盾拦截", "desc": "预算偏低 / 老人×特种兵 / 老人×爬山 / 儿童×特种兵 / 高龄×极低预算，只给建议不擅自改", "icon": "🛡️"},
        {"id": "jump", "name": "一键跳转", "desc": "导航 / 点评 / 美团 / 携程，带 Scheme→超时→H5→复制口令 四级降级", "icon": "🧭"},
        {"id": "planb", "name": "雨天备选", "desc": "按实时天气给出室内替代，一键替换", "icon": "🌧️"},
        {"id": "rag", "name": "本地知识库", "desc": "游玩贴士来自本地 RAG，不联网", "icon": "📚"},
    ]


@router.get("/cards")
def cards() -> Dict[str, Any]:
    return CARD_STORE.listing()


# 注意：字面路径必须写在 `/cards/{card_id}` 之前。FastAPI 按声明顺序匹配，
# 反过来的话 `/api/cards/export-all` 会被当成 card_id="export-all"。
@router.get("/cards/export-all")
def cards_export_all() -> Any:
    from fastapi.responses import JSONResponse

    body = json.dumps(CARD_STORE.listing(), ensure_ascii=False, indent=1)
    return JSONResponse(content=json.loads(body), headers={
        "Content-Disposition": 'attachment; filename="wenlv-cards.json"'})


@router.post("/cards/import")
def cards_import(body: Dict[str, Any]) -> Any:
    from fastapi import HTTPException

    r = CARD_STORE.import_json(body.get("card"))
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r)
    return r


@router.post("/cards")
def cards_create(body: Dict[str, Any]) -> Dict[str, Any]:
    return {"ok": True, "card": CARD_STORE.create(body or {})}


@router.get("/cards/{card_id}")
def cards_get(card_id: str) -> Any:
    from fastapi import HTTPException

    card = CARD_STORE.get(card_id)
    if not card:
        raise HTTPException(status_code=404, detail={"ok": False, "error": "没找到这张角色卡。"})
    return {"ok": True, "card": card}


@router.put("/cards/{card_id}")
def cards_update(card_id: str, body: Dict[str, Any]) -> Any:
    from fastapi import HTTPException

    card = CARD_STORE.update(card_id, body or {})
    if not card:
        raise HTTPException(status_code=404, detail={"ok": False, "error": "没找到这张角色卡。"})
    return {"ok": True, "card": card}


@router.delete("/cards/{card_id}")
def cards_delete(card_id: str) -> Any:
    from fastapi import HTTPException

    r = CARD_STORE.remove(card_id)
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r)
    return r


@router.post("/cards/{card_id}/activate")
def cards_activate(card_id: str) -> Any:
    from fastapi import HTTPException

    card = CARD_STORE.set_active(card_id)
    if not card:
        raise HTTPException(status_code=404, detail={"ok": False, "error": "没找到这张角色卡。"})
    return {"ok": True, "card": card, "activeId": card["id"]}


@router.post("/cards/{card_id}/duplicate")
def cards_duplicate(card_id: str) -> Any:
    from fastapi import HTTPException

    card = CARD_STORE.duplicate(card_id)
    if not card:
        raise HTTPException(status_code=404, detail={"ok": False, "error": "没找到这张角色卡。"})
    return {"ok": True, "card": card}


@router.get("/cards/{card_id}/export")
def cards_export(card_id: str) -> Any:
    from fastapi import HTTPException
    from fastapi.responses import JSONResponse

    card = CARD_STORE.get(card_id)
    if not card:
        raise HTTPException(status_code=404, detail={"ok": False, "error": "没找到这张角色卡。"})
    return JSONResponse(content=card, headers={
        "Content-Disposition": f'attachment; filename="card-{card_id}.json"'})


@router.get("/backgrounds")
def backgrounds() -> Dict[str, Any]:
    return BACKGROUNDS


@router.get("/models3d")
def models3d() -> Dict[str, Any]:
    out = dict(MODELS3D)
    out["bundled"] = _models3d_bundled()
    out.setdefault("custom", [])
    return out


@router.get("/tts/speakers")
def tts_speakers() -> Dict[str, Any]:
    return SPEAKERS


# ---------------------------------------------------------------------------
# 二、可选功能的空壳：保持结构，让前端的降级路径正常走
# ---------------------------------------------------------------------------
@router.get("/voices")
def voices() -> Dict[str, Any]:
    return {"ok": True, "voices": []}


@router.get("/memory")
def memory_list(limit: int = 60) -> Dict[str, Any]:
    return {"ok": True, "total": 0, "items": [],
            "stats": {"total": 0, "withEmbedding": 0, "facts": 0, "turns": 0, "mode": "未启用"}}


@router.post("/memory/search")
def memory_search() -> Dict[str, Any]:
    return {"ok": True, "hits": []}


@router.post("/memory/clear")
def memory_clear() -> Dict[str, Any]:
    return {"ok": True, "removed": 0}


@router.get("/prefs")
def prefs() -> Dict[str, Any]:
    return {"ok": True, "config": {"version": 1, "web": {"enabled": False},
                                   "location": {"enabled": False}, "pano": {"enabled": False},
                                   "blender": {"enabled": False}, "stt": {"enabled": False},
                                   "boot": {"video": "", "muted": False, "fit": "rotate"},
                                   "video": {"main": ""}},
            "tools": [], "configPath": ""}


# ---------------------------------------------------------------------------
# 视频背景：data/videos/
#
# 为什么这里必须自己实现：HikiTravel 的后端**没有视频背景这个概念**，
# 融合时这块只留了一个空壳接口（永远返回空列表）。而 5.0 的前端有一整套
# 视频面板（列片 / 缩略图 / 设为主界面或开屏背景 / 上传 / 删除），
# 它每次问「有哪些片子」都被告知"一个都没有" ——
# **表现就是"每次重新启动视频都不见了"**：文件明明还在磁盘上。
#
# 目录取**项目根**下的 data/videos/，不是 backend/data/：
# 用户的片子是从 5.0 带过来的，本来就在那儿；指到 backend/data 会找不到。
# ---------------------------------------------------------------------------
VIDEO_DIR = Path(__file__).resolve().parents[3] / "data" / "videos"
#: 抽取出来的音轨。和视频并列放，前者是"画面"，后者是"配乐"。
AUDIO_DIR = Path(__file__).resolve().parents[3] / "data" / "audio"
VIDEO_MAX_MB = 300
_VIDEO_EXT = {".mp4", ".webm", ".mov", ".m4v", ".ogv"}
_VIDEO_MIME = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm",
    ".mov": "video/quicktime", ".ogv": "video/ogg",
}


def _video_items() -> List[Dict[str, Any]]:
    """扫一遍 data/videos/。名字带「西湖」的自动成为推荐片（赛题就是西湖宣传）。"""
    if not VIDEO_DIR.is_dir():
        return []
    out: List[Dict[str, Any]] = []
    for p in sorted(VIDEO_DIR.iterdir()):
        if not p.is_file() or p.suffix.lower() not in _VIDEO_EXT:
            continue
        out.append({
            "id": p.name,
            "name": p.name,
            # 用文件名当 id，url 走本文件的取片接口
            "url": "/api/videos/" + quote(p.name),
            "bytes": p.stat().st_size,
            "recommended": "西湖" in p.name,
        })
    out.sort(key=lambda v: (not v["recommended"], v["name"]))
    return out


def _video_path(vid: str) -> Optional[Path]:
    """把 id 变成一个真实存在的文件路径。只取 basename，杜绝 ../ 穿越。"""
    name = Path(unquote(str(vid or ""))).name
    if not name or Path(name).suffix.lower() not in _VIDEO_EXT:
        return None
    p = VIDEO_DIR / name
    return p if p.is_file() else None


@router.get("/videos")
def videos() -> Dict[str, Any]:
    items = _video_items()
    rec = next((v for v in items if v["recommended"]), (items[0] if items else None))
    return {
        "ok": True,
        "items": items,
        "dir": str(VIDEO_DIR),
        "maxMB": VIDEO_MAX_MB,
        # 前端读的是 status.recommended / status.count / status.dir
        "status": {
            "recommended": rec,
            "dir": str(VIDEO_DIR),
            "count": len(items),
            "maxMB": VIDEO_MAX_MB,
        },
    }


@router.post("/videos")
async def video_upload(request: Request) -> Dict[str, Any]:
    from fastapi import HTTPException

    body = await request.json()
    raw = str(body.get("video") or "")
    # 允许带 data: 前缀
    if "," in raw[:80] and raw.lstrip().startswith("data:"):
        raw = raw.split(",", 1)[1]
    name = Path(str(body.get("name") or "video.mp4")).name
    if Path(name).suffix.lower() not in _VIDEO_EXT:
        raise HTTPException(status_code=400, detail="只支持 mp4 / webm / mov / m4v / ogv")

    import base64
    import binascii

    try:
        data = base64.b64decode(re.sub(r"\s+", "", raw), validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="上传内容不是合法的 base64")
    if not data:
        raise HTTPException(status_code=400, detail="上传内容为空")
    if len(data) > VIDEO_MAX_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"视频过大（上限 {VIDEO_MAX_MB}MB）")

    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    target = VIDEO_DIR / name
    target.write_bytes(data)

    # 上传时顺手探一次音轨：有声音就抽出来放进音频库。
    # 默认仍然是**用视频自带的原声**，抽出来只是让用户能单独换配乐/试听。
    from ..services.audio_extract import extract_audio, probe_audio
    info = probe_audio(target)
    audio: Dict[str, Any] = {"has_audio": info.get("has_audio", False),
                             "reason": info.get("reason", "")}
    if audio["has_audio"]:
        got = extract_audio(target, AUDIO_DIR)
        audio["extracted"] = bool(got["ok"])
        audio["track"] = got["name"] if got["ok"] else ""
        if not got["ok"]:
            audio["reason"] = got.get("error", "")

    items = _video_items()
    return {"ok": True, "name": name, "bytes": len(data), "audio": audio,
            "item": next((v for v in items if v["id"] == name), None)}


@router.delete("/videos/{vid}")
def video_delete(vid: str) -> Dict[str, Any]:
    p = _video_path(vid)
    if p is None:
        return {"ok": False, "error": "视频不存在"}
    try:
        p.unlink()
    except OSError as e:
        return {"ok": False, "error": f"删除失败：{e}"}
    return {"ok": True}


@router.get("/videos/{vid}")
def video_file(vid: str, request: Request) -> Any:
    """取片。

    必须支持 **Range**：前端给缩略图设了 `#t=1.2` 并 `currentTime = 1.2` 去取首帧，
    播放器要用 Range 请求才能定位；不支持的话缩略图会一直黑着、拖动进度条也会失效。
    """
    from fastapi import HTTPException
    from fastapi.responses import FileResponse, Response

    p = _video_path(vid)
    if p is None:
        raise HTTPException(status_code=404, detail="视频不存在")

    mime = _VIDEO_MIME.get(p.suffix.lower(), "application/octet-stream")
    size = p.stat().st_size
    rng = request.headers.get("range") or ""
    m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())

    if m:
        start = int(m.group(1)) if m.group(1) else 0
        end = int(m.group(2)) if m.group(2) else size - 1
        start = max(0, min(start, size - 1))
        end = max(start, min(end, size - 1))
        length = end - start + 1
        with p.open("rb") as f:
            f.seek(start)
            chunk = f.read(length)
        return Response(
            content=chunk, status_code=206, media_type=mime,
            headers={
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(len(chunk)),
                "Cache-Control": "no-store",
            },
        )

    return FileResponse(str(p), media_type=mime, headers={"Accept-Ranges": "bytes"})


# ---------------------------------------------------------------------------
# 音频库：data/audio/
#
# 上传视频时自动抽取（见 video_upload），也可以被用户单独指定给别的片子。
# 默认行为不变：**视频用自己的原声**；这里的音轨是"可选的替换项"。
# ---------------------------------------------------------------------------
@router.get("/audio")
def audio_list() -> Dict[str, Any]:
    from ..services.audio_extract import list_audio
    return {"ok": True, "items": list_audio(AUDIO_DIR), "dir": str(AUDIO_DIR)}


@router.get("/hot")
def hot() -> Dict[str, Any]:
    """热点来源。气泡里"去哪儿"的那批选项由它驱动。

    A/B/C/D 四条通道可切换（HOT_SOURCE），auto 按 A→C→B→D 回退。
    返回值里的 `source` / `estimated` 要**原样透给前端** ——
    "真热搜"和"按 POI 估算的"必须能分辨，不能假装。
    """
    from ..services.hot_topics import hot_topics
    try:
        return hot_topics()
    except Exception as e:  # noqa: BLE001 —— 热点挂了不能影响别的接口
        log.warning("热点接口异常：%s", e)
        return {"ok": False, "source": "", "estimated": False,
                "label": "热点不可用", "items": []}


@router.post("/audio")
async def audio_upload(request: Request) -> Dict[str, Any]:
    """直接上传一个音频文件（不经过视频）。

    和"上传视频时自动抽音轨"是两条路：
      · 视频那条约等于"用我片子的原声"
      · 这条是"我自己有一首，直接放进来"
    两条最终都落到同一个音频库，前端在配乐列表里同样能选。
    """
    import base64
    import binascii

    from fastapi import HTTPException

    from ..services.audio_extract import AUDIO_EXTS, list_audio

    body = await request.json()
    raw = str(body.get("audio") or "")
    if "," in raw[:80] and raw.lstrip().startswith("data:"):
        raw = raw.split(",", 1)[1]
    name = Path(str(body.get("name") or "audio.m4a")).name
    if Path(name).suffix.lower() not in AUDIO_EXTS:
        raise HTTPException(status_code=400,
                            detail="只支持 m4a / mp3 / wav / ogg / opus / aac / flac")
    try:
        data = base64.b64decode(re.sub(r"\s+", "", raw), validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="上传内容不是合法的 base64")
    if not data:
        raise HTTPException(status_code=400, detail="上传内容为空")
    if len(data) > 60 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="音频过大（上限 60MB）")

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    (AUDIO_DIR / name).write_bytes(data)
    return {"ok": True, "name": name, "bytes": len(data), "items": list_audio(AUDIO_DIR)}


@router.get("/audio/{name}")
def audio_file(name: str, request: Request) -> Any:
    """取音轨。和视频一样要支持 Range —— 试听时拖进度条要用。"""
    from fastapi import HTTPException
    from fastapi.responses import FileResponse, Response

    from ..services.audio_extract import AUDIO_EXTS

    safe = Path(unquote(str(name or ""))).name
    if not safe or Path(safe).suffix.lower() not in AUDIO_EXTS:
        raise HTTPException(status_code=404, detail="音轨不存在")
    p = AUDIO_DIR / safe
    if not p.is_file():
        raise HTTPException(status_code=404, detail="音轨不存在")

    mime = {".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
            ".ogg": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac",
            ".aac": "audio/aac"}.get(p.suffix.lower(), "application/octet-stream")
    size = p.stat().st_size
    rng = request.headers.get("range") or ""
    m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
    if m:
        start = int(m.group(1)) if m.group(1) else 0
        end = int(m.group(2)) if m.group(2) else size - 1
        start = max(0, min(start, size - 1))
        end = max(start, min(end, size - 1))
        with p.open("rb") as f:
            f.seek(start)
            chunk = f.read(end - start + 1)
        return Response(content=chunk, status_code=206, media_type=mime,
                        headers={"Content-Range": f"bytes {start}-{end}/{size}",
                                 "Accept-Ranges": "bytes",
                                 "Content-Length": str(len(chunk)),
                                 "Cache-Control": "no-store"})
    return FileResponse(str(p), media_type=mime, headers={"Accept-Ranges": "bytes"})


@router.delete("/audio/{name}")
def audio_delete(name: str) -> Dict[str, Any]:
    """删除音频库里的一条音轨。

    只删 data/audio/ 下那个文件本身 —— 宣传片（data/videos/）不受影响，
    所以删了配音若还想听片子原声，重新上传一次视频即可再抽一次。

    安全：只取 basename（杜绝 ../ 穿越），且后缀必须在 AUDIO_EXTS 白名单里，
    避免被拿来删任意文件。
    """
    from fastapi import HTTPException

    from ..services.audio_extract import AUDIO_EXTS, list_audio

    safe = Path(unquote(str(name or ""))).name
    if not safe or Path(safe).suffix.lower() not in AUDIO_EXTS:
        raise HTTPException(status_code=400, detail="音轨名不合法")
    p = AUDIO_DIR / safe
    if not p.is_file():
        raise HTTPException(status_code=404, detail="音轨不存在")
    try:
        p.unlink()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"删除失败：{e}") from e
    # 连同最新列表一起返回，前端不用再拉一次
    return {"ok": True, "removed": safe, "items": list_audio(AUDIO_DIR)}


# ---------------------------------------------------------------------------
# 定位导航页：地图瓦片代理 + 内置景点坐标
#
# 这三个接口是导航页的命脉：nav.js 把 /api/tile 直接当 <img> 的 src 用，
# 少了它就是满屏裂图；/api/geo/cities 与 /api/geo/nearby 分别负责
# 「没有定位权限时选个起点」和「离我多远、在哪个方向」。
#
# 瓦片为什么不让前端直连高德：一是防盗链（没有 Referer/UA 会被拒），
# 二是走服务端才能缓存——大屏上平移地图时瓦片请求量不小。
# 高德栅格瓦片不需要 key，而且是中文注记，比 OpenStreetMap 适合国内文旅场景。
# ---------------------------------------------------------------------------
_TILE_CACHE: "OrderedDict[str, bytes]" = OrderedDict()
_TILE_CACHE_MAX = 256


@router.get("/tile")
def tile(z: int, x: int, y: int, style: str = "8") -> Any:
    from fastapi import HTTPException
    from fastapi.responses import Response

    # z/x/y/style 会拼进上游 URL，不严格校验就等于开了个「任意请求」的口子。
    if not (3 <= z <= 18) or x < 0 or y < 0 or x >= 2 ** z or y >= 2 ** z:
        raise HTTPException(status_code=400, detail={"ok": False, "error": "瓦片参数不合法"})
    if not re.fullmatch(r"[0-9]{1,2}", style):
        raise HTTPException(status_code=400, detail={"ok": False, "error": "瓦片参数不合法"})

    key = f"{z}-{x}-{y}-{style}"
    buf = _TILE_CACHE.get(key)
    if buf is None:
        while len(_TILE_CACHE) >= _TILE_CACHE_MAX:
            _TILE_CACHE.popitem(last=False)   # 丢最早进的，近似 LRU
        host = f"webrd0{1 + (abs(x + y) % 4)}.is.autonavi.com"
        url = (f"https://{host}/appmaptile?lang=zh_cn&size=1&scale=1"
               f"&style={style}&x={x}&y={y}&z={z}")
        try:
            import httpx

            r = httpx.get(url, timeout=10.0, headers={
                "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 Chrome/120 Safari/537.36"),
                "Referer": "https://www.amap.com/",
            })
            if r.status_code != 200 or not r.content:
                raise HTTPException(status_code=502,
                                    detail={"ok": False, "error": f"上游返回 {r.status_code}"})
            buf = r.content
            _TILE_CACHE[key] = buf
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail={"ok": False,
                                                         "error": f"取瓦片失败：{exc}"})

    return Response(content=buf, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


# ---- 地理解算：与 5.0 lib/geo.js 用同一套公式，结果保持一致 ----
_EARTH_R = 6371008.8          # 地球平均半径（米），IUGG 推荐值
_COMPASS_16 = ["北", "北东北", "东北", "东东北", "东", "东东南", "东南", "南东南",
               "南", "南西南", "西南", "西西南", "西", "西西北", "西北", "北西北"]


def _distance_meters(a: Dict[str, float], b: Dict[str, float]) -> float:
    la1, la2 = math.radians(a["lat"]), math.radians(b["lat"])
    dla, dln = la2 - la1, math.radians(b["lng"] - a["lng"])
    h = (math.sin(dla / 2) ** 2
         + math.cos(la1) * math.cos(la2) * math.sin(dln / 2) ** 2)
    return 2 * _EARTH_R * math.asin(min(1.0, math.sqrt(h)))


def _bearing_deg(a: Dict[str, float], b: Dict[str, float]) -> float:
    la1, la2 = math.radians(a["lat"]), math.radians(b["lat"])
    dln = math.radians(b["lng"] - a["lng"])
    y = math.sin(dln) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dln)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _compass_label(deg: float) -> str:
    return _COMPASS_16[round(((deg % 360) + 360) % 360 / 22.5) % 16]


def _format_distance(m: float) -> str:
    """距离的中文说法。带一位小数就够，多余的精度只会让人以为它很准。"""
    if m < 1000:
        return f"{round(m)} 米"
    if m < 10000:
        return f"{m / 1000:.1f} 公里"
    return f"{round(m / 1000)} 公里"


def _valid_coord(lat: float, lng: float) -> bool:
    return (-90 <= lat <= 90 and -180 <= lng <= 180
            and not (lat == 0 and lng == 0) and abs(lat) <= 85)


@router.get("/geo/cities")
def geo_cities() -> Dict[str, Any]:
    return {"ok": True, "cities": GEO.get("cityCenters", {})}


@router.get("/geo/nearby")
def geo_nearby(lat: float, lng: float, limit: int = 8) -> Any:
    """附近景点：对内置景点表做就近匹配。

    逆地理编码（经纬度 → 地名）高德和百度都要 key，而本项目的原则是
    不引入需要密钥的外部依赖。对文旅场景来说，「你离断桥残雪 320 米、
    在西北方向」比一个行政区名字有用得多，而且完全离线可用。
    """
    from fastapi import HTTPException

    if not _valid_coord(lat, lng):
        raise HTTPException(status_code=400, detail={"ok": False, "error": "经纬度不合法"})
    here = {"lat": lat, "lng": lng}
    spots = []
    for s in GEO.get("gazetteer", []):
        meters = _distance_meters(here, s)
        bearing = _bearing_deg(here, s)
        spots.append({
            "city": s.get("city", ""), "name": s.get("name", ""), "aka": s.get("aka") or [],
            "lat": s.get("lat"), "lng": s.get("lng"),
            "meters": round(meters), "distance": _format_distance(meters),
            "bearing": round(bearing), "compass": _compass_label(bearing),
        })
    spots.sort(key=lambda x: x["meters"])
    limit = min(max(int(limit or 8), 1), 30)
    return {"ok": True, "here": here, "spots": spots[:limit]}


@router.get("/pano")
def pano() -> Dict[str, Any]:
    return {"ok": True, "items": [], "enabled": False, "depthModelPresent": False}


@router.get("/img23d")
def img23d() -> Dict[str, Any]:
    return {"ok": True, "jobs": [], "modelPresent": False}


_STT_STATUS = {
    "enabled": False,
    "modelPresent": False,
    "language": "zh",
    "modelDir": "",
    "busy": False,
    "queued": 0,
}


@router.get("/blender")
def blender() -> Dict[str, Any]:
    """Blender 联动面板的状态。

    前端 app.js:3895 读的是 `r.status`（不是 `r.available`），
    少这一层会让面板一直显示「读取状态失败」。
    """
    return {"ok": True, "status": {"available": False,
                                   "reason": "融合版没有接入 Blender 联动（5.0 的可选插件）。"},
            "jobs": [], "host": "127.0.0.1", "port": 9876}


@router.get("/blender/ping")
def blender_ping() -> Dict[str, Any]:
    return {"ok": True, "available": False, "host": "127.0.0.1", "port": 9876}


@router.get("/location")
def location() -> Dict[str, Any]:
    return {"ok": True, "location": None,
            "status": {"hasLocation": False, "source": {}, "fresh": False,
                       "ageText": "", "label": "", "lat": None, "lng": None}}


@router.post("/location/ip")
def location_ip() -> Dict[str, Any]:
    return {"ok": True, "location": None}


@router.delete("/location")
def location_clear() -> Dict[str, Any]:
    return {"ok": True, "location": None}


@router.post("/location/manual")
def location_manual() -> Dict[str, Any]:
    """手动填坐标。

    5.0 这里会把坐标存起来，供导航页当起点。融合版的定位数据没有落盘，
    所以如实返回「未保存」，前端 renderGeoPanel() 会照着 status 显示，
    不会假装存住了——这比返回一个 ok:true 但下次刷新就没了要诚实。
    """
    from fastapi import HTTPException

    raise HTTPException(status_code=503, detail={
        "ok": False, "error": "融合版没有实现坐标持久化，暂时不能保存手动坐标；"
                              "导航页可以直接选城市起点。"})


@router.get("/location/relation")
def location_relation(_spot: str = "", city: str = "", lat: float = 0, lng: float = 0) -> Any:
    """「我在哪、目标在哪个方向」。

    有坐标时按内置景点表算方位；没有坐标就如实报错，不编一个方向出来。
    """
    from fastapi import HTTPException

    target = _lookup_spot(_spot, city)
    if not _valid_coord(lat, lng):
        raise HTTPException(status_code=400, detail={
            "ok": False, "error": "还没有你的位置。先在导航页定位，或选一个城市起点。"})
    if not target:
        raise HTTPException(status_code=404, detail={
            "ok": False, "error": f"内置景点表里没有「{_spot}」的坐标，算不出方位。"})
    here = {"lat": lat, "lng": lng}
    meters = _distance_meters(here, target)
    bearing = _bearing_deg(here, target)
    return {"ok": True, "here": here,
            "target": {"name": target.get("name", ""), "city": target.get("city", ""),
                       "lat": target.get("lat"), "lng": target.get("lng")},
            "meters": round(meters), "distanceText": _format_distance(meters),
            "bearing": round(bearing), "bearingText": _compass_label(bearing)}


def _lookup_spot(name: str, city: str = "") -> Optional[Dict[str, Any]]:
    """按名字/别名在内置景点表里找一条，可限定城市。"""
    q = str(name or "").strip()
    if not q:
        return None
    for s in GEO.get("gazetteer", []):
        if city and s.get("city") != city:
            continue
        names = [s.get("name", ""), *(s.get("aka") or [])]
        if any(q == n or (n and n in q) or (q and q in n) for n in names):
            return s
    return None


@router.post("/tts")
def tts_generate() -> Any:
    """语音合成。融合版没有接 Qwen TTS。

    这里返回 503 + 一句人话，而不是让前端撞 404：前端对 502/503/504 有专门的
    文案分支（会提示「去起本机语音服务」），404 只会甩出一句裸的 HTTP 状态码。
    """
    from fastapi import HTTPException

    raise HTTPException(status_code=503, detail={
        "ok": False, "code": "NO_TTS",
        "error": "融合版没有接入语音合成（Qwen TTS 是 5.0 的独立服务）。"
                 "规划与文案生成不受影响。"})


@router.get("/tts")
def tts_status() -> Dict[str, Any]:
    return {"ok": True, "running": False, "url": "", "models": [], "code": "NO_TTS"}


@router.get("/scenery/local")
def scenery_local(spot: str = "") -> Any:
    """自备风景图目录。融合版没有这个目录，如实说没有，前端会退回程序化风景。"""
    return {"ok": False, "error": "融合版没有自备风景图目录。"}


@router.get("/scenery/search")
def scenery_search(spot: str = "") -> Any:
    """联网搜风景图。融合版不抓外网图片（版权与稳定性都不合适），如实拒绝。"""
    return {"ok": False, "error": "融合版不联网抓取景点图片，已使用内置程序化风景。"}


@router.post("/providers/models")
def providers_models() -> Any:
    """拉取外部模型列表。融合版是纯本地推理，没有外部模型接入。"""
    from fastapi import HTTPException

    raise HTTPException(status_code=400, detail={
        "ok": False, "error": "融合版只走本机 Ollama，没有接入外部模型服务。"})


@router.post("/providers/test")
def providers_test() -> Any:
    from fastapi import HTTPException

    raise HTTPException(status_code=400, detail={
        "ok": False, "error": "融合版只走本机 Ollama，没有接入外部模型服务。"})


@router.get("/stt")
def stt() -> Dict[str, Any]:
    """语音识别状态。前端 app.js:1854 读的是 `r.status.*`。"""
    return {"ok": True, "status": dict(_STT_STATUS)}


@router.api_route("/stt/status", methods=["GET", "POST"])
def stt_status() -> Dict[str, Any]:
    """探测按钮与状态查询共用一个路径。

    前端两处约定不同：`GET /api/stt` 读 `status.*`，
    而「检测环境」按钮是 `POST /api/stt/status` 并读 `env.available`。
    这里两个键都给，两条消费路径都不会落空。
    """
    return {"ok": True, **dict(_STT_STATUS),
            "status": dict(_STT_STATUS),
            "env": {"available": False, "python": "",
                    "reason": "融合版没有接入语音识别（需要 Whisper 权重与 Python 环境）。"}}


# ---------------------------------------------------------------------------
# 四、没有接入的可选插件：统一给一句人话，而不是裸的 404
#
# 5.0 的可选件（全景图、图片转 3D、Blender 联动、视频背景、我的音色）都靠
# 一堆独立的 Python/Blender 服务，融合版没有带过来。这些路径在 5.0 里是存在的，
# 前端也照样会调，缺了就返回 404 —— 用户看到的是「HTTP 404」，
# 分不清「这个功能本来就没有」还是「程序坏了」。所以这里显式声明为 501，
# 并写清楚原因；前端 `api()` 会把 error 文案原样 toast 出来。
# ---------------------------------------------------------------------------
def _unavailable(feature: str, hint: str = "") -> Any:
    from fastapi import HTTPException

    detail = {"ok": False, "code": "NOT_PORTED",
              "error": f"「{feature}」在融合版里没有接入。{hint}".strip()}
    raise HTTPException(status_code=501, detail=detail)


@router.delete("/backgrounds/{bg_id}")
def background_delete(bg_id: str) -> Any:
    _unavailable("删除自备背景", "融合版用的是 5.0 内置背景与程序化风景，没有可删的自备图。")


@router.delete("/memory/{mem_id}")
def memory_delete(mem_id: str) -> Any:
    _unavailable("删除单条记忆", "融合版还没有接记忆库，所以没有可删的条目。")


# 注意：原来这里还有一对 /videos/{vid} 的空壳路由（GET / DELETE），
# 已经删掉了 —— 真正的实现在本文件上半部分（列片 / 取片 / 上传 / 删除）。
# 留着会形成重复路由，FastAPI 只认先注册的那条，后面那条永远不生效，
# 排查时极容易被误导成"接口没实现"。


@router.delete("/voices/{voice_id}")
def voice_delete(voice_id: str) -> Any:
    _unavailable("删除自定义音色", "融合版没有接入语音合成，也就没有我的音色库。")


@router.get("/voices/{voice_id}")
def voice_get(voice_id: str) -> Any:
    _unavailable("自定义音色")


@router.delete("/models3d/{model_id}")
def model3d_delete(model_id: str) -> Any:
    _unavailable("删除自备 3D 模型")


@router.get("/models3d/{model_id}")
def model3d_get(model_id: str) -> Any:
    _unavailable("3D 模型详情")


@router.post("/models3d/preview")
def model3d_preview() -> Any:
    _unavailable("生成 3D 模型预览图")


@router.get("/pano/{pano_id}")
def pano_get(pano_id: str) -> Any:
    _unavailable("全景图", "全景需要额外的深度模型与 Python 环境。")


@router.post("/pano/acquire")
def pano_acquire() -> Any:
    _unavailable("采集全景图", "全景需要额外的深度模型与 Python 环境。")


@router.get("/pano/depth-check")
def pano_depth_check() -> Any:
    _unavailable("全景深度检测", "全景需要额外的深度模型与 Python 环境。")


@router.get("/pano/image/{name}")
def pano_image(name: str) -> Any:
    _unavailable("全景图", "全景需要额外的深度模型与 Python 环境。")


@router.get("/pano/depth/{name}")
def pano_depth(name: str) -> Any:
    _unavailable("全景深度图", "全景需要额外的深度模型与 Python 环境。")


@router.post("/img23d/detect")
def img23d_detect() -> Any:
    _unavailable("图片转 3D 环境检测", "需要额外的 TripoSR/DepthAnything 环境。")


@router.post("/img23d/generate")
def img23d_generate() -> Any:
    _unavailable("图片转 3D", "需要额外的 TripoSR/DepthAnything 环境。")


@router.post("/blender/anim")
def blender_anim() -> Any:
    _unavailable("Blender 走路动画", "需要本机启动 Blender MCP 服务。")


@router.get("/openapi")
def openapi_cfg() -> Dict[str, Any]:
    return {"ok": True, "config": {"enabled": False, "requireToken": True, "hasToken": False},
            "configPath": ""}


@router.get("/providers")
def providers() -> Dict[str, Any]:
    return {"ok": True, "active": False, "presets": [], "message": "融合版未接外部大模型，全部走本机 Ollama。"}


# ---------------------------------------------------------------------------
# 三、生成：唯一有真逻辑的接口
# ---------------------------------------------------------------------------
#: 5.0 的预算档位是「经济/舒适/高端」这种定性值，HikiTravel 的 budget 是具体金额。
#: 这里给一组总额换算，只用于让后端的预算分配有个尺度，不代表真实价格。
_BUDGET_YUAN = {"经济": 800, "舒适": 3000, "高端": 8000, "学生": 1000}

#: 同行人群 → HikiTravel 的 travelers 构成
_TRAVELERS = {
    "单人": (1, 0, 0),
    "情侣": (2, 0, 0),
    "朋友": (3, 0, 0),
    "亲子": (2, 1, 0),
    "带老人": (2, 0, 1),
    "团建": (8, 0, 0),
}


def _to_preference(params: Dict[str, Any]) -> UserPreference:
    """把 5.0 词云上点出来的参数，翻译成 HikiTravel 的用户画像。"""
    crowd = str(params.get("crowd") or "朋友")
    adults, children, elderly = _TRAVELERS.get(crowd, (2, 0, 0))
    diet = str(params.get("diet") or "无")
    interests = params.get("interests") or []
    if isinstance(interests, str):
        interests = [interests]
    days = 2
    try:
        days = max(1, min(int(params.get("days") or 2), 7))
    except (TypeError, ValueError):
        days = 2
    budget_key = str(params.get("budget") or "舒适")
    return UserPreference(
        travelers=Travelers(adults=adults, children=children, elderly=elderly),
        duration_days=days,
        destination=str(params.get("city") or "杭州"),
        transportation="本地",
        preferences=[i for i in interests if i],
        pace="适中",
        budget=float(_BUDGET_YUAN.get(budget_key, 3000)) * max(1, days / 2),
        dietary_restrictions=[] if diet in ("", "无") else [diet],
    )


def _to_partial_base(params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """把「用户真的点过」的条件翻成「只含有值字段」的画像底稿。

    为什么要这么绕：组员那套的合并契约是「表单已填字段优先，对话只补缺」
    （orchestrator._merge_base）。契约本身没问题，但前提是**送上去的必须是
    用户真的填过的字段**。要是把表单里的默认值（5.0 里天数默认 2、城市默认
    杭州）也当成"已填"送上去，用户在聊天框里说「帮我排苏州三天」会被默认值
    盖成「杭州 2 天」—— 比不合并还糟。

    所以这里只接受前端明确标记为「点选过」的字段；一个都没有就返回 None，
    让对话文本自己说了算。

    只认这几项，因为它们是词云上可点、且 HikiTravel 画像里有对应字段的：
    city / days / budget / crowd / interests / diet。
    """
    if not params:
        return None
    out: Dict[str, Any] = {}

    city = str(params.get("city") or "").strip()
    if city:
        out["destination"] = city

    if params.get("days") is not None:
        try:
            days = max(1, min(int(params["days"]), 7))
            out["duration_days"] = days
        except (TypeError, ValueError):
            pass

    crowd = str(params.get("crowd") or "")
    if crowd and crowd in _TRAVELERS:
        adults, children, elderly = _TRAVELERS[crowd]
        out["travelers"] = {"adults": adults, "children": children, "elderly": elderly}

    if params.get("budget"):
        # 同 _to_preference：定性档位换算成金额，只是个尺度，不代表真实价格
        days = out.get("duration_days", 2)
        out["budget"] = float(_BUDGET_YUAN.get(str(params["budget"]), 3000)) * max(1, days / 2)

    interests = params.get("interests") or []
    if isinstance(interests, str):
        interests = [interests]
    interests = [i for i in interests if i]
    if interests:
        out["preferences"] = interests

    diet = str(params.get("diet") or "")
    if diet and diet not in ("", "无"):
        out["dietary_restrictions"] = [diet]

    return out or None


def _money(value: Any) -> str:
    try:
        return f"{round(float(value)):,}"
    except (TypeError, ValueError):
        return "0"


def _plan_city(plan: Any, params: Dict[str, Any]) -> str:
    """算出这份方案是哪座城市的。

    为什么要这么绕：词云那条路会把 city 放在 params 里，直接拿就行；
    但对话那条路 params 是空的 —— 早先这里写的是 `params.get("city") or "目的地"`，
    于是聊天框生成的方案标题会变成「目的地 · 4 天3晚 个性化方案」，看着像模板没填。
    而 TravelPlan 本身**没有 destination 字段**，只能按可靠性依次退：

      ① 用户在词云上点过的城市（最明确）
      ② summary 开头的中文城市名（形如「苏州4日适中人文历史游」）——
         这是编排器自己对目的地的表述，最权威
      ③ 各日 POI 里出现最多的城市

    ③ 不能换成「第一个 POI 的城市」：实测一份苏州4日方案里 Day 1 排的是
    上海豫园与外滩（抵沪那天的安排），取第一个就会把标题写成「上海市」。
    多数决能避开这种个别跨城的节点。
    """
    city = str(params.get("city") or "").strip()
    if city:
        return _strip_city_suffix(city)

    m = re.match(r"^([\u4e00-\u9fa5]{2,6}?)(?=\d|特别|市|$)",
                 str(getattr(plan, "summary", "") or ""))
    if m:
        return _strip_city_suffix(m.group(1))

    tally: Dict[str, int] = {}
    for d in (getattr(plan, "daily_plans", None) or []):
        for it in (d.timeline or []):
            c = str(getattr(it.poi, "city", "") or "").strip()
            if c:
                tally[c] = tally.get(c, 0) + 1
    if tally:
        best = max(tally.items(), key=lambda kv: kv[1])[0]
        return _strip_city_suffix(best)
    return "目的地"


def _strip_city_suffix(city: str) -> str:
    """高德返回的城市名带「市」后缀（杭州市 / 苏州市），标题里去掉更顺眼。

    只削一个「市」，不动「香港/澳门」这类本来就没后缀的，也不去碰「区/县」——
    「浦东新区」削成「浦东新」就成错字了。
    """
    c = city.strip()
    return c[:-1] if len(c) > 2 and c.endswith("市") else c


def _render_plan_markdown(plan: Any, params: Dict[str, Any]) -> str:
    """把 HikiTravel 的结构化 TravelPlan 渲染成 5.0 界面认识的 Markdown。

    5.0 的结果卡排版逻辑认这几样：
      · `## 行程总览`（表格，占整行）
      · `## Day N`（这几块会被并排成一行）
      · `## 费用预估`、`## 替代方案 & 避坑提示`（各占整行）
    所以小标题的写法不能随意改，改了排版就不认了。
    """
    days = plan.daily_plans or []
    city = _plan_city(plan, params)
    nights = max(len(days) - 1, 0)
    head = f"# {city} · {len(days)} 天{nights}晚 个性化方案\n"
    meta_bits = []
    # 词云那条路 params 里有这些；对话那条路为空，就从 plan 自己身上补，
    # 免得聊天生成的方案表头只剩一个孤零零的标题。
    crowd = params.get("crowd")
    if not crowd and getattr(plan, "travelers", 0):
        crowd = f"{plan.travelers} 人"
    if crowd:
        meta_bits.append(f"同行：{crowd}")
    budget_txt = params.get("budget")
    if not budget_txt:
        total = getattr(plan, "total_budget_estimate", 0) or 0
        if total:
            budget_txt = f"约 {_money(total)} 元"
    if budget_txt:
        meta_bits.append(f"预算：{budget_txt}")
    if params.get("interests"):
        bits = params["interests"]
        meta_bits.append("偏好：" + ("+".join(bits) if isinstance(bits, list) else str(bits)))
    if params.get("diet") and params["diet"] != "无":
        meta_bits.append(f"忌口：{params['diet']}")
    out = [head]
    if meta_bits:
        out.append("> " + " ｜ ".join(meta_bits) + "\n")

    # ---- 行程总览（整行表格）----
    out.append("## 行程总览\n")
    out.append("| 天数 | 日期 | 天气 | 主要安排 |")
    out.append("| --- | --- | --- | --- |")
    for i, d in enumerate(days, 1):
        names = [it.poi.name for it in d.timeline][:4]
        weather = f"{d.weather.condition} {d.weather.temp}" if d.weather else "—"
        out.append(f"| Day {i} | {d.date or '—'} | {weather} | {' → '.join(names) or '—'} |")
    out.append("")

    # ---- 逐日（Day N 会被并排成一行）----
    seen_tips: set = set()
    for i, d in enumerate(days, 1):
        out.append(f"## Day {i} · {d.date or ''}".rstrip())
        weather = f"{d.weather.condition} {d.weather.temp}" if d.weather else ""
        if weather:
            out.append(f"- 天气：{weather}")
        for it in d.timeline:
            poi = it.poi
            # 价格与提示可能说的是同一件事：poi.price=172 且 poi.tips 就是
            # 「参考消费约 172 元」，两条都拼上去会变成
            # 「参考 172 元，参考消费约 172 元」。所以先看提示里有没有已经
            # 报过这个价，报过就不再重复拼。
            tips_txt = poi.tips or it.tips or ""
            price_num = _money(poi.price) if poi.price else ""
            detail = []
            if price_num and not (tips_txt and ("参考" in tips_txt or price_num in tips_txt)):
                detail.append(f"参考 {price_num} 元")
            if poi.tier:
                detail.append(poi.tier)
            if tips_txt:
                detail.append(tips_txt)
            tail = f"（{'，'.join(detail)}）" if detail else ""
            line = f"- {it.time}　{poi.name}{tail}"
            if it.transport_to_next:
                t = it.transport_to_next
                line += f"　→ {t.mode} {t.duration}"
            out.append(line)
        if d.hotel:
            h = d.hotel
            extra = f"（参考 {_money(h.price)} 元/晚）" if h.price else ""
            out.append(f"- 住宿：{h.name}{extra}")
        # 贴士去重：规划器目前把同一份全局贴士塞进了每一天，两天就会看到
        # 一模一样的五行。这里保留首次出现的、后面重复的略过——内容没丢，
        # 只是不重复贴。哪天规划器改成「每日专属贴士」，这段自然就退化成直出。
        for tip in (d.tips or []):
            if tip in seen_tips:
                continue
            seen_tips.add(tip)
            out.append(f"- 贴士：{tip}")
        out.append("")

    # ---- 费用预估（整行表格）----
    b = plan.budget_breakdown
    out.append("## 费用预估\n")
    out.append("| 项目 | 预估 |")
    out.append("| --- | --- |")
    out.append(f"| 交通 | {_money(b.transport)} 元 |")
    out.append(f"| 门票 | {_money(b.tickets)} 元 |")
    out.append(f"| 餐饮 | {_money(b.dining)} 元 |")
    out.append(f"| 住宿 | {_money(b.hotel)} 元 |")
    out.append(f"| 总计 | {_money(plan.total_budget_estimate)} 元 |")
    if plan.user_budget:
        gap = float(plan.user_budget) - float(plan.total_budget_estimate)
        out.append(f"| 你的预算 | {_money(plan.user_budget)} 元（"
                   + (f"结余 {_money(gap)}" if gap >= 0 else f"超出 {_money(-gap)}") + "） |")
    out.append("")

    # ---- 替代方案 & 避坑（整行）----
    out.append("## 替代方案 & 避坑提示\n")
    wrote = False
    for i, d in enumerate(days, 1):
        if d.plan_b:
            out.append(f"- Day {i} 备选：{d.plan_b}")
            wrote = True
    for w in (plan.warnings or []):
        out.append(f"- 注意：{w}")
        wrote = True
    for c in (plan.conflicts or []):
        out.append(f"- 需求提示：{c.message}（建议：{c.suggestion}）")
        wrote = True
    if not wrote:
        out.append("- 本日行程未发现需要替换或提醒的项目。")
    return "\n".join(out) + "\n"


def _sse(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


# ---------------------------------------------------------------------------
# 三、对话（5.0 的聊天框走这两条，都是 SSE）
#
# 5.0 的聊天框会二选一：开了联网、或当前形象能指挥动作时走 /api/agent，
# 否则走 /api/chat/stream（app.js:1163 `useAgent = S.webEnabled || !!avatarCaps`）。
# 两条在 5.0 后端里是一套逻辑，这里也同样把两条都挂上，共用同一个生成器——
# 少挂一条，用户就会看到「请求失败（HTTP 404）」。
#
# 融合版的对话直接走 HikiTravel 的编排器（意图 → 拦截 → 高德检索 → 规划），
# 再把结构化 TravelPlan 渲染成 5.0 界面认识的 Markdown，所以聊天框里问
# 「帮我排个杭州三日游」用的是真实检索结果，而不是模型凭空编。
# ---------------------------------------------------------------------------
def _chat_stream(body: Dict[str, Any]) -> Iterator[str]:
    """两条对话接口共用的 SSE 生成器。"""
    t0 = time.time()
    message = str(body.get("message") or "").strip()
    yield _sse({"type": "start", "model": settings.ollama_model})

    if not message:
        yield _sse({"type": "error", "code": "EMPTY", "error": "没有收到内容，请先说点什么。"})
        yield "data: [DONE]\n\n"
        return

    # 前端会把「用户真的在词云上点过」的条件送上来（body.preference），
    # 按组员那套契约它们优先于对话解析 —— 对话只补没点过的那些字段。
    # 注意这里必须是**只含有值字段**的部分画像，见 _to_partial_base 的说明。
    base = _to_partial_base(body.get("preference") or {})
    text = ""
    warnings: List[str] = []
    try:
        yield _sse({"type": "notice", "text": "正在理解需求，并检索真实景点与天气…"})
        plan = orchestrator.run(raw_text=message, base=base)
        text = _render_plan_markdown(plan, {})
        warnings = list(plan.warnings or [])
    except Exception as exc:  # noqa: BLE001 - 检索失败也要给用户一个回答，不能只报错
        yield _sse({"type": "notice",
                    "text": f"规划链路暂时不可用（{exc}），改用本机模型直接回答。"})
        system = _load_prompt("plan", "system")
        try:
            text = (llm.chat_text(system, message) or "") if system else ""
        except Exception as exc2:  # noqa: BLE001
            yield _sse({"type": "error", "code": getattr(exc2, "code", "LLM_ERROR"),
                        "error": f"{exc2}\n\n（规划链路也失败了：{exc}）"})
            yield "data: [DONE]\n\n"
            return
        if not text.strip():
            yield _sse({"type": "error", "code": "LLM_ERROR",
                        "error": "本机模型没有返回内容，请确认 Ollama 正在运行且已拉取对话模型。"})
            yield "data: [DONE]\n\n"
            return

    for piece in _chunks(text, 120):
        yield _sse({"type": "delta", "text": piece})
        time.sleep(0.01)

    yield _sse({"type": "done", "content": text, "warnings": warnings,
                "model": settings.ollama_model, "elapsed": round(time.time() - t0, 1)})
    yield "data: [DONE]\n\n"


def _sse_response(gen: Iterator[str]) -> Any:
    from fastapi.responses import StreamingResponse

    return StreamingResponse(gen, media_type="text/event-stream; charset=utf-8",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/chat/stream")
def chat(body: Dict[str, Any]) -> Any:
    """对话式生成（SSE）。5.0 聊天框在不联网、无形象动作时的入口。

    路径说明：这里**不能**用 `/api/chat`。那条路径归 HikiTravel 原生所有，
    它按 5.0 之外的约定返回一整份 TravelPlan JSON（组员的 React 界面在调）。
    同一个路径没法既返回 JSON 又返回 SSE，所以 SSE 这条挂在 `/chat/stream`，
    5.0 界面里对应改了一行（public/js/app.js 的 sse() 调用）。
    """
    return _sse_response(_chat_stream(body))


@router.post("/agent")
def agent(body: Dict[str, Any]) -> Any:
    """带工具的对话（SSE）。融合版没有外部工具链，行为与 /chat 相同。"""
    return _sse_response(_chat_stream(body))


def _chunks(text: str, size: int = 180) -> Iterator[str]:
    """把整段 Markdown 切成小块推给前端，让它有流式的观感。"""
    for i in range(0, len(text), size):
        yield text[i:i + size]


@router.post("/wenlv/generate")
def generate(req: Request, body: Dict[str, Any]) -> Any:
    """生成入口（SSE）。前端点词云最终都走到这里。"""
    from fastapi.responses import StreamingResponse

    kind = str(body.get("type") or "plan")
    params = body.get("params") or {}

    def stream() -> Iterator[str]:
        t0 = time.time()
        # 注意：这里曾经写成 {"type": "start", "type": kind}，字典字面量的重复键
        # 会被后者覆盖，于是发出去的是 {"type": "plan"}，前端 `ev.type === 'start'`
        # 永远不成立——状态灯不会进「生成中」。
        yield _sse({"type": "start", "kind": kind, "model": settings.ollama_model})

        try:
            if kind == "plan":
                yield _sse({"type": "notice", "text": "正在按 HikiTravel 的规划链路生成…"})
                pref = _to_preference(params)
                plan = orchestrator.run(preference=pref)
                text = _render_plan_markdown(plan, params)
                warnings = list(plan.warnings or [])
            elif kind in ("marketing", "product", "intake"):
                system = _load_prompt(kind, "system")
                if not system:
                    raise RuntimeError("缺少导出的提示词，请检查 backend/app/data/prompts/")
                user = _user_prompt(kind, params)
                yield _sse({"type": "notice",
                            "text": "HikiTravel 没有这条业务链路，改用 2.2 引擎导出的提示词 + 本机 Ollama 生成…"})
                text = llm.chat_text(system, user) or ""
                if not text.strip():
                    raise RuntimeError("本机模型没有返回内容，请确认 Ollama 正在运行且已拉取对话模型。")
                warnings = []
            else:
                raise RuntimeError(f"未知类型：{kind}")

            for piece in _chunks(text):
                yield _sse({"type": "delta", "text": piece})
                time.sleep(0.01)   # 别把整段一次性糊上去，给前端一点渲染节奏

            yield _sse({"type": "done", "content": text, "warnings": warnings,
                        "model": settings.ollama_model,
                        "elapsed": round(time.time() - t0, 1), "params": params})
        except Exception as exc:  # noqa: BLE001 - 任何异常都要让前端看到原因
            yield _sse({"type": "error", "code": getattr(exc, "code", "INTERNAL"),
                        "error": str(exc)})
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream; charset=utf-8",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _user_prompt(kind: str, params: Dict[str, Any]) -> str:
    """按导出的用户模板拼请求（模板里的占位就是 5.0 那套字段）。"""
    if kind == "marketing":
        return (f"请为「{params.get('product') or '景区'}」生成「{params.get('platform') or '小红书'}」平台的营销文案：\n"
                f"- 产品/主体：{params.get('product') or '景区'}\n"
                f"- 目标平台：{params.get('platform') or '小红书'}\n"
                f"- 目标客群：{params.get('audience') or '年轻情侣'}\n"
                f"- 文案风格：{params.get('style') or '种草'}\n"
                "请输出 A/B 两个版本（理性卖点版 + 感性情绪版），各含：标题、正文、话题标签、配图建议、CTA。")
    if kind == "product":
        return (f"请为文旅行业设计一个「{params.get('kind') or '文创产品'}」产品概念：\n"
                f"- 产品类型：{params.get('kind') or '文创产品'}\n"
                f"- 目标客群：{params.get('audience') or '年轻情侣'}\n"
                f"- 价格档位参考：{params.get('budget') or '舒适'}\n"
                "请按「产品名 / 目标客群 / 组合要素 / 差异化卖点 / 定价区间 / 上新理由 / 风险与前提」"
                "输出一张产品概念卡。")
    return "我还没有提供任何需求信息，请先按规范向我集中追问（每个字段都给出可点选的候选选项）。"
