"""Skill2：多源数据获取与检索（数据层）。

调用真实外部 API 与本地 RAG，收集规划所需数据：
- 天气：高德天气 API（实时）
- 景点 / 餐饮 POI：高德 POI 搜索（实时，含参考票价 biz_ext.cost）
- 本地知识：RAG 检索器（慢变编辑类知识）

说明：门票价 / 酒店房价等时效性数据全部来自 API，不在本地硬编码。
"""
from typing import Any, Dict, List, Optional

from ..models.plan import Location, POI
from ..rag.retriever import Retriever
from ..services.amap import AmapClient
from ..services.weather import WeatherService
from .base import Skill

# 兴趣导向 -> 高德搜索关键词映射
PREFERENCE_KEYWORDS: Dict[str, List[str]] = {
    "人文历史": ["历史古迹", "博物馆", "寺庙"],
    "自然风光": ["公园", "湿地", "自然风景"],
    "美食": ["美食街", "特色餐厅"],
    "娱乐": ["主题乐园", "演出"],
}


def _parse_location(loc: str) -> Location:
    """高德返回的 "lng,lat" 字符串 -> Location。"""
    lng, lat = loc.split(",")
    return Location(lat=float(lat), lng=float(lng))


def _to_poi(item: Dict[str, Any], poi_type: str = "景点") -> POI:
    """高德 POI 结果 -> 内部 POI 模型。"""
    biz_ext = item.get("biz_ext") or {}
    cost = biz_ext.get("cost")
    price = float(cost) if cost else None
    tips = f"参考消费约 {price:.0f} 元" if price else ""
    return POI(
        name=item.get("name", ""),
        type=poi_type,
        location=_parse_location(item["location"]),
        city=item.get("cityname") or item.get("adname") or "",
        description=item.get("address", ""),
        tips=tips,
        price=price,
    )


def _tier_cost(cost: Optional[float]) -> str:
    """人均消费 -> 价位档。"""
    if cost is None:
        return "中档"
    if cost <= 50:
        return "经济"
    if cost <= 150:
        return "中档"
    return "高档"


def _tier_hotel(rating) -> str:
    """酒店评分 -> 价位档（高德无实时房价，用评分近似档次）。"""
    try:
        r = float(rating)
    except (TypeError, ValueError):
        return "中档"
    if r >= 4.7:
        return "高档"
    if r >= 4.3:
        return "中档"
    return "经济"


def _to_recommendation(item: Dict[str, Any], kind: str) -> POI:
    """构建餐饮/酒店推荐项：带价位档 + 参考价/评分。"""
    biz_ext = item.get("biz_ext") or {}
    cost = biz_ext.get("cost")
    price = float(cost) if cost else None
    rating = item.get("rating") or biz_ext.get("rating")
    check_in = ""
    check_out = ""
    if kind == "餐厅":
        tier = _tier_cost(price)
        tips = f"人均约 ¥{price:.0f}" if price else "人均待查"
    else:  # 住宿
        tier = _tier_hotel(rating)
        # 高德无实时房价，按档次给每晚估算价，供预算估算与用户选定后重算
        price = {"经济": 150, "中档": 350, "高档": 600}.get(tier, 350)
        tips = (f"评分 {rating}" if rating else "评分待查") + f" · 约 ¥{price}/晚"
        # 入住/退房时间：高德无逐店实时数据，用行业通行惯例，实际以酒店为准
        check_in = "14:00"
        check_out = "12:00"
    return POI(
        name=item.get("name", ""),
        type=kind,
        location=_parse_location(item["location"]),
        city=item.get("cityname") or item.get("adname") or "",
        description=item.get("address", ""),
        tips=tips,
        price=price,
        tier=tier,
        check_in=check_in,
        check_out=check_out,
    )


def _tiered(items: List[Dict[str, Any]], kind: str) -> List[POI]:
    """按价位分档，每档最多取 3 个，返回「经济→中档→高档」排序的推荐列表。"""
    buckets: Dict[str, List[POI]] = {"经济": [], "中档": [], "高档": []}
    for item in items:
        poi = _to_recommendation(item, kind)
        buckets[poi.tier].append(poi)
    result: List[POI] = []
    for tier in ("经济", "中档", "高档"):
        result.extend(buckets[tier][:3])
    return result


class RetrieveSkill(Skill):
    """多源数据获取与检索。"""

    name = "retrieve"
    description = "调用天气/POI API 与本地 RAG，收集规划所需数据"

    def __init__(
        self,
        amap: AmapClient | None = None,
        weather: WeatherService | None = None,
        retriever: Retriever | None = None,
    ):
        self.amap = amap or AmapClient()
        self.weather_svc = weather or WeatherService()
        self.retriever = retriever or Retriever()

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        pref = ctx["preference"]
        city = pref.destination

        # 1. 实时天气（多拉 3 天，覆盖 start_date 相对今天最多 3 天的偏移；
        #    高德 extensions=all 最多返回未来 4 天，超出则无法预报）
        ctx["weather"] = self.weather_svc.forecast(city, pref.duration_days + 3)

        # 2. 景点 POI（按兴趣关键词搜索，去重）
        attractions: List[POI] = []
        seen: set[str] = set()
        for tag in pref.preferences:
            for kw in PREFERENCE_KEYWORDS.get(tag, []):
                for item in self.amap.search_poi(kw, city):
                    # 用高德 POI id 去重：同一地点在不同关键词下可能返回不同名称，id 才是唯一键
                    pid = item.get("id") or item.get("name", "")
                    if pid and pid not in seen:
                        seen.add(pid)
                        attractions.append(_to_poi(item))

        # 3. 餐饮 / 酒店 POI（含按价位分档推荐，给用户更多选择）
        restaurant_items = self.amap.search_poi("餐厅", city)
        restaurants = [_to_poi(item, poi_type="餐厅") for item in restaurant_items]
        ctx["dining_options"] = _tiered(restaurant_items, "餐厅")
        hotel_items = self.amap.search_poi("酒店", city)
        ctx["hotel_options"] = _tiered(hotel_items, "住宿")

        # 4. 特别想去的景点（必去）：优先复用已搜到的 POI，否则按名称单独搜索；
        #    解析失败用占位 POI（无坐标）保证仍出现在规划中
        must_pois: List[POI] = []
        for name in pref.must_visit:
            matched = next(
                (p for p in attractions if p.name == name or name in p.name or p.name in name),
                None,
            )
            if matched:
                must_pois.append(matched)
                continue
            hits = self.amap.search_poi(name, city)
            if hits:
                must_pois.append(_to_poi(hits[0]))
            else:
                must_pois.append(
                    POI(
                        name=name, type="景点", location=Location(lat=0, lng=0), city=city,
                        tips="未能定位坐标，建议到地后地图搜索",
                    )
                )
        ctx["must_visit_pois"] = must_pois
        # 必去景点置顶，规划按顺序优先选取
        attractions = must_pois + [
            p for p in attractions if p.name not in {m.name for m in must_pois}
        ]

        # 5. 本地 RAG 知识（防坑 / 拍照 / 动线）
        rag_query = " ".join(pref.preferences) + " " + city
        ctx["rag_tips"] = self.retriever.search(rag_query, top_k=5)

        ctx["attractions"] = attractions
        # 景点备选池：完整去重后的景点列表（含必去），供前端编辑时「换景点」
        ctx["attraction_options"] = attractions
        ctx["restaurants"] = restaurants
        return ctx
