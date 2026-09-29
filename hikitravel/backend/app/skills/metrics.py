"""规划阶段的距离度量：把「直线距离」换成「尽量接近真实」的距离。

为什么不能全部走真实驾车路线（实测数据，平潭那份三天规划）：

    直线距离计算次数 = 12,630 次
    去重后不同的坐标对 = 5,034 对

全部换成路径规划 API 就意味着**每份规划 5,034 次外部调用**：按项目自己的限流
（0.4 秒/次）是 33 分钟一份，还会直接打满高德路径规划的日免费额度。
所以「全部换真实路线」在工程上跑不起来——真实路线贵在"次数"，不在"技术"。

于是分两层，把有限的调用额度花在真正决定行程的地方：

1. **真实驾车距离**：选中景点之间的两两距离。这是分天聚类与当天排序唯一的依据，
   也是错得最离谱的地方——实测平潭「风车森林公路」离第 1 天的点只有 1 公里，
   却因为聚类只用直线距离被分到了第 2 天。9 个景点 = 36 对，成本可接受。
2. **直线 × 绕行系数**：餐厅/酒店的预筛、以及和「活动区中心」这类**合成点**的比较。
   后者本来就没有路可走（中心点可能在海里或山腰），只能按直线估算；
   乘上系数可以修正平潭这类海湾地形 1.7~2.7 倍的系统性低估。

系数由少量真实路线采样估出来（默认 6 对，取中位数，避免一两条跨海路段带偏），
所以额外开销只有个位数次调用。

所有调用都走 AmapClient.get_route —— 它已经带了限流与 600 秒缓存，
同一条路线在"聚类 → 排序 → 接驳"里反复用到时只算一次。
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from ..models.plan import POI
from .scoring import has_location, haversine

#: 每份规划允许消耗的真实路线调用次数上限（防止某天池子特别大时失控）
DEFAULT_ROUTE_BUDGET = 80
#: 估算绕行系数时采样的路线条数
FACTOR_SAMPLES = 6
#: 太短的段路面距离没有参考价值（几百米内绕行系数会失真），不参与估算
MIN_SAMPLE_KM = 0.3


@dataclass
class RoadMetrics:
    """一次规划期间共享的距离度量与调用预算。"""

    amap: Any
    budget: int = DEFAULT_ROUTE_BUDGET
    factor: float = 1.0
    used: int = 0
    cache_hits: int = 0
    _cache: Dict[Tuple[Any, Any], float] = field(default_factory=dict, repr=False)

    # ---------------- 真实驾车距离 ----------------
    @staticmethod
    def _key(a: POI, b: POI) -> Tuple[Any, Any]:
        """按约 100 米精度做键：同一个景点不会被重复取两次路线。"""
        ka = (round(a.location.lat, 3), round(a.location.lng, 3))
        kb = (round(b.location.lat, 3), round(b.location.lng, 3))
        return (ka, kb) if ka <= kb else (kb, ka)

    def road_km(self, a: POI, b: POI) -> Optional[float]:
        """真实驾车里程（公里）。取不到 / 超出预算时返回 None。"""
        if not (has_location(a) and has_location(b)):
            return None
        key = self._key(a, b)
        cached = self._cache.get(key)
        if cached is not None:
            self.cache_hits += 1
            return cached
        if self.used >= self.budget:
            return None
        self.used += 1
        try:
            data = self.amap.get_route(
                f"{a.location.lng},{a.location.lat}",
                f"{b.location.lng},{b.location.lat}",
                "driving",
            )
            path = data["route"]["paths"][0]
            km = float(path.get("distance") or 0) / 1000.0
        except Exception:
            return None
        if km <= 0:
            return None
        self._cache[key] = km
        return km

    # ---------------- 统一入口 ----------------
    def km(self, a: POI, b: POI) -> Optional[float]:
        """两点距离：有真实驾车值就用真实值，否则直线 × 绕行系数。"""
        if not (has_location(a) and has_location(b)):
            return None
        road = self.road_km(a, b)
        if road is not None:
            return road
        straight = haversine(
            a.location.lat, a.location.lng, b.location.lat, b.location.lng
        )
        return straight * self.factor

    def straight_with_factor(self, km_straight: float) -> float:
        """给「合成点」（如活动区中心）用的距离：没有路可走，只能直线 × 系数。"""
        return km_straight * self.factor

    # ---------------- 预热与系数估算 ----------------
    def estimate_factor(self, points: Sequence[POI], samples: int = FACTOR_SAMPLES) -> float:
        """用少量真实路线采样，估出这座城市的平均绕行系数（路 / 直线）。"""
        pts = [p for p in points if has_location(p)]
        if len(pts) < 2:
            return self.factor
        pairs: List[Tuple[float, POI, POI]] = []
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                a, b = pts[i], pts[j]
                straight = haversine(
                    a.location.lat, a.location.lng, b.location.lat, b.location.lng
                )
                if straight >= MIN_SAMPLE_KM:
                    pairs.append((straight, a, b))
        if not pairs:
            return self.factor
        # 按直线距离排序后**均匀取若干个分位**：短段和长段都要看。
        # 只按固定步长抽，运气不好全抽到城里的短段，系数会被估低
        # （实测同一个目的地、同一批点，两次分别估出 1.47 和 2.16）。
        pairs.sort(key=lambda item: item[0])
        step = max(1, len(pairs) // samples)
        picked = [pairs[min(i * step, len(pairs) - 1)] for i in range(samples)]
        ratios: List[float] = []
        for straight, a, b in picked:
            road = self.road_km(a, b)
            if road:
                ratios.append(road / straight)
        if ratios:
            ratios.sort()
            self.factor = min(max(ratios[len(ratios) // 2], 1.0), 3.0)
        return self.factor

    def prime(self, points: Sequence[POI]) -> int:
        """把给定点之间的两两真实路线提前取好（受预算限制）。

        按直线距离从近到远取：聚类与排序真正关心的是"谁离谁近"，
        额度不够时先保住这些近的对。
        """
        pts = [p for p in points if has_location(p)]
        pairs: List[Tuple[float, POI, POI]] = []
        for i in range(len(pts)):
            for j in range(i + 1, len(pts)):
                a, b = pts[i], pts[j]
                straight = haversine(
                    a.location.lat, a.location.lng, b.location.lat, b.location.lng
                )
                pairs.append((straight, a, b))
        pairs.sort(key=lambda item: item[0])
        before = self.used
        for _, a, b in pairs:
            if self.used >= self.budget:
                break
            self.road_km(a, b)
        return self.used - before

    def stats(self) -> Dict[str, Any]:
        """给日志/体检用的统计：真实路线用了多少次、缓存命中多少。"""
        return {
            "route_calls": self.used,
            "cache_hits": self.cache_hits,
            "cached_pairs": len(self._cache),
            "factor": round(self.factor, 2),
            "budget": self.budget,
        }
