"""地域收敛（GeoGate）：把离用户真正会去的那一带太远的候选，挡在自动选点之外。

为什么需要（实测杭州）：
高德按**行政区**给结果，而我们只传了城市名。杭州市辖 13 个区县市、面积 1.68 万平方公里，
所以「自然风光」这一类会返回 **127 公里外的千岛湖（淳安县）**、65 公里的垂云通天河、
38 公里的径山寺、33 公里的青山湖。而候选池本身是按综合分排的
（热度×0.6 + 评分×0.4，**不含距离**），于是千岛湖排到了第 4 名——
不收敛的话，大模型会挑它、补足也会补它，排出来就是前两天在市区、第三天开 127 公里。

**距离谁**（这是这个模块唯一要回答的问题）：
锚点 = ① 用户点名必去的景点 + ② 候选最密集的那一带（10 公里网格里命中最多的格子中心）。

- 必去点代表用户明确会去的地方——用户选了远郊的点，闸门就该围着它开；
- 密集区代表这座城市的游玩重心——没有必去点时用它兜底；
- 判定用「到**最近**锚点的距离」，所以只要有一个锚点在你那一带就不会被误伤
  （用户必去千岛湖时，西湖一带的候选仍然离密集区锚点很近，不会被切掉）。

阈值不写死，而是跟着这座城市的尺度走：
`阈值 = clamp(2 × 距离的 P75, 15 公里, 60 公里)`。
P75 的含义是「多数候选都在这个范围里」，乘 2 允许合理外扩，再夹在 15~60 公里之间。
实测：杭州 P75≈11 公里 → 阈值 22 公里 → 切掉 33/38/65/127 这四个点；
平潭全市候选都在 20 公里内 → 阈值 24 公里 → 一个都不切（岛屿城市不会误伤）。

**切掉不等于悄悄丢**：被排除的候选、离多远，都会写进体检清单，
并告诉用户「想保留就把它设为必去景点」。前端「换一个」的备选池仍然给全量候选。
"""
import math
from dataclasses import dataclass, field
from typing import Any, List, Optional, Tuple

from ..models.plan import Location, POI
from .scoring import distance_km, has_location

# 找最密集那一带用的网格尺寸（公里）
CELL_KM = 10.0
# 阈值 = 距离 P75 的多少倍
GEO_GATE_MULTIPLIER = 2.0
# 阈值下限：再紧凑的城市也允许 15 公里
GEO_GATE_MIN_KM = 15.0
# 阈值上限：再大的城市也不会保留 60 公里以外的候选（会被要求设为必去）
GEO_GATE_MAX_KM = 60.0
# 候选少于这个数就不做收敛（池子本来就小，切了没法排）
GEO_GATE_MIN_CANDIDATES = 8
# 一次最多切掉多少比例的候选；超过就不切了（见 apply_gate 里的说明）
GEO_GATE_MAX_DROP_SHARE = 0.4


@dataclass
class GateResult:
    """收敛结果：保留谁、切掉谁、阈值多少。"""

    kept: List[POI]
    dropped: List[Tuple[POI, float]] = field(default_factory=list)
    gate_km: Optional[float] = None


def _percentile(values: List[float], q: float) -> float:
    """线性插值分位数（不引 numpy）。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    pos = q * (len(ordered) - 1)
    low = int(math.floor(pos))
    high = min(low + 1, len(ordered) - 1)
    frac = pos - low
    return ordered[low] * (1 - frac) + ordered[high] * frac


def gate_km_of(distances: List[float]) -> Optional[float]:
    """按距离序列算阈值；样本太少算不出来就返回 None（表示不收敛）。"""
    if len(distances) < GEO_GATE_MIN_CANDIDATES:
        return None
    raw = _percentile(distances, 0.75) * GEO_GATE_MULTIPLIER
    return min(max(raw, GEO_GATE_MIN_KM), GEO_GATE_MAX_KM)


def densest_center(pool: List[POI], cell_km: float = CELL_KM) -> Optional[POI]:
    """候选最密集的那一带：把地图切成网格，取命中最多那一格的中心。"""
    points = [p for p in pool if has_location(p)]
    if not points:
        return None
    mid_lat = sum(p.location.lat for p in points) / len(points)
    d_lat = cell_km / 110.57
    d_lng = cell_km / max(111.32 * math.cos(math.radians(mid_lat)), 1e-6)
    buckets: dict[Tuple[int, int], List[POI]] = {}
    for poi in points:
        key = (
            int(round(poi.location.lat / d_lat)),
            int(round(poi.location.lng / d_lng)),
        )
        buckets.setdefault(key, []).append(poi)
    best = max(buckets.values(), key=len)
    return POI(
        name="候选最密集的一带",
        type="景点",
        location=Location(
            lat=sum(p.location.lat for p in best) / len(best),
            lng=sum(p.location.lng for p in best) / len(best),
        ),
    )


def anchor_points(pool: List[POI], must_pois: List[POI]) -> List[POI]:
    """锚点 = 必去景点（有坐标的）+ 候选最密集的一带。"""
    anchors = [p for p in must_pois if has_location(p)]
    center = densest_center(pool)
    if center is not None:
        anchors.append(center)
    return anchors


def distance_to_anchors(
    poi: POI, anchors: List[POI], metrics: Any = None
) -> Optional[float]:
    """该点到最近锚点的距离；没有可用坐标返回 None。"""
    known = [
        d
        for d in (distance_km(poi, anchor, metrics) for anchor in anchors)
        if d is not None
    ]
    return min(known) if known else None


def apply_gate(
    pool: List[POI],
    must_pois: Optional[List[POI]] = None,
    metrics: Any = None,
    min_keep: int = GEO_GATE_MIN_CANDIDATES,
) -> GateResult:
    """按地域收敛候选池。切不动（人太少 / 没坐标 / 切完不够用）就原样返回。

    min_keep：收敛后至少要剩这么多候选，否则宁可不收敛——
        闸门是为了让行程更合理，不是为了把候选池切空。
    """
    must_pois = list(must_pois or [])
    anchors = anchor_points(pool, must_pois)
    if not anchors or len(pool) < max(GEO_GATE_MIN_CANDIDATES, min_keep):
        return GateResult(kept=list(pool))

    measured: List[Tuple[POI, float]] = []
    for poi in pool:
        distance = distance_to_anchors(poi, anchors, metrics)
        if distance is not None:
            measured.append((poi, distance))
    if len(measured) < max(GEO_GATE_MIN_CANDIDATES, min_keep):
        return GateResult(kept=list(pool))

    gate = gate_km_of([d for _, d in measured])
    if gate is None:
        return GateResult(kept=list(pool))

    dropped = [(poi, round(d, 1)) for poi, d in measured if d > gate]
    if not dropped:
        return GateResult(kept=list(pool), gate_km=gate)
    if len(dropped) > max(1, int(len(measured) * GEO_GATE_MAX_DROP_SHARE)):
        # 会切掉太多：说明这座城市的候选本来就是**多簇**分布（市区 + 远郊县各一撮），
        # 那就不该由系统替用户决定砍哪一簇——留全量，交给下游按距离自己选。
        return GateResult(kept=list(pool), gate_km=gate)

    dropped_ids = {id(poi) for poi, _ in dropped}
    kept = [poi for poi in pool if id(poi) not in dropped_ids]
    if len(kept) < min_keep:
        # 切完不够用：不收敛，交给下游（宁可排得远，也不要没得排）
        return GateResult(kept=list(pool), gate_km=gate)
    return GateResult(kept=kept, dropped=dropped, gate_km=gate)
