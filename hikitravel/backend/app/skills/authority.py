"""权威名录：国家级 5A 景区名单（一次性导入，全国覆盖）。

为什么需要它：高德给的是"实时 POI"，但没有"这个景点是国家级景区"这种**权威标签**。
有了名单，系统就能把西湖、故宫这类地方标出来，并在排序上给一点倾斜。

数据来源与口径（重要，别当成完整权威名单）：

- 名单来自维基百科「国家5A级旅游景区」条目（抓取于 2026-09，共 256 条）；
- 它只是**演示种子**——完整的权威名单应以文旅部公告为准，
  用 `scripts/import_authority.py` 把官方名单导成同一格式的 JSON 即可；
- 匹配用"互相包含"而不是"完全相等"：高德的名字常带后缀
  （「杭州西湖风景名胜区」 vs 名单里的「西湖」），两边互相包含就算命中。

零外部调用：纯本地文件 + 内存查表（进程内只读一次）。
文件缺失时返回空集合，**不影响主流程**（只是少了这点倾斜）。
"""
import json
from functools import lru_cache
from pathlib import Path
from typing import Optional, Set

#: 名单放在 app 包内，随应用一起分发；找不到时再退回 backend/data/
_CANDIDATES = (
    Path(__file__).resolve().parent.parent / "data" / "authority.json",
    Path(__file__).resolve().parent.parent.parent / "data" / "authority.json",
)


@lru_cache(maxsize=1)
def authority_names() -> Set[str]:
    """读入权威名录；文件缺失或格式不对时返回空集合。"""
    payload = None
    for path in _CANDIDATES:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            break
        except (OSError, ValueError):
            continue
    if payload is None:
        return set()
    names = payload.get("names")
    if not isinstance(names, list):
        return set()
    return {n.strip() for n in names if isinstance(n, str) and len(n.strip()) >= 2}


@lru_cache(maxsize=4096)
def match_authority(name: str) -> Optional[str]:
    """这个景点名是否命中权威名录；命中返回名录里的名字（取最长的那个）。"""
    target = (name or "").strip()
    if len(target) < 2:
        return None
    hits = [
        official
        for official in authority_names()
        if official in target or target in official
    ]
    return max(hits, key=len) if hits else None
