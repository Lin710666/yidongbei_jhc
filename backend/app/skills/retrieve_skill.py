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
#
# ★ 分成两张表：**能当景点排的** 与 **只能进餐饮池的**。
#
# 原来只有一张表，而且「美食」映射到 ["美食街", "特色餐厅"]，搜出来的结果
# 又一律被标成「景点」（见下面 _to_poi(item) 的默认参数）—— 于是用户一勾
# "美食"，系统就把餐厅排进下午的观光位，还给它盖上景点专属的贴士
# 「热门景点建议通过官方渠道提前预约，以景区公告为准」。实测抓到的：
# 成都方案里「马旺子·川小馆(成都太古里店)」被标成景点。
#
# 现在：「美食」的关键词**全部**只补餐饮池，不进景点池；其余关键词搜到的结果
# 还要再过一遍高德自己的类型字段（_classify_by_amap_type），餐饮类的自动挪走。
#
# 为什么「美食街」也挪走了：第一版把它留在景点池，理由是"商圈步行街算逛的地方"。
# 实测结果：勾「美食」的成都方案里，4 天排了 6 条美食街当景点
# （美食休闲 / 龙潭湾文化美食街区 / 绿城川菜小镇美食街 / 熊猫集市美食街…），
# 整个行程变成"一天到晚逛美食街"。用户勾"美食"要的是**吃得好 + 顺便看看这个城市**，
# 不是把美食街当名胜。所以景点池改用兜底关键词去搜真正的景点
# （见 FALLBACK_ATTRACTION_KEYWORD）。
PREFERENCE_KEYWORDS: Dict[str, List[str]] = {
    "人文历史": ["历史古迹", "博物馆", "寺庙"],
    "自然风光": ["公园", "湿地", "自然风景"],
    "娱乐": ["主题乐园", "演出"],
}

#: 这些关键词搜出来的东西只能喂餐饮池，绝不进景点池
DINING_KEYWORDS: Dict[str, List[str]] = {
    "美食": ["美食街", "特色餐厅", "小吃"],
}

#: 兴趣关键词一条景点都搜不出来时的兜底查询。
#:
#: 为什么需要：勾「美食」的用户在 PREFERENCE_KEYWORDS 里没有任何景点关键词，
#: 景点池会是空的 —— 那行程就只剩"吃饭"，一个能去的地方都没有。
#: 这时用这个通用词补一批真正的景点，保证"吃 + 逛"两件事都在。
#:
#: 为什么是「热门景点」而不是「景点」：实测同一个城市两种查询差很远 ——
#:   「景点」     → 成都金融城双子塔 / 交子公园 / 桂溪生态公园（全是新区的公园写字楼）
#:   「热门景点」 → 东郊记忆 / 人民公园 / 文殊院 / 成都武侯祠博物馆 /
#:                  成都大熊猫繁育研究基地 / 锦里古街  ← 这才是"来成都该去的"
#: 高德按相关性排序，「景点」这种宽词会把新区的 POI 也顶上来了。
FALLBACK_ATTRACTION_KEYWORD = "热门景点"

#: 名字里出现这些词的，一律当餐厅 —— 不管高德怎么标。
#:
#: 为什么要这道兜底：高德的类型字段**也会错**。实测「八潮天燚天妇罗」的
#: type 是 `风景名胜;风景名胜;风景名胜`（typecode 110200），照类型判就是景点，
#: 于是被排进了上午的观光位。名字明明是家天妇罗店。
#: 判名称不判类型，这里只做"往回捞"—— 捞出餐厅不算错，把真景点误判成餐厅才会。
_NAME_DINING_HINTS = (
    "餐厅", "菜馆", "火锅", "烤肉", "烧烤", "小吃", "美食", "料理",
    "面馆", "酒家", "食府", "家常菜", "川菜", "湘菜", "粤菜", "日料",
    "西餐", "咖啡", "茶楼", "天妇罗", "烧肉", "串串", "冒菜", "汤锅",
)


def _looks_like_dining(name: Any) -> bool:
    """名字里像不像吃饭的地方（用于纠正高德类型标错的情况）。"""
    n = _as_text(name)
    return any(h in n for h in _NAME_DINING_HINTS)


