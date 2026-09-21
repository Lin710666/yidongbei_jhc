"""角色卡存储：融合版里「人物设定 / 音色 / 形象 / 背景」这些设置页的数据源。

为什么需要这个模块：5.0 界面把几乎所有的个性化设置都挂在角色卡上，
`PUT /api/cards/{id}` 是被调用最多的写接口之一（改语气、改音色、改形象、
改配色都走它）。而 HikiTravel 本身没有「角色卡」这个概念——它只有
UserPreference（用户画像）。所以这一层由融合版自己实现。

## 合并语义：深合并，而不是 5.0 的浅合并

5.0 的 lib/cards.js 里是 `normalize({ ...patch, ...input }, base)`，
也就是「patch 里有 voice 键 → 整个 voice 对象被替换掉」，然后逐字段回退到
**默认值**而不是原值。后果是：只发 `{voice:{speaker:'vivian'}}` 时，
`voice.instruct` 会被重置成空串——用户挑完音色，之前写的语气描述就没了。

这里改成递归深合并：patch 里出现的字段才覆盖，没出现的原样保留。
明确传 null 仍然能清空字段，所以表达力没有变弱，只是不会再误删。
"""
from __future__ import annotations

import json
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

#: 内置样例卡（小柚 / 阿杭 / 小文），从 5.0 导出，作为首次启动的初始内容
_BUILTIN_PATH = Path(__file__).resolve().parent / "data" / "cards.json"

_ALLOWED_ACCENT = "#a78bfa"


def _deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> Dict[str, Any]:
    """递归合并：只有 patch 里真的出现的键才覆盖。"""
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


