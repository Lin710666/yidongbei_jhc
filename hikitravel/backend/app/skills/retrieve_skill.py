"""Skill2：多源数据获取与检索（数据层）。

调用真实外部 API，收集规划所需数据：
- 天气：高德天气 API（实时）
- 景点 / 餐饮 / 酒店 POI：高德 POI 搜索（实时，含参考票价 biz_ext.cost）

推荐排序（**不是只看评分**，公式与权重集中在 skills/scoring.py）：
- 景点综合分     = 热门程度分 × 权重 + 评分 × 权重
- 餐厅/酒店综合分 = 距上一景点 × 权重 + 距下一景点 × 权重 + 评分 × 权重

原则（与用户对齐）：
- 不设静默参数：目的地没填、或高德认不出来，直接结束流程并提示用户，
  绝不猜一个城市继续算（那样会搜出全国结果，等于给用户假数据）。
- 门票价 / 酒店房价等时效性数据全部来自 API，本地不硬编码。
"""
import re
from typing import Any, Dict, List, Optional, Sequence

from ..models.plan import Location, POI
from ..services.amap import AmapClient
from ..services.weather import WeatherService
from ..services.web_search import WebSearchClient
from .base import Skill
from .authority import match_authority
from .constraints import DIET_SEARCH_KEYWORDS, restaurant_excluded
from .geo_gate import GEO_GATE_MIN_CANDIDATES, apply_gate
from .spot_filter import split_non_attractions
from .dedupe import dedupe_attractions, same_spot
from .errors import MissingRequiredInfoError
from .scoring import (
    attraction_rank,
    distance_km,
    haversine,
    local_specialty_keywords,
    option_score,
    popularity_raw,
)

# 兴趣导向 -> 高德 POI 分类码（types）。用分类码而非关键词，避免「公园」搜出餐厅、
# 「博物馆」搜出商场。
#   110101 公园 | 110103 植物园 | 110200 风景名胜(含 110201 世界遗产/110202 国家级)
#   110205 寺庙道观/110208 海滩/110209 观景点 | 110204 纪念馆
#   140100 博物馆 | 140200 展览馆 | 140400 美术馆 | 140600 科技馆 | 140700 天文馆 | 140800 文化宫
#   080501 游乐园/主题乐园 | 080600 影剧院 | 080401 度假村
#
# 注意：影剧院(080600) 与 文化宫(140800) **只放在 ATTRACTION_TYPES 里**，
# 不放进兴趣分类码——实测「西航国际影城」（080601 电影院）、「西湖区文体中心」
# （140800 文化宫）就是这样被"推荐"成景点的。用户自己点名要去时照样能解析
# （ATTRACTION_TYPES 里保留），只是不再由系统主动推荐；另见 skills/spot_filter.py。
PREFERENCE_TYPES: Dict[str, str] = {
    "人文历史": "140100|140200|140400|140600|140700|110201|110204|110205",
    "自然风光": "110101|110103|110200|110208|110209",
    "娱乐": "080501|080401",
    # 「美食」不产生景点，走独立餐厅检索，避免餐馆混进景点池
}

#: 「真正是景点」的高德分类码合集，供「必去景点」下拉与解析使用。
#:
#: 为什么必须按类型筛：不筛的话，同一个关键词「长江澳」会返回
#: 「长江澳」（自然地名·海湾海峡，坐标是海湾中心 → 地图上落进海里）、
#: 以及 3 个停车场（东停车场 / 风车田沙滩停车场 / 地面停车场）。
#: 实测加上这组分类码之后，同样的词返回的全是风景名胜，评分与实拍图都齐全。
ATTRACTION_TYPES: str = (
    "110000|110100|110101|110103|110200|110201|110202|110203|110204|110205"
    "|110206|110207|110208|110209|140100|140200|140400|140600|140700|140800"
)

