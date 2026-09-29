"""给历史规划补图（零网络）。

背景：必去景点如果匹配不到高德的真实景点记录，旧流程会退化成"只有坐标的占位点"——
没有实拍图、没有评分。用户看到的就是「这张卡片和地图上都没有图片」。
（根因见 retrieve_skill._find_attraction 与 amap.resolve_region 的说明；
新生成的规划已经修掉了。）

已经存进本地的旧规划没法重新联网补图，但它们**自己就带着候选池**
（景点/餐厅/酒店的备选列表，那些记录都有实拍图）。所以这里只在同一份规划内部
按名字包含关系找对应记录，补上图片（顺带补评分与简介）：

- 不联网、不改坐标、不动行程顺序、不改预算；
- 找不到对应记录就原样保留（宁可缺图，也不塞一张不相干的图）。
"""
from typing import Any, Dict, List, Optional


def _pools(plan: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    """把同一份规划里的候选池整理成「名字 → 记录」，只收带图的。"""
    by_name: Dict[str, Dict[str, Any]] = {}
    for key in ("attraction_options", "dining_options", "hotel_options"):
        for poi in plan.get(key) or []:
            if not isinstance(poi, dict):
                continue
            if not (poi.get("photos") or []):
                continue
            name = poi.get("name") or ""
            if name:
                by_name.setdefault(name, poi)
    return by_name


def _match(name: str, by_name: Dict[str, Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """先全等，再互相包含（「长江澳」↔「长江澳风力发电景观区」）。"""
    if not name:
        return None
    hit = by_name.get(name)
    if hit is not None:
        return hit
    for pool_name, poi in by_name.items():
        if len(name) >= 2 and (name in pool_name or pool_name in name):
            return poi
    return None


def _fill(poi: Dict[str, Any], by_name: Dict[str, Dict[str, Any]]) -> bool:
    """给一个点补上图片/评分/简介；补到了返回 True。"""
    if not isinstance(poi, dict) or (poi.get("photos") or []):
        return False
    source = _match(poi.get("name") or "", by_name)
    if source is None:
        return False
    poi["photos"] = list(source.get("photos") or [])
    if not poi.get("rating"):
        poi["rating"] = source.get("rating")
    if not poi.get("description"):
        poi["description"] = source.get("description")
    return True


def backfill_plan_photos(plan: Dict[str, Any]) -> Dict[str, Any]:
    """就地补图并返回同一份规划（含每日时间轴与当晚酒店）。"""
    by_name = _pools(plan)
    if not by_name:
        return plan
    for day in plan.get("daily_plans") or []:
        for item in day.get("timeline") or []:
            _fill(item.get("poi") or {}, by_name)
        _fill(day.get("hotel") or {}, by_name)
    return plan


def _missing(plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    """还没图的点（时间轴 + 当晚酒店）。"""
    out: List[Dict[str, Any]] = []
    for day in plan.get("daily_plans") or []:
        for item in day.get("timeline") or []:
            poi = item.get("poi") or {}
            if isinstance(poi, dict) and not (poi.get("photos") or []):
                out.append(poi)
        hotel = day.get("hotel") or {}
        if isinstance(hotel, dict) and not (hotel.get("photos") or []):
            out.append(hotel)
    return out


def enrich_missing_photos(
    plan: Dict[str, Any], amap: Any = None, limit: int = 6
) -> Dict[str, Any]:
    """仍然没图的点，按名字去高德查一次（最多 limit 个）。

    为什么值得联网：旧规划里存的就是"只有坐标的占位点"，它们自带的候选池里
    根本没有对应记录（当年检索范围就没覆盖到，例如目的地被缩成了上城区）。

    护栏有两条，宁可补不上也不塞错图：
    1. 名字必须互为子串（「青山湖景区」↔「青山湖景区秀水公园」）；
    2. 有坐标时，取离该点坐标最近的命中——所以不会把南昌的青山湖塞给杭州的青山湖。
    查不到 / 网络失败都只是少一张图，不影响这份规划本身。
    """
    targets = _missing(plan)
    if not targets:
        return plan
    if amap is None:
        from ..services.amap import AmapClient

        amap = AmapClient()
    from .scoring import haversine
    from .retrieve_skill import ATTRACTION_TYPES, _to_poi

    # 先按这份规划的目的地查（范围对得上），再退回不限城市。
    # 实测：只按名字不限城市时，高德会把「青山湖景区」答成南昌青山湖那一堆，
    # 加上目的地范围才回得到杭州临安的那条。
    destination = ((plan.get("user_preference") or {}).get("destination") or "").strip()
    scopes = [destination, ""] if destination else [""]

    for poi in targets[:limit]:
        name = poi.get("name") or ""
        if len(name) < 2:
            continue
        location = poi.get("location") or {}
        lat, lng = location.get("lat"), location.get("lng")
        has_coords = (
            isinstance(lat, (int, float)) and isinstance(lng, (int, float)) and lat and lng
        )
        for scope in scopes:
            try:
                hits = amap.search_poi(name, scope, types=ATTRACTION_TYPES, offset=20)
            except Exception:
                continue
            candidates = [_to_poi(h) for h in hits if h.get("location")]
            related = [
                p for p in candidates
                if name == p.name or name in p.name or p.name in name
            ]
            if not related:
                continue
            best = (
                min(related, key=lambda p: haversine(p.location.lat, p.location.lng, lat, lng))
                if has_coords
                else related[0]
            )
            if best.photos:
                poi["photos"] = list(best.photos)
                if not poi.get("rating"):
                    poi["rating"] = best.rating
                if not poi.get("description"):
                    poi["description"] = best.description
                break
    return plan