class CardStore:
    """角色卡的读写。文件不存在时用内置卡初始化，改动即时落盘。"""

    def __init__(self, data_dir: Path) -> None:
        self.dir = data_dir
        self.file = data_dir / "cards.json"
        self._cards: List[Dict[str, Any]] = []
        self._active_id: str = ""
        self.load()

    # ---------------------------------------------------------------- 读盘
    def load(self) -> None:
        raw = None
        if self.file.is_file():
            try:
                raw = json.loads(self.file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                raw = None
        if not raw:
            raw = self._builtin()
        self._cards = [self._normalize(c) for c in (raw.get("cards") or [])]
        self._active_id = raw.get("activeId") or ""
        if not self._cards:
            self._cards = [self._normalize(c) for c in self._builtin().get("cards", [])]
        if not any(c["id"] == self._active_id for c in self._cards):
            self._active_id = self._cards[0]["id"] if self._cards else ""

    @staticmethod
    def _builtin() -> Dict[str, Any]:
        try:
            return json.loads(_BUILTIN_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {"cards": [], "activeId": ""}

    def persist(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        payload = {"cards": self._cards, "activeId": self._active_id}
        tmp = self.file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(self.file)   # 原子替换，写到一半断电也不会留下半截 JSON

    # ------------------------------------------------------------ 规整字段
    @staticmethod
    def _normalize(c: Dict[str, Any]) -> Dict[str, Any]:
        """缺字段补齐，避免前端拿到 undefined 而崩。默认值取自 5.0 lib/cards.js。"""
        voice = c.get("voice") or {}
        model = c.get("model") or {}
        live2d = c.get("live2d") or {}
        memory = c.get("memory") or {}
        vision = c.get("vision") or {}
        accent = str(c.get("accent") or "")
        return {
            "id": c.get("id") or str(uuid.uuid4()),
            "builtin": bool(c.get("builtin")),
            "name": str(c.get("name") or "未命名角色")[:40],
            "avatar": c.get("avatar") or "🙂",
            "accent": accent if len(accent) == 7 and accent.startswith("#") else _ALLOWED_ACCENT,
            "tagline": str(c.get("tagline") or "")[:80],
            "persona": str(c.get("persona") or "")[:8000],
            "speakingStyle": str(c.get("speakingStyle") or "")[:2000],
            "greeting": str(c.get("greeting") or "")[:1000],
            "voice": {
                "presetId": voice.get("presetId") or "wenlv-guide-female",
                "mode": voice.get("mode") or "custom-voice",
                "instruct": str(voice.get("instruct") or "")[:500],
                "speaker": voice.get("speaker") or None,
                "language": voice.get("language") or "Chinese",
                "refVoiceId": voice.get("refVoiceId") or None,
            },
            "model": {
                "chat": model.get("chat") or None,
                "temperature": float(model.get("temperature") or 0.7),
                "numCtx": int(model.get("numCtx") or 16384),
                "numPredict": int(model.get("numPredict") or 1024),
            },
            "live2d": {
                "kind": live2d.get("kind") or "live2d",
                "model": live2d.get("model") or "mao",
                "scale": float(live2d.get("scale") or 1),
                "x": float(live2d.get("x") or 0),
                "y": float(live2d.get("y") or 0),
                "expression": live2d.get("expression") or "",
                "idleMotion": live2d.get("idleMotion") is not False,
            },
            "memory": {
                "enabled": memory.get("enabled") is not False,
                "topK": int(memory.get("topK") or 5),
            },
            "vision": {"enabled": vision.get("enabled") is not False},
            "tags": list(c.get("tags") or [])[:10],
            "createdAt": c.get("createdAt") or int(time.time() * 1000),
            "updatedAt": int(time.time() * 1000),
        }

    # ---------------------------------------------------------------- 查询
    def listing(self) -> Dict[str, Any]:
        return {"ok": True, "cards": [dict(c) for c in self._cards], "activeId": self._active_id}

    def get(self, card_id: str) -> Optional[Dict[str, Any]]:
        for c in self._cards:
            if c["id"] == card_id:
                return dict(c)
        return None

    def active(self) -> Optional[Dict[str, Any]]:
        return self.get(self._active_id) or (dict(self._cards[0]) if self._cards else None)

    # ---------------------------------------------------------------- 写入
    def create(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        card = self._normalize({**payload, "id": payload.get("id") or str(uuid.uuid4()),
                                "builtin": False})
        self._cards.append(card)
        self.persist()
        return card

    def update(self, card_id: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        for i, old in enumerate(self._cards):
            if old["id"] != card_id:
                continue
            if not isinstance(patch, dict) or not patch:
                return dict(old)
            # id 与 builtin 不允许被 patch 改掉：「内置卡始终存在」是这个功能的保证
            merged = _deep_merge(old, {k: v for k, v in patch.items()
                                       if k not in ("id", "builtin")})
            merged["id"] = old["id"]
            merged["builtin"] = old["builtin"]
            merged["createdAt"] = old.get("createdAt")
            self._cards[i] = self._normalize(merged)
            self.persist()
            return dict(self._cards[i])
        return None

    def remove(self, card_id: str) -> Dict[str, Any]:
        for i, c in enumerate(self._cards):
            if c["id"] != card_id:
                continue
            if c.get("builtin"):
                return {"ok": False, "error": "内置角色卡不能删除，可以复制一份再改。"}
            if len(self._cards) <= 1:
                return {"ok": False, "error": "至少要保留一张角色卡。"}
            self._cards.pop(i)
            if self._active_id == card_id:
                self._active_id = self._cards[0]["id"]
            self.persist()
            return {"ok": True}
        return {"ok": False, "error": "没找到这张角色卡。"}

    def duplicate(self, card_id: str) -> Optional[Dict[str, Any]]:
        src = self.get(card_id)
        if not src:
            return None
        copy = dict(src)
        copy["id"] = str(uuid.uuid4())
        copy["builtin"] = False
        copy["name"] = f"{src['name']} 副本"[:40]
        copy["createdAt"] = int(time.time() * 1000)
        card = self._normalize(copy)
        self._cards.append(card)
        self.persist()
        return card

    def set_active(self, card_id: str) -> Optional[Dict[str, Any]]:
        if not any(c["id"] == card_id for c in self._cards):
            return None
        self._active_id = card_id
        self.persist()
        return self.active()

    # ------------------------------------------------------- 导入 / 导出
    def import_json(self, raw: Any) -> Dict[str, Any]:
        """导入一张卡。接受两种格式：本项目导出的 JSON，或 SillyTavern 角色卡。"""
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
        except (TypeError, json.JSONDecodeError) as exc:
            return {"ok": False, "error": f"不是合法的 JSON：{exc}"}
        if not isinstance(data, dict):
            return {"ok": False, "error": "角色卡必须是一个 JSON 对象。"}
        if "name" not in data and "data" in data:
            data = self._from_silly_tavern(data)
        data.pop("id", None)
        card = self.create(data)
        return {"ok": True, "card": card}

    @staticmethod
    def _from_silly_tavern(raw: Dict[str, Any]) -> Dict[str, Any]:
        d = raw.get("data") or {}
        return {
            "name": d.get("name") or raw.get("name") or "导入的角色",
            "tagline": d.get("creator_notes") or "",
            "persona": d.get("description") or "",
            "speakingStyle": d.get("personality") or "",
            "greeting": d.get("first_mes") or "",
            "tags": list(d.get("tags") or []),
        }
