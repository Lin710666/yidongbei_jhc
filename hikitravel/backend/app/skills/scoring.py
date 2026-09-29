"""综合分计算：景点 / 餐厅 / 酒店 的推荐排序依据。

为什么不能只看评分：
- 景点：评分高的常常是小众好评点，真正值得去的热门大景点评分未必最高，
  所以要把「热门程度」和「评分」一起算。
- 餐厅 / 酒店：好不好不只看口碑，还要看「顺不顺路」——离前后两个景点越近，
  用户来回折腾的时间越少，体验越好。

公式（权重集中在本模块顶部，便于调参）：
- 景点综合分     = 距上一景点 × ATTRACTION_DIST_WEIGHT + 热门程度分 × ATTRACTION_HOT_WEIGHT
                   + 评分 × ATTRACTION_RATING_WEIGHT
- 餐厅/酒店综合分 = 距上一景点 × OPTION_PREV_WEIGHT + 距下一景点 × OPTION_NEXT_WEIGHT
                   + 评分 × OPTION_RATING_WEIGHT

细节说明：
- 距离项先用 proximity(km) = 1 / (1 + km) 转成「顺路分」（越近越高，落在 0~1），
  再乘权重。没有坐标的点（占位数据）不参与距离项，权重在剩余项之间自动重新分配。
- 评分统一归一化为 rating / 5；高德未给评分时该项不参与，避免"没评分"被当成"评分 0"
  而误伤冷门但优质的点。
- 热门程度分按「高德 weight 字段 → 照片数 → 跨分类命中次数」逐级取用，
  最后按本轮候选池的最大值归一化到 0~1。
"""
import math
from typing import Any, Dict, List, Optional

from ..models.plan import POI
from .authority import match_authority

# ---- 景点推荐分权重（只评"值不值得去"，距离交给规划阶段）----
ATTRACTION_HOT_WEIGHT = 0.6
ATTRACTION_RATING_WEIGHT = 0.4

#: 命中权威名录（国家级 5A 景区）的倾斜权重。0.15 约等于排名里"半个评分档"，
#: 不会盖过热度与评分，但足以把国家级景区从同类里托起来。
AUTHORITY_WEIGHT = 0.15

# ---- 餐厅 / 酒店综合分权重（两项距离合计 0.6，评分 0.4）----
OPTION_PREV_WEIGHT = 0.3
OPTION_NEXT_WEIGHT = 0.3
OPTION_RATING_WEIGHT = 0.4

#: "本地特色店"的加分。0.18 大致相当于"允许为它多绕 1~2 公里"——
#: 人的做法就是这样：会为了本地老店多开两公里，而不是在景点门口吃快餐。
LOCAL_SPECIALTY_BONUS = 0.18

#: 拿这份加分的最低评分。本地特色加分是 0.18，而评分项满权重是 0.4
#: （每 1 分 ≈ 0.08），所以不设门槛时它能盖过 2 分以上的口碑差距——
#: 实测平潭第 2 天晚餐就被加成推成了 3.6 分的店，压掉旁边 4.5 分的店。
#: 4.0 是"口碑过得去"的底线：达标才给加分，不达标只是不加分（照样能被选中，
#: 毕竟有时候景区附近只有这一家）。评分缺失（None）不当成差评，照常加分。
LOCAL_SPECIALTY_MIN_RATING = 4.0

#: 连锁快餐 / 连锁饮品的降权（只降权、不排除）。
#: 0.30 与上面的 0.18 合起来 ≈ 让"本地老店"最多可以比"景点门口的连锁店"远 3 公里
#: 还赢——这正是人的取舍：去平潭不会专门吃麦当劳。
#: 为什么是降权而不是"直接排除"：景区在荒郊、附近只有连锁店时，总得让人有饭吃。
CHAIN_DINING_PENALTY = 0.30

# ---- 酒店综合分权重（酒店落在切点上：一边是今天玩完，一边是明早出发）----
HOTEL_RATING_WEIGHT = 0.4
HOTEL_PREV_WEIGHT = 0.3
HOTEL_NEXT_WEIGHT = 0.3