def _filter_diet(pool: List[POI], restrictions: List[str]) -> tuple[List[POI], List[str]]:
    """按饮食禁忌排除餐厅，返回 (保留的, 被排除的说明)。

    高德不提供"是否清真 / 是否含海鲜"这类属性，只有店名可用，所以做得保守：
    **命中店名关键词才排除**（宁可少给几家，也不能给过敏的人排海鲜馆）；
    判不出来的保留，由体检如实说明这个口径。
    """
    if not restrictions:
        return list(pool), []
    kept: List[POI] = []
    dropped: List[str] = []
    for poi in pool:
        reason = restaurant_excluded(poi.name, restrictions)
        if reason:
            dropped.append(f"{poi.name}（{reason}）")
            continue
        kept.append(poi)
    return kept, dropped


def _to_rating(value: Any) -> Optional[float]:
    """高德评分字段可能是字符串 '4.7'，也可能是空 list [] 或缺失，统一转 float。"""
    try:
        r = float(value)
    except (TypeError, ValueError):
        return None
    return r if r > 0 else None


def _text(value: Any) -> str:
    """高德字段偶尔返回空 list []（而非空字符串），统一转安全字符串。"""
    return value if isinstance(value, str) else ""


def _photos(item: Dict[str, Any]) -> List[str]:
    """取高德 POI 的图片地址。

    统一升级成 https：应用可能部署在 https 下，http 图片会被浏览器
    当成混合内容拦掉（实测该图床两种协议都支持，所以直接换掉更稳）。
    """
    out: List[str] = []
    for photo in item.get("photos") or []:
        url = photo.get("url") if isinstance(photo, dict) else None
        if not isinstance(url, str) or not url.startswith("http"):
            continue
        out.append(url.replace("http://", "https://", 1))
        if len(out) >= 4:
            break
    return out


def _open_time(item: Dict[str, Any]) -> str:
    """高德营业时间：优先 biz_ext.open_time（如 10:00-22:00），退回 opentime2。"""
    biz_ext = item.get("biz_ext") or {}
    for key in ("open_time", "opentime2"):
        value = biz_ext.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _tags(item: Dict[str, Any]) -> List[str]:
    """招牌菜与标签：高德 keytag（主标签）+ atag（招牌菜列表），去重去空。"""
    out: List[str] = []
    seen: set = set()
    for field in ("keytag", "atag"):
        raw = item.get(field)
        if not isinstance(raw, str):
            continue
        for word in re.split(r"[,，、;；|]", raw):
            word = word.strip()
            if len(word) < 2 or word in seen:
                continue
            seen.add(word)
            out.append(word)
    return out[:12]


def _cuisine(item: Dict[str, Any]) -> str:
    """菜系：高德 type 的第三级（如「餐饮服务;中餐厅;海鲜酒楼」→ 海鲜酒楼）。"""
    parts = [p.strip() for p in str(item.get("type") or "").split(";") if p.strip()]
    return parts[-1] if parts else ""




def _parse_location(loc: str) -> Location:
    """高德返回的 "lng,lat" 字符串 -> Location。"""
    lng, lat = loc.split(",")
    return Location(lat=float(lat), lng=float(lng))