def _as_price(value: Any) -> Optional[float]:
    """把高德的 `biz_ext.cost` 收敛成 float 或 None。

    高德这个字段的类型**完全不固定**（实测）：餐厅是 "133.00"（字符串），
    非餐饮类是 `[]`（空数组），偶尔还会有带单位的串。直接 float() 会炸，
    而它在 `_to_recommendation` 里原来是**没有 try/except 的** ——
    换句话说，只要高德哪天给某个餐厅返回了非数字，整条 /api/plan 就 500。
    统一在这里收口。
    """
    if value is None:
        return None
    if isinstance(value, (list, tuple, dict)):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f > 0 else None


def _classify_by_amap_type(amap_type: Any, default: str = "景点") -> str:
    """按高德自己的 type 字段判定这是景点 / 餐厅 / 住宿。

    高德的 `type` 长这样（实测）：
        餐饮服务;中餐厅;四川菜(川菜)   → 餐厅
        住宿服务;宾馆酒店;...          → 住宿
        风景名胜;公园;...              → 景点
        购物服务;特色商业街;步行街      → 景点（商圈是可以逛的地方）

    为什么必须看它、而不是看我们搜的关键词：关键词只说明"我们搜了什么"，
    类型才说明"这到底是个什么地方"。搜"美食街"会同时返回步行街和餐厅，
    只看关键词分不干净。
    """
    t = _as_text(amap_type)
    if "餐饮" in t or "美食" in t:
        return "餐厅"
    if "住宿" in t or "宾馆" in t or "酒店" in t:
        return "住宿"
    return default


def _parse_location(loc: str) -> Location:
    """高德返回的 "lng,lat" 字符串 -> Location。"""
    lng, lat = loc.split(",")
    return Location(lat=float(lat), lng=float(lng))