def haversine(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    """两点球面距离（公里）。"""
    r = 6371.0
    lat1, lng1 = math.radians(a_lat), math.radians(a_lng)
    lat2, lng2 = math.radians(b_lat), math.radians(b_lng)
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(h))


def proximity(km: float) -> float:
    """距离 → 顺路分（0~1）：越近越接近 1。"""
    return 1.0 / (1.0 + max(km, 0.0))


def _as_float(value: Any) -> Optional[float]:
    """把可能是字符串 / 空 list 的字段安全转成 float，转不了返回 None。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalized_rating(rating: Any) -> Optional[float]:
    """评分 → 0~1。无评分返回 None（表示该项不参与加权）。"""
    r = _as_float(rating)
    if r is None or r <= 0:
        return None
    return min(r / 5.0, 1.0)


def has_location(poi: POI) -> bool:
    """POI 是否有有效坐标（占位数据是 0,0）。"""
    return not (poi.location.lat == 0 and poi.location.lng == 0)


def distance_km(a: POI, b: POI, metrics: Any = None) -> Optional[float]:
    """两个 POI 的距离（公里）；任一缺坐标返回 None。

    传了 metrics 就用「尽量接近真实」的距离（真实驾车优先，取不到时直线×绕行系数），
    否则退回纯直线。见 skills/metrics.py 里为什么不能全部走真实路线。
    """
    if not has_location(a) or not has_location(b):
        return None
    if metrics is not None:
        return metrics.km(a, b)
    return haversine(a.location.lat, a.location.lng, b.location.lat, b.location.lng)


def popularity_raw(item: Dict[str, Any], hits: int = 1) -> float:
    """热门程度原始分（未归一）。

    取值优先级：
    1. 高德 POI 自带的 weight 字段（若接口返回）——最直接的热度信号；
    2. 照片数量——热门点通常有更多实拍图；
    3. 跨分类命中次数——同一个点被多个兴趣分类搜到，说明它在多个主题里都排得上号。
    """
    weight = _as_float(item.get("weight"))
    if weight is not None and weight > 0:
        return weight
    photos = item.get("photos")
    if isinstance(photos, list) and photos:
        return float(len(photos))
    return float(max(hits - 1, 0))


def hotness(item: Dict[str, Any], hits: int, max_raw: float) -> float:
    """热门程度分（0~1）。"""
    if max_raw <= 0:
        return 0.0
    return min(popularity_raw(item, hits) / max_raw, 1.0)


def attraction_rank(item: Dict[str, Any], hits: int, max_raw: float) -> float:
    """景点推荐分 = 热门程度 × 0.6 + 评分 × 0.4。

    **这里刻意不含距离项**：距离属于"路线"，是规划阶段的事
    （见 planner 的 order_chain / split_chain_into_days）。

    检索阶段只回答"哪些景点值得去"。以前在这里掺了一个贪心的距离链，结果是
    既不像排序、也不像路线：按那个顺序走完 90.9 公里，而真正串成一条链只要
    63.2 公里；而且它把给大模型的候选带上了地理偏置（截断到前 15 个）。
    """
    terms: List[tuple[float, float]] = [(hotness(item, hits, max_raw), ATTRACTION_HOT_WEIGHT)]
    rating = normalized_rating((item.get("biz_ext") or {}).get("rating"))
    if rating is not None:
        terms.append((rating, ATTRACTION_RATING_WEIGHT))
    # 命中权威名录（国家级 5A 景区）给一点倾斜：这是"权威认证"的信号，
    # 不是热度、也不是评分能表达的。名单来自本地文件，零外部调用。
    if match_authority(_text_name(item)):
        terms.append((1.0, AUTHORITY_WEIGHT))
    total_weight = sum(w for _, w in terms)
    return sum(v * w for v, w in terms) / total_weight if total_weight else 0.0


def _text_name(item: Dict[str, Any]) -> str:
    """高德偶尔把字符串字段返回成空 list，统一转安全字符串。"""
    value = item.get("name")
    return value if isinstance(value, str) else ""


def option_score(
    poi: POI,
    prev_poi: Optional[POI],
    next_poi: Optional[POI],
    metrics: Any = None,
) -> float:
    """餐厅 / 酒店综合分 = 距上一景点 × 权重 + 距下一景点 × 权重 + 评分 × 权重。

    prev_poi / next_poi 为该点在行程中的前后邻居（可能为空）。
    缺坐标或没有邻居时，对应项不参与，权重在剩余项之间重新分配，
    保证任何数据条件下都能给出可比的分值。
    """
    terms: List[tuple[float, float]] = []

    if prev_poi is not None:
        d = distance_km(poi, prev_poi, metrics)
        if d is not None:
            terms.append((proximity(d), OPTION_PREV_WEIGHT))
    if next_poi is not None:
        d = distance_km(poi, next_poi, metrics)
        if d is not None:
            terms.append((proximity(d), OPTION_NEXT_WEIGHT))

    rating = normalized_rating(poi.rating)
    if rating is not None:
        terms.append((rating, OPTION_RATING_WEIGHT))

    if not terms:
        return 0.0
    total_weight = sum(w for _, w in terms)
    return sum(value * weight for value, weight in terms) / total_weight


#: 统计"本地特色"时要忽略的通用词（促销词、餐次词都不体现城市特色）
_GENERIC_TAGS = {
    "双人餐", "四人餐", "套餐", "优惠", "团购", "自助", "快餐", "外卖",
    "早餐", "午餐", "晚餐", "招牌", "推荐", "饮品", "酒水", "点心",
    "中餐厅", "餐厅", "美食", "小吃", "中餐", "餐饮", "餐饮相关",
    "小吃快餐", "美食街", "特色小吃",
}

#: 连锁快餐 / 连锁饮品品牌词。命中即认为"在哪儿都能吃到"，与目的地特色无关。
#: 这张表刻意只收**全国性连锁**，且只用于降权（配合 is_local_specialty 的豁免），
#: 不做排除——避免"某家本地店名字里恰好有这两个字"被误杀。
_CHAIN_BRANDS = (
    "麦当劳", "肯德基", "KFC", "汉堡王", "德克士", "华莱士", "塔斯汀", "必胜客",
    "星巴克", "瑞幸", "库迪", "蜜雪冰城", "喜茶", "奈雪", "古茗", "霸王茶姬",
    "沙县小吃", "兰州拉面", "真功夫", "老乡鸡", "南城香", "海底捞", "西贝",
)

#: 这些菜系 / 招牌菜 / 店名词属于"通用餐饮"，不体现本地特色。
#: 店名也一起看：实测平潭第 1 天的午餐被推成了「又一·Youyi Sea Coffee」——
#: 它的菜系标签里没有"咖啡"二字，只有店名里写着 Coffee。
_GENERIC_DINING_WORDS = (
    "快餐", "西式快餐", "汉堡", "炸鸡", "披萨", "意面", "咖啡", "饮品", "奶茶",
    "甜品", "便利店", "coffee", "cafe", "tea",
)


def local_specialty_keywords(
    restaurants: List[POI], top: int = 5, min_count: int = 3
) -> List[str]:
    """从招牌菜标签里**统计**出这座城市的本地特色（零人工）。

    做法：把该城市所有餐厅的 tags 切开数词频，取出现次数最多的几个词。

    实测平潭会得到：大排档(11)、海鲜(4)、椒盐皮皮虾(3)、时来运转(2)——
    正是当地特色。用它给"本地特色店"加一点分，就能把连锁快餐压下去
    （实测有 5/20 份规划把麦当劳/肯德基排进了行程）。

    这是统计出来的，不需要人工整理；换一个城市自动就是那个城市的特色。
    """
    counts: Dict[str, int] = {}
    for poi in restaurants:
        for word in poi.tags:
            if word in _GENERIC_TAGS or len(word) < 2:
                continue
            counts[word] = counts.get(word, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return [word for word, count in ranked if count >= min_count][:top]


def is_local_specialty(poi: POI, keywords: List[str]) -> bool:
    """这家店是不是"本地特色"：店名 / 菜系 / 招牌菜里命中本地特色词。"""
    if not keywords:
        return False
    haystack = " ".join([poi.name, poi.cuisine, *poi.tags])
    return any(word in haystack for word in keywords)


def is_chain_dining(poi: POI, keywords: Optional[List[str]] = None) -> bool:
    """这家店是不是"在哪儿都能吃到"的连锁快餐 / 连锁饮品。

    判定顺序有意为之：**先看它是不是本地特色**——本地特色词是从这座城市的招牌菜
    统计出来的，一旦命中就说明这家店挂着本地招牌（例如「潭式煎包」的招牌菜里有
    「大排档」），此时一律不当连锁处理。只有"既不是本地特色、又命中品牌名或
    通用餐饮词"的店才降权，避免把本地小店误压下去。
    """
    if is_local_specialty(poi, keywords or []):
        return False
    if any(brand in poi.name for brand in _CHAIN_BRANDS):
        return True
    haystack = " ".join([poi.name, poi.cuisine, *poi.tags]).lower()
    return any(word.lower() in haystack for word in _GENERIC_DINING_WORDS)


def meal_score(
    poi: POI,
    prev_poi: Optional[POI],
    next_poi: Optional[POI],
    metrics: Any = None,
    local_keywords: Optional[List[str]] = None,
) -> float:
    """餐厅打分 = 顺路分（离链上前后两点）+ 评分 ± 内容修正。

    内容修正就是这一版针对"5/20 份规划把麦当劳排进行程"的修法：
    - 本地特色店 +0.18（值得为它多开一两公里；评分低于 LOCAL_SPECIALTY_MIN_RATING
      的不加分——"本地"不能拿来盖过明显的口碑差距）；
    - 连锁快餐 / 连锁饮品 −0.30（在哪儿都能吃到，不该占掉一顿当地餐）。

    两项都只影响排序，不做硬排除：附近确实只有连锁店时照样安排，用户能吃到饭。
    """
    score = option_score(poi, prev_poi, next_poi, metrics)
    if is_local_specialty(poi, local_keywords or []) and (
        poi.rating is None or poi.rating >= LOCAL_SPECIALTY_MIN_RATING
    ):
        return score + LOCAL_SPECIALTY_BONUS
    if is_chain_dining(poi, local_keywords or []):
        return score - CHAIN_DINING_PENALTY
    return score


def hotel_cut_score(
    hotel: POI,
    prev_poi: Optional[POI],
    next_poi: Optional[POI],
    metrics: Any = None,
) -> float:
    """酒店综合分 = 评分 × 权重 + 距「当天最后一个景点」× 权重 + 距「次日第一个景点」× 权重。

    为什么是这两个点，而不是"当天/次日活动区的中心"：
    中心是经纬度平均出来的**合成点**——它可能落在海里或山腰，根本没有
    "到它的驾车距离"，只能靠直线乘一个系数拍脑袋。而切点两侧是两个**真实景点**，
    正好对应「今天玩完回酒店」和「明早从这里出发」这两段，可以查真实路线，
    算出来的也就是用户真正要走的那两段路。
    """
    terms: List[tuple[float, float]] = []
    rating = normalized_rating(hotel.rating)
    if rating is not None:
        terms.append((rating, HOTEL_RATING_WEIGHT))

    for anchor, weight in ((prev_poi, HOTEL_PREV_WEIGHT), (next_poi, HOTEL_NEXT_WEIGHT)):
        if anchor is None:
            continue
        d = distance_km(hotel, anchor, metrics)
        if d is not None:
            terms.append((proximity(d), weight))
    if not terms:
        return 0.0
    total_weight = sum(w for _, w in terms)
    return sum(value * weight for value, weight in terms) / total_weight