def _to_poi(item: Dict[str, Any], poi_type: str = "景点") -> POI:
    """高德 POI 结果 -> 内部 POI 模型。"""
    biz_ext = item.get("biz_ext") or {}
    cost = biz_ext.get("cost")
    price = float(cost) if cost else None
    rating = _to_rating(biz_ext.get("rating"))
    tips = f"参考消费约 {price:.0f} 元" if price else ""
    # 命中权威名录就标出来（零外部调用、纯本地查表）
    official = match_authority(_text(item.get("name")))
    if official:
        tips = ("国家级5A景区" + ("；" + tips if tips else ""))
    return POI(
        name=_text(item.get("name")),
        type=poi_type,
        location=_parse_location(item["location"]),
        city=_text(item.get("cityname")) or _text(item.get("adname")),
        description=_text(item.get("address")),
        tips=tips,
        price=price,
        rating=rating,
        photos=_photos(item),
        # 这三个字段高德本来就给了，以前直接丢掉：
        open_time=_open_time(item),
        tags=_tags(item),
        cuisine=_cuisine(item),
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
        # 高德不提供实时房价，按档次给每晚估算价，便于预算估算与用户选定后重算
        price = {"经济": 150, "中档": 350, "高档": 600}.get(tier, 350)
        tips = (f"评分 {rating}" if rating else "评分待查") + f" · 约 ¥{price}/晚"
        # 入住/退房时间：高德无逐店实时数据，用行业通行惯例，实际以酒店为准
        check_in = "14:00"
        check_out = "12:00"
    return POI(
        name=_text(item.get("name")),
        type=kind,
        location=_parse_location(item["location"]),
        city=_text(item.get("cityname")) or _text(item.get("adname")),
        description=_text(item.get("address")),
        tips=tips,
        price=price,
        rating=_to_rating(rating),
        tier=tier,
        check_in=check_in,
        check_out=check_out,
        photos=_photos(item),
        open_time=_open_time(item),
        tags=_tags(item),
        cuisine=_cuisine(item),
    )


def _search_multi(
    amap: AmapClient, keywords: str, city: str, offset: int = 25, pages: int = 2
) -> List[Dict[str, Any]]:
    """翻页搜索并按高德 POI id 去重，聚合多页结果（扩大餐厅/酒店候选池）。"""
    items: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for page in range(1, pages + 1):
        for item in amap.search_poi(keywords, city, offset=offset, page=page):
            pid = item.get("id")
            if pid and pid not in seen:
                seen.add(pid)
                items.append(item)
    return items


def _neighbors_by_distance(
    poi: POI, anchors: Sequence[POI], count: int = 2
) -> List[Optional[POI]]:
    """取离该点最近的若干个景点（按直线距离）；坐标缺失的点不参与。"""
    pairs = [(distance_km(poi, a), a) for a in anchors]
    pairs = [(d, a) for d, a in pairs if d is not None]
    pairs.sort(key=lambda pair: pair[0])
    result: List[Optional[POI]] = [a for _, a in pairs[:count]]
    while len(result) < count:  # 景点不足时补 None，交给 option_score 自动降权重
        result.append(None)
    return result


def _option_prescore(poi: POI, anchors: Sequence[POI]) -> float:
    """检索阶段的餐厅 / 酒店综合分（近似版）。

    此阶段还没排出每日行程，因此用「行程景点集合里最近的两个景点」近似
    时间轴上的前后邻居：最近的当上一站，次近的当下一站。
    真正落到每天时间轴上的精确评分（当天真实前后邻居）由 Planner 组装时重算。
    """
    prev_poi, next_poi = _neighbors_by_distance(poi, anchors, 2)
    return option_score(poi, prev_poi, next_poi)


def _tiered(items: List[Dict[str, Any]], kind: str, anchors: Sequence[POI]) -> List[POI]:
    """按价位分档（经济→中档→高档），档内按综合分排序，每档最多取 10 个。

    分档是为了让用户在「换一家」时既能降级也能升级；
    档内排序用综合分（距离前后景点 + 评分），而不是只看评分。
    """
    buckets: Dict[str, List[POI]] = {"经济": [], "中档": [], "高档": []}
    for item in items:
        poi = _to_recommendation(item, kind)
        buckets[poi.tier].append(poi)
    result: List[POI] = []
    for tier in ("经济", "中档", "高档"):
        ranked = sorted(
            buckets[tier], key=lambda p: _option_prescore(p, anchors), reverse=True
        )
        result.extend(ranked[:10])
    return result


class RetrieveSkill(Skill):
    """多源数据获取与检索。"""

    name = "retrieve"
    description = "调用天气/POI API 与本地 RAG，收集规划所需数据"

    def __init__(
        self,
        amap: AmapClient | None = None,
        weather: WeatherService | None = None,
        search: WebSearchClient | None = None,
    ):
        self.amap = amap or AmapClient()
        self.weather_svc = weather or WeatherService()
        self.search = search or WebSearchClient()

    def _find_attraction(
        self, name: str, city: str, entry: Any, city_name: str = ""
    ) -> Optional[POI]:
        """按「景点分类码」找这个景点，返回带评分与实拍图的真实高德记录。

        为什么必须按分类码过滤：不筛类型时，「长江澳」返回的是
        「自然地名 · 海湾海峡」——它的坐标是海湾的几何中心，画在地图上就落在海里；
        同一批结果里还混着 3 个停车场。而且下拉候选本身不带图片，
        只有真实的景点记录才有评分与实拍图。

        有下拉坐标时，在多个同名命中里挑离它最近的那个：
        候选坐标不一定准，但至少给了大致方位。

        **检索范围从窄到宽试两次**（区县 → 父级城市），每一次都走同一套名字校验：
        实测踩过——目的地是「杭州市」但下拉那条候选的 adcode 落成了 330102（上城区）时，
        在「上城区」范围内搜「青山湖景区」（临安区）返回的是南昌青山湖那一堆无关记录，
        匹配失败 → 退化成没有图、没有评分的占位点，用户看到的就是"必去景点没有图片"。
        """
        def select(pois: List[POI]) -> Optional[POI]:
            # 只接受"名字确实是同一个地方"的命中：完全同名，或互为子串
            # （「雷峰塔」/「雷峰塔景区」）。
            #
            # 这里是**富集**，不是重新找地方：如果搜出来的都不是同一个地方，
            # 宁可返回 None 让调用方退回用户给的坐标，也不能挑一条最近的顶上去——
            # 那等于悄悄把用户想去的地方换成了别的地方（实测踩过：没有这道校验时，
            # 「九溪烟树」会被换成杭州候选池里离它最近的另一个景点）。
            exact = [p for p in pois if p.name == name]
            if exact:
                candidates = exact
            else:
                candidates = [p for p in pois if name in p.name or p.name in name]
                if not candidates:
                    return None
            if entry.has_location and entry.lat is not None and entry.lng is not None:
                return min(
                    candidates,
                    key=lambda p: haversine(
                        p.location.lat, p.location.lng, entry.lat, entry.lng
                    ),
                )
            return candidates[0]

        scopes = [city]
        if city_name and city_name != city:
            scopes.append(city_name)
        for scope in scopes:
            hits = self.amap.search_poi(name, scope, types=ATTRACTION_TYPES, offset=20)
            pois = [_to_poi(h) for h in hits if h.get("location")]
            if not pois:
                continue
            found = select(pois)
            if found is not None:
                return found
        return None

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        pref = ctx["preference"]

        # 0. 目的地必填：没填就结束流程并提示用户，不静默默认某个城市
        destination = (pref.destination or "").strip()
        if not destination:
            raise MissingRequiredInfoError(
                "请先告诉我目的地城市（例如「杭州」），我再为你规划行程。"
            )

        # 把目的地解析成高德认的「区县名 + 城市名」；解析不出来直接抛
        # AmapDestinationError，由 API 层提示用户确认目的地，绝不拿全国结果凑数。
        city, city_name = self.amap.resolve_region(destination, pref.destination_adcode)
        ctx["resolved_region"] = {
            "input": destination,
            "city": city,
            "city_name": city_name,
        }

        # 1. 实时天气（多拿 3 天：高德 extensions=all 最多返回未来 4 天）
        ctx["weather"] = self.weather_svc.forecast(city, pref.duration_days + 3)

        # 1.5 实时攻略检索（可选，默认关闭；没配搜索 API 就直接跳过）
        #    只带目的地，不带任何画像信息；结果只当"偏好提示"用，
        #    模型据此挑出来的名字仍要能在高德候选池里找到才算数。
        if self.search.enabled:
            notes = self.search.search(f"{destination} 必去 景点 攻略", limit=6)
            notes += self.search.search(f"{destination} 必吃 餐厅 本地人推荐", limit=4)
            ctx["web_notes"] = notes

        # 2. 景点 POI：按兴趣分类码搜索，计算综合分（热门程度 + 评分）后排序
        items_by_id: Dict[str, Dict[str, Any]] = {}
        hit_counts: Dict[str, int] = {}
        # 没填兴趣导向就搜全部类别，保证"没选也能出规划"。
        # 少了这一句，preferences 为空时这个循环一次都不执行，
        # 结果是规划里一个景点都没有——这也是后端一度把兴趣设成必填的原因。
        for tag in (pref.preferences or list(PREFERENCE_TYPES.keys())):
            types = PREFERENCE_TYPES.get(tag, "")
            if not types:
                continue
            for item in self.amap.search_poi(types=types, city=city, offset=25):
                pid = item.get("id") or item.get("name", "")
                if not pid:
                    continue
                if pid not in items_by_id:
                    items_by_id[pid] = item
                # 跨分类命中次数本身就是热度信号：同一点在多个兴趣主题里都排得上号
                hit_counts[pid] = hit_counts.get(pid, 0) + 1

        max_raw = max(
            (
                popularity_raw(item, hit_counts[pid])
                for pid, item in items_by_id.items()
            ),
            default=0.0,
        )
        if not items_by_id and not pref.must_visit:
            # 例：兴趣只选了「美食」——没有可对应的景点分类，不静默换成别的兴趣去搜
            raise MissingRequiredInfoError(
                "你的兴趣导向里没有能对应景点的分类（人文历史 / 自然风光 / 娱乐），"
                "也没有填写想去的景点，所以无法推荐景点。请补充兴趣或直接填写想去的地方。"
            )
        # 综合分 = 距上一景点 × 权重 + 热门程度 × 权重 + 评分 × 权重，
        # 贪心排出一条顺路的候选链（而不是只按评分/热度把相隔很远的点堆在前面）
        # 只按"值不值得去"排序（热门 × 0.6 + 评分 × 0.4），**不在这里串链**：
        # 距离与路线是规划阶段的事（planner 的 order_chain / split_chain_into_days）。
        # 以前这里掺了一个贪心的距离链，结果"给模型的前 15 个候选"带上了地理偏置。
        items_sorted = sorted(
            items_by_id.values(),
            key=lambda item: attraction_rank(
                item, hit_counts.get(item.get("id") or item.get("name", ""), 1), max_raw
            ),
            reverse=True,
        )
        attractions: List[POI] = [_to_poi(item) for item in items_sorted]
        # 同一片景区在高德往往是多条独立记录（名字还各不相同），这里先合并掉：
        # 否则会出现"同一天上午走 78 米去下一个景点"，以及把相距 5 公里的点塞进同一天。
        attractions, dedupe_notes = dedupe_attractions(attractions)

        # 3. 餐饮 / 酒店 POI：多关键词 + 翻页扩大候选池，按综合分排序分档
        restaurant_items = _search_multi(self.amap, "餐厅", city, pages=2)
        seen_rids = {it.get("id") for it in restaurant_items}
        extra_keywords: List[str] = ["小吃", "本地菜"]
        if "美食" in pref.preferences:
            extra_keywords.append("特色美食")
        extra_keywords.extend(
            DIET_SEARCH_KEYWORDS[r]
            for r in pref.dietary_restrictions
            if r in DIET_SEARCH_KEYWORDS
        )
        for kw in extra_keywords:
            for item in _search_multi(self.amap, kw, city, pages=2):
                if item.get("id") and item.get("id") not in seen_rids:
                    seen_rids.add(item.get("id"))
                    restaurant_items.append(item)
        dining_options = _tiered(restaurant_items, "餐厅", attractions)
        # 同样留一份未截断的全量餐厅候选给 planner。
        # _tiered 每档只留 10 个（界面上的「备选池」够用，但选餐不够用）：
        # 三天行程要吃 6 顿，再从 20 家里去掉已用过的，后半程几乎没有近的可用。
        # 实测平潭那份规划：分档池里最后一餐只能选到 16 公里外的店，
        # 放开全量后能选到 1.7 公里的——差了一个数量级。
        ctx["dining_pool"] = [
            _to_recommendation(item, "餐厅") for item in restaurant_items if item.get("location")
        ]

        hotel_items = _search_multi(self.amap, "酒店", city, pages=2)
        seen_hids = {it.get("id") for it in hotel_items}
        for kw, pages in (("民宿", 2), ("客栈", 1)):
            for item in _search_multi(self.amap, kw, city, pages=pages):
                if item.get("id") and item.get("id") not in seen_hids:
                    seen_hids.add(item.get("id"))
                    hotel_items.append(item)
        hotel_options = _tiered(hotel_items, "住宿", attractions)
        # 另外留一份**未截断**的全量酒店候选，专供 planner 选酒店用。
        #
        # 为什么需要它：_tiered 为了让「换一家」能升级/降级，每个价位档只留 10 个，
        # 而档内排序用的锚点是「全部候选景点」。于是会出现这种情况：
        # 一家恰好贴近最终活动区的酒店，因为离其他候选景点远而被挤出前 10，
        # planner 根本看不到它。实测平潭那份规划，全量里有一家离当日活动区
        # 4.14 公里的民宿，分档后池子里最近的只剩 5.22 公里——近 1.1 公里的选择被丢掉了。
        ctx["hotel_pool"] = [
            _to_recommendation(item, "住宿") for item in hotel_items if item.get("location")
        ]

        # 4. 特别想去的景点（必去）。解析顺序体现「谁更可信」：
        #    a) 候选池里名字完全一致：直接复用，顺带拿到评分 / 票价 / 图片；
        #    b) 按「景点分类码」在目的地搜这个景点，取真实的景点记录。
        #       这一步是必需的：用户在下拉里选中的条目可能根本不是景点——
        #       实测「长江澳」在不筛类型时返回的是「自然地名·海湾海峡」，
        #       坐标是海湾中心，画在地图上就落在海里；同一批结果里还有 3 个停车场。
        #       而且下拉候选本身不带图片，只有真实的景点记录才有评分与实拍图。
        #       有下拉坐标时，在多个命中里挑离它最近的那个（用户选的时候给了方位）；
        #    c) 高德景点库里确实没有：只能用下拉坐标，并明确标注"未匹配到景点"；
        #    d) 连坐标都没有：保留 (0,0) 占位并记下来，由体检点名提示。
        must_pois: List[POI] = []
        unlocated: List[str] = []
        coord_only: List[str] = []
        for entry in pref.must_visit:
            name = (entry.name or "").strip()
            if not name:
                continue
            # (a) 候选池里有完全同名的，直接复用
            matched = next((p for p in attractions if p.name == name), None)
            if matched is not None and not entry.has_location:
                must_pois.append(matched)
                continue
            # (b) 按景点分类码找真实景点记录
            hit = self._find_attraction(name, city, entry, city_name)
            if hit is not None:
                must_pois.append(hit)
                continue
            # (c) 有下拉坐标但没有对应的景点记录
            if entry.has_location and entry.lat is not None and entry.lng is not None:
                coord_only.append(name)
                must_pois.append(
                    POI(
                        name=name,
                        type="景点",
                        location=Location(lat=entry.lat, lng=entry.lng),
                        city=city,
                        tips="未在高德景点库中匹配到同名景点，位置取自输入时的候选坐标；"
                        "建议到地后在地图上确认一下。",
                    )
                )
                continue
            # (d) 什么都没有
            unlocated.append(name)
            must_pois.append(
                POI(
                    name=name,
                    type="景点",
                    location=Location(lat=0, lng=0),
                    city=city,
                    tips="未能在高德定位到坐标，建议到地后在地图中搜索确认",
                )
            )

        # 用户在必去景点里也可能选到同一处的两条（下拉里是两个不同条目），先合并
        must_pois, must_notes = dedupe_attractions(must_pois)

        # 必去景点置于候选池最前，规划阶段优先安排。
        # 与必去景点是"同一处"的普通候选要去掉：否则会出现"上午去了点名的沙滩，
        # 下午又去同片沙滩的另一个高德条目"（实测那份平潭规划就是这样）。
        must_names = {m.name for m in must_pois}
        pool_others: List[POI] = []
        same_as_must: List[Dict[str, Any]] = []
        for poi in attractions:
            if poi.name in must_names:
                continue
            matched = None
            for must in must_pois:
                reason = same_spot(poi, must)
                if reason:
                    matched = {"kept": must.name, "merged": [poi.name], "reason": reason}
                    break
            if matched is not None:
                same_as_must.append(matched)
                continue
            pool_others.append(poi)
        attraction_pool = must_pois + pool_others

        # 4.5) 地域收敛：把离「必去点 / 候选最密集的一带」太远的候选挡在**自动选点**之外。
        #      高德是按行政区给结果的（千岛湖在淳安县，也算杭州市），而综合分不含距离，
        #      于是 127 公里外的千岛湖能排到第 4 名，被模型挑中或补足进来。
        #      详见 skills/geo_gate.py。
        #      注意：前端「换一个」的备选池仍然给全量——系统自动决策时收敛，
        #      用户想手动加远郊的点，能力还在（体检里也会告诉用户怎么加）。
        gate = apply_gate(
            attraction_pool,
            must_pois=must_pois,
            min_keep=max(GEO_GATE_MIN_CANDIDATES, 3 * max(pref.duration_days, 1)),
        )
        # 4.6) 非景点场所：影城 / 剧院 / 文体中心 / 体育馆这类不该被"推荐"成景点。
        #      分类码那一层已经断了源头（见 PREFERENCE_TYPES 的注释），这里再兜一道
        #      名字护栏；用户点名的必去景点不排除。见 skills/spot_filter.py。
        kept, non_attractions = split_non_attractions(
            gate.kept, exempt_names=[m.name for m in must_pois]
        )
        ctx["geo_gate"] = {
            "gate_km": gate.gate_km,
            "dropped": [(p.name, km) for p, km in gate.dropped],
        }
        ctx["spot_filter"] = [p.name for p in non_attractions]
        ctx["attractions"] = kept
        ctx["attraction_options"] = attraction_pool
        ctx["must_visit_pois"] = must_pois
        ctx["unlocated_must_visit"] = unlocated
        ctx["coord_only_must_visit"] = coord_only
        # 合并说明交给规划阶段写进体检清单：改了什么要让用户看得见
        ctx["dedupe_notes"] = dedupe_notes + must_notes + same_as_must
        # 饮食禁忌：把明显违反的餐厅挡在候选之外（只能按店名判断，见 _filter_diet）
        dining_options, diet_dropped = _filter_diet(
            dining_options, pref.dietary_restrictions
        )
        # planner 用的是 ctx["dining_pool"]（未截断的全量候选），这里一并过滤
        ctx["dining_pool"], _ = _filter_diet(
            ctx.get("dining_pool") or [], pref.dietary_restrictions
        )
        ctx["diet_dropped"] = diet_dropped
        # 本地特色词：从招牌菜标签里统计出来（零人工），供挑餐厅时给一点加分
        ctx["local_keywords"] = local_specialty_keywords(ctx.get("dining_pool") or [])
        ctx["dining_options"] = dining_options
        ctx["hotel_options"] = hotel_options
        ctx["restaurants"] = dining_options
        return ctx