def _as_text(value: Any) -> str:
    """把高德返回的字段收敛成字符串。

    为什么必须有这个：高德的字段类型不固定 —— `address`、`cityname`、`adname`
    这些在有些 POI / 有些城市上返回的是**数组**（实测苏州的餐厅就是
    `address: []`），而我们的 POI 模型这几个字段都声明成 str，
    于是 pydantic 直接抛 ValidationError，整条 /api/plan 变成 500。

    这个 bug 很阴：同样的请求在杭州没事、换苏州就 500，看起来像"某个城市不支持"，
    其实是响应字段类型不同。所以这里统一收口，宁可转成空串也不要炸。
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return "、".join(_as_text(v) for v in value if v not in (None, ""))
    return str(value)


def _to_poi(item: Dict[str, Any], poi_type: str = "景点") -> POI:
    """高德 POI 结果 -> 内部 POI 模型。"""
    biz_ext = item.get("biz_ext") or {}
    price = _as_price(biz_ext.get("cost"))
    tips = f"参考消费约 {price:.0f} 元" if price else ""
    return POI(
        name=_as_text(item.get("name")),
        type=poi_type,
        location=_parse_location(item["location"]),
        city=_as_text(item.get("cityname")) or _as_text(item.get("adname")),
        description=_as_text(item.get("address")),
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
    price = _as_price(biz_ext.get("cost"))
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
        name=_as_text(item.get("name")),
        type=kind,
        location=_parse_location(item["location"]),
        city=_as_text(item.get("cityname")) or _as_text(item.get("adname")),
        description=_as_text(item.get("address")),
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
        # 注入进来的检索器（测试用）优先；否则按城市各建一个。
        self._injected = retriever
        self._retrievers: Dict[str, Retriever] = {}

    def _retriever_for(self, city: str) -> Retriever:
        """按目的地拿检索器（每个城市一个，带缓存）。

        为什么要按城市分：知识库是按城市标注的（见 repository.py 的 city 说明），
        检索器在构造时就把知识筛成「这个城市的 + 全国通用的」。
        共用一个实例的话，第一次查杭州之后再查成都，索引还是杭州那份 ——
        这正是"去成都玩却给杭州贴士"的原因之一。
        """
        if self._injected is not None:
            return self._injected
        r = self._retrievers.get(city)
        if r is None:
            r = Retriever(city=city)
            self._retrievers[city] = r
        return r

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        pref = ctx["preference"]
        city = pref.destination

        # 1. 实时天气（多拉 3 天，覆盖 start_date 相对今天最多 3 天的偏移；
        #    高德 extensions=all 最多返回未来 4 天，超出则无法预报）
        ctx["weather"] = self.weather_svc.forecast(city, pref.duration_days + 3)

        # 2. 景点 POI（按兴趣关键词搜索，去重）
        #
        # ★ 每个结果都要过一遍「这到底是个什么地方」再决定进哪个池子。
        #   原来是一律 append(_to_poi(item))，默认 type="景点" ——
        #   勾「美食」时搜到的餐厅就全成了景点（实测：成都方案里
        #   「马旺子·川小馆(成都太古里店)」被排进下午观光位，
        #   还附带景点专属的"提前预约"贴士）。
        attractions: List[POI] = []
        dining_extra: List[POI] = []      # 关键词搜到、且确实是餐饮的
        seen: set[str] = set()
        for tag in pref.preferences:
            # 记住每个关键词是"找景点用的"还是"找吃的用的" —— 分流要靠它。
            # 只按高德类型分不够：「美食街」搜出来的是「购物服务;特色商业街」，
            # 类型上不算餐饮，于是照样落进景点池（第一版就是这么漏的，
            # 成都 4 天排了 6 条美食街当景点）。
            pairs = ([(kw, "attr") for kw in PREFERENCE_KEYWORDS.get(tag, [])]
                     + [(kw, "dine") for kw in DINING_KEYWORDS.get(tag, [])])
            for kw, src in pairs:
                for item in self.amap.search_poi(kw, city):
                    # 用高德 POI id 去重：同一地点在不同关键词下可能返回不同名称，id 才是唯一键
                    pid = item.get("id") or item.get("name", "")
                    if not pid or pid in seen:
                        continue
                    seen.add(pid)
                    kind = _classify_by_amap_type(item.get("type"))
                    # 高德的类型也会错（实测「八潮天燚天妇罗」被标成"风景名胜"），
                    # 所以名字像吃饭的地方一律按餐厅处理。
                    if kind != "住宿" and _looks_like_dining(item.get("name")):
                        kind = "餐厅"
                    if src == "dine":
                        # 用"吃"的关键词搜出来的：只收真正的餐厅，
                        # 商圈 / 步行街 / 夜市一律不要 —— 它们既不是景点，
                        # 也不该占掉一顿饭的位置（用户要的是吃，不是逛商场）。
                        if kind == "餐厅":
                            dining_extra.append(_to_poi(item, poi_type="餐厅"))
                        continue
                    if kind == "餐厅":
                        dining_extra.append(_to_poi(item, poi_type="餐厅"))
                    elif kind == "住宿":
                        continue          # 景点关键词搜到酒店，两个池子都不要
                    else:
                        attractions.append(_to_poi(item))

        # 2b. 兜底：一条景点都没搜到（典型情况是用户只勾了「美食」，
        #     而美食的关键词全在 DINING_KEYWORDS 里），就用通用词补一批真正的景点。
        #     不补的话行程里只剩"吃饭"，一个能去的地方都没有。
        if not attractions:
            for item in self.amap.search_poi(FALLBACK_ATTRACTION_KEYWORD, city):
                pid = item.get("id") or item.get("name", "")
                if not pid or pid in seen:
                    continue
                if _classify_by_amap_type(item.get("type")) != "景点":
                    continue          # 兜底也要过滤，别再混进餐厅
                if _looks_like_dining(item.get("name")):
                    continue          # 名字像饭馆的（高德类型可能标错）也不要
                seen.add(pid)
                attractions.append(_to_poi(item))

        # 3. 餐饮 / 酒店 POI（含按价位分档推荐，给用户更多选择）
        restaurant_items = self.amap.search_poi("餐厅", city)
        restaurants = [_to_poi(item, poi_type="餐厅") for item in restaurant_items]
        # 兴趣关键词顺带搜到的餐厅也并进餐饮池 —— 它们本来就是餐厅，
        # 只是"怎么被搜出来的"不一样。放在景点池里是错的。
        if dining_extra:
            have = {p.name for p in restaurants}
            restaurants = restaurants + [p for p in dining_extra if p.name not in have]
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
        #
        # 查询里**不再拼城市名**：城市过滤已经由「按城市取知识」那一步做了
        # （见 _retriever_for / Retriever.__init__）。拼进来反而会拉高低相关
        # 条目的分数 —— 原来就是这么把杭州的贴士送进成都方案的。
        rag_query = " ".join(pref.preferences) or city
        ctx["rag_tips"] = self._retriever_for(city).search(rag_query, top_k=5)

        ctx["attractions"] = attractions
        # 景点备选池：完整去重后的景点列表（含必去），供前端编辑时「换景点」
        ctx["attraction_options"] = attractions
        ctx["restaurants"] = restaurants
        return ctx
