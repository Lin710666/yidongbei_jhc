"""路线体检与优化（纯确定性计算，不调用大模型）。

为什么这部分不交给大模型：距离、折返、顺序这些都是可以用真实坐标算准的，
让模型去"感觉"路线顺不顺反而容易误报。所以分工是：
- 代码：算距离、找折返、按最近邻重排顺序（秒级、可复现）；
- 大模型：判断"这样排合不合理、有没有更好的取舍"（见 check_skill 的审查提示词）。

体检看三件事（都用高德返回的真实坐标算直线距离）：
1. 同一天的总移动距离；
2. 是否折返：A→B→C 中 C 明显比 B 更靠近 A，说明多跑了冤枉路；
3. 是否有单段超长距离（例如 25 公里以上），通常意味着这两个点不该塞在同一天。

优化：以当天起点（前一晚住的酒店）为基准，用最近邻顺序重排当天景点。
最近邻是贪心，偶尔会明显次优，因此后面再接一次 2-opt 局部优化（见 two_opt）。

分天用**「先串成一条链、再把链切成天」**，而不是每天各自聚类、更不是"从种子往外长"。
理由见 cluster_into_days 的说明：链式切段天然保证相邻两天衔接、也不会让某天横跨全城。
"""
import math
from typing import Any, Dict, List, Optional, Tuple

from ..models.plan import POI
from .scoring import distance_km

#: 单段超过这个距离（公里）就算"长距离挪动"，值得提醒用户
LONG_LEG_KM = 25.0
#: 折返判定：多绕出来的距离超过这个数（公里）才算浪费。
#: 而且只判「景点 → 景点 → 景点」这一段：吃饭、回酒店插在中间天然会多跑几公里，
#: 那是行程本身，不是路线问题（原来把餐厅和酒店也算进去，实测天天误报）。
BACKTRACK_MIN_KM = 5.0
#: 绕行判定（相对值）：实际里程 / 直线距离 要超过「本趟规划的绕行基线 × 这个余量」才算。
#: 平潭实测基线就是 2.15 倍——用写死的 1.5 倍当阈值，等于岛上每一段都在"绕行"。
DETOUR_RATIO_MARGIN = 1.25
#: 绕行的绝对门槛：实际比直线多跑不到这么多公里就不报（小事不值得说）
DETOUR_MIN_EXTRA_KM = 3.0
#: 兜底的绝对倍数（拿不到本趟基线时用），同时也是"再敏感也不低于它"的下限
DETOUR_RATIO = 1.5
#: 太短的段路面距离没有参考价值，不参与绕行判定
DETOUR_MIN_ROAD_KM = 4.0


def leg_distances(pois: List[POI], metrics: Any = None) -> List[Optional[float]]:
    """相邻两点的距离（公里）；缺坐标的那段返回 None。

    传了 metrics（见 skills/metrics.py）就用「尽量接近真实」的距离，否则直线。
    """
    return [distance_km(pois[i], pois[i + 1], metrics) for i in range(len(pois) - 1)]


def total_distance_km(pois: List[POI], metrics: Any = None) -> float:
    """一串点的总移动距离（公里），缺坐标的段按 0 计。"""
    return round(sum(d for d in leg_distances(pois, metrics) if d is not None), 1)


def long_legs(
    pois: List[POI], threshold_km: float = LONG_LEG_KM, metrics: Any = None
) -> List[Tuple[str, str, float]]:
    """找出超过阈值的单段移动，返回 [(起点, 终点, 公里)]。"""
    found: List[Tuple[str, str, float]] = []
    for i, d in enumerate(leg_distances(pois, metrics)):
        if d is not None and d >= threshold_km:
            found.append((pois[i].name, pois[i + 1].name, round(d, 1)))
    return found


def backtracks(
    pois: List[POI], detour_km: float = BACKTRACK_MIN_KM
) -> List[Tuple[str, str, str, float]]:
    """找出折返：A→B→C 里多绕的距离超过阈值。

    返回 [(A, B, C, 多绕公里数)]。判定用「实走 - 直达」：
    dist(A,B) + dist(B,C) - dist(A,C) > 阈值，说明 B 是白跑的一趟。
    """
    found: List[Tuple[str, str, str, float]] = []
    for i in range(len(pois) - 2):
        a, b, c = pois[i], pois[i + 1], pois[i + 2]
        ab, bc, ac = distance_km(a, b), distance_km(b, c), distance_km(a, c)
        if ab is None or bc is None or ac is None:
            continue
        extra = ab + bc - ac
        if extra > detour_km:
            found.append((a.name, b.name, c.name, round(extra, 1)))
    return found


def order_nearest(
    pois: List[POI],
    start: Optional[POI] = None,
    end: Optional[POI] = None,
    metrics: Any = None,
) -> List[POI]:
    """按最近邻重排：从 start 出发，每次去离当前位置最近的点，最后回到 end。

    end 传当晚酒店：一天的真实代价是「起点 → 景点 → 当晚酒店」这条完整链，
    以前只优化前半段，结果出现过第 2 天 20:13 结束在离酒店 7.8 公里的地方
    （景点排序没错，但整天多跑了一大段）。把 end 纳入目标后就一致了。

    坐标缺失的点排不出来，会保持原有相对顺序被放到最后处理。
    贪心结果最后会过一遍 two_opt——每天景点只有 2~4 个，代价可以忽略。
    """
    remaining = list(pois)
    ordered: List[POI] = []
    current = start
    while remaining:
        if current is None:
            chosen = remaining.pop(0)
        else:
            def _distance_to_current(poi: POI) -> float:
                d = distance_km(current, poi, metrics)
                return d if d is not None else float("inf")

            chosen = min(remaining, key=_distance_to_current)
            remaining.remove(chosen)
        ordered.append(chosen)
        current = chosen
    return two_opt(ordered, start, end, metrics)


def two_opt(
    ordered: List[POI],
    start: Optional[POI] = None,
    end: Optional[POI] = None,
    metrics: Any = None,
) -> List[POI]:
    """2-opt 局部优化：反复尝试「把中间一段路反过来走」，直到没有更短的为止。

    为什么需要它：最近邻是贪心，会出现"最后两点其实应该互换"这类明显次优，
    而这类次优又正好会被路线体检当成绕路报出来（白报一条问题给用户）。
    每天景点数本来就只有 2~4 个，完整 2-opt 的代价是毫秒级。

    起点（前一晚住的酒店）固定在第一位不动——它是当天实际出发的位置；
    end（当晚酒店）固定在最后一位，它是当天实际结束的位置。
    坐标缺失的点不参与距离计算（距离为 None 记 0），因此不会被优化搬动。
    """
    if len(ordered) < 3:
        return ordered

    def _total(seq: List[POI]) -> float:
        chain = ([start] if start is not None else []) + seq
        if end is not None:
            chain = chain + [end]
        return total_distance_km(chain, metrics)

    best = list(ordered)
    best_km = _total(best)
    improved = True
    while improved:
        improved = False
        for i in range(len(best) - 1):
            for j in range(i + 1, len(best)):
                trial = best[:i] + best[i : j + 1][::-1] + best[j + 1 :]
                km = _total(trial)
                if km < best_km - 1e-9:
                    best, best_km, improved = trial, km, True
    return best


def day_route_stats(pois: List[POI]) -> Dict[str, Any]:
    """单日路线体检结果。"""
    return {
        "total_km": total_distance_km(pois),
        "long_legs": long_legs(pois),
        "backtracks": backtracks(pois),
    }


def day_route_stats_from_day(day: Any, road_baseline: float = 1.0) -> Dict[str, Any]:
    """单日路线体检（**优先用真实驾车里程**）。

    与 day_route_stats 的区别：这里从时间轴上取 transport_to_next.distance_km——
    那是 planner 查真实路线时顺手存下的，不额外发请求。

    为什么必须用真实里程：直线距离在海湾／半岛地形会严重低估。
    实测平潭一条三天线路：直线上报 30.3 公里，实际驾车 48.8 公里，
    有 18.5 公里被藏了起来——"这段到底要跑多久"完全失真。

    「折返」仍用直线：它比较的是 A→B→C 与 A→C 三段，三段必须同一种度量，
    混用真实里程和直线会把"路本来就绕"误判成折返。
    真正的"绕行"单独由 detours 报出来，语义更清楚。

    road_baseline 是本趟规划自己估出来的绕行系数（见 skills/metrics.py）。
    海湾／岛屿城市的路本来就绕，所以"绕不绕"要跟本地的常态比，不能跟 1 比：
    实测平潭基线 2.15 倍，用固定 1.5 倍判定会把每段路都报成问题。
    """
    items = list(getattr(day, "timeline", []) or [])
    pois = [it.poi for it in items]
    #: 折返只按景点算：餐厅 / 酒店是"行程"，插在中间多跑几公里是正常的
    attractions = [p for p in pois if getattr(p, "type", "") == "景点"]
    detour_floor = max(DETOUR_RATIO, road_baseline * DETOUR_RATIO_MARGIN)

    total = 0.0
    long_found: List[Tuple[str, str, float]] = []
    detour_found: List[Tuple[str, str, float, float]] = []

    for i in range(len(items) - 1):
        a, b = items[i].poi, items[i + 1].poi
        straight = distance_km(a, b)
        trans = getattr(items[i], "transport_to_next", None)
        road = float(getattr(trans, "distance_km", 0) or 0)
        km = road if road > 0 else straight
        if km:
            total += km
        if km and km >= LONG_LEG_KM:
            long_found.append((a.name, b.name, round(km, 1)))
        if road > 0 and straight and straight > 0:
            ratio = road / straight
            if (
                ratio >= detour_floor
                and road >= DETOUR_MIN_ROAD_KM
                and (road - straight) >= DETOUR_MIN_EXTRA_KM
            ):
                detour_found.append((a.name, b.name, round(straight, 1), round(road, 1)))

    return {
        "total_km": round(total, 1),
        "long_legs": long_found,
        "backtracks": backtracks(attractions),
        "detours": detour_found,
    }


def cluster_into_days(
    pois: List[POI],
    days: int,
    per_day: int,
    must_names: Optional[set] = None,
    metrics: Any = None,
) -> List[List[POI]]:
    """把景点排成 days 天的行程：**先串成一条链，再把链切成天**。

    为什么是「先串链、再切段」，而不是每天各自聚类、更不是「从种子往外长」：

    1. **天与天的衔接天然成立**：相邻两天只差走过一条边，不需要再造一个
       "跨天权重"去把它们拉近；
    2. **不会出现"某天横跨全城"**：每天都是这条链上连续的一段。而"一天跨 9.6 公里"
       这种结果，本质上就是"把链上相隔很远的两个点塞进了同一天"；
    3. **不需要"种子"**：种子是聚类算法的副产品（必须挑一个起点才能往外长），
       链式路线里根本没有这个概念；
    4. **酒店选址跟着变准**：切点正好落在两天之间，而"当晚酒店"是选在当天与次日
       活动区之间的——它天然就贴着切点，于是「当天结束 → 酒店 → 次日第一个点」连着。

    代价是得先把所有点串成一条链（开放路径的旅行商问题）。点很少（一般 ≤ 12 个），
    所以用"每个点都当一次起点跑最近邻 + 2-opt，取最短的一条"，解的质量够用，
    而且是**确定性**的：同一批点永远给出同一条链。

    must_names 保留只为兼容调用方（必去景点由上层保证一定进候选池）；
    链式排法下它不需要特殊处理。
    """
    pts = [p for p in pois if p is not None and p.name]
    if not pts:
        return []
    days = max(1, min(days, len(pts)))
    per_day = max(1, per_day)
    return split_chain_into_days(order_chain(pts, metrics), days, per_day, metrics)


def order_chain(pois: List[POI], metrics: Any = None) -> List[POI]:
    """把一组景点串成一条尽量顺路的链（开放路径，起终点不限）。

    做法：每个点都当一次起点跑「最近邻 + 2-opt」，取总里程最短的那条。
    点多的时候这样是 O(n⁴)，但一天的行程里景点本来就只有十来个，代价可以忽略；
    换来的是**确定性**——同一批点永远给同一条链，不像随机初始化那样每次不同。
    """
    pts = [p for p in pois if p is not None and p.name]
    if len(pts) <= 2:
        return list(pts)
    best: List[POI] = list(pts)
    best_km: Optional[float] = None
    for start in pts:
        chain = order_nearest(pts, start, None, metrics)
        km = total_distance_km(chain, metrics)
        if best_km is None or km < best_km - 1e-9:
            best, best_km = chain, km
    return best


def split_chain_into_days(
    chain: List[POI], days: int, per_day: int, metrics: Any = None
) -> List[List[POI]]:
    """把一条链按顺序切成 days 段，每段 1..per_day 个点。

    切点用动态规划选：先让**最长的那一天尽量短**（用户感知最强的"某天特别赶"），
    再让各天尽量均衡。注意链的总里程与切点无关（切在哪儿都走同样的路），
    所以这里要优化的就是"别让某一天独自扛下大半路程"。
    """
    n = len(chain)
    days = max(1, min(days, n))
    per_day = max(1, per_day)
    if days == 1:
        return [list(chain)]

    legs = [
        (distance_km(chain[i], chain[i + 1], metrics) or 0.0) for i in range(n - 1)
    ]
    prefix = [0.0]
    for value in legs:
        prefix.append(prefix[-1] + value)

    # dp[k][i]：前 i 个点切成 k 段的最优 (最长段里程, 各段里程平方和)
    # 按字典序取最小 = 先压"最长的一天"，再压不均衡
    dp: List[List[Optional[Tuple[float, float]]]] = [
        [None] * (days + 1) for _ in range(n + 1)
    ]
    parent: List[List[int]] = [[-1] * (days + 1) for _ in range(n + 1)]
    dp[0][0] = (0.0, 0.0)
    for k in range(1, days + 1):
        for i in range(1, n + 1):
            best_cell: Optional[Tuple[float, float]] = None
            best_j = -1
            for j in range(max(0, i - per_day), i):
                prev = dp[j][k - 1]
                if prev is None:
                    continue
                seg = prefix[i - 1] - prefix[j]  # 链上第 j..i-1 个点这一段
                cell = (max(prev[0], seg), prev[1] + seg * seg)
                if best_cell is None or cell < best_cell:
                    best_cell, best_j = cell, j
            dp[i][k] = best_cell
            parent[i][k] = best_j

    if dp[n][days] is None:
        # 点数与"天数 × 每天上限"不匹配，切不出合法解：退回平均切，
        # 不足的天数由调用方补空天（planner 会补）。
        size = max(1, math.ceil(n / days))
        return [chain[i : i + size] for i in range(0, n, size)]

    bounds: List[Tuple[int, int]] = []
    i, k = n, days
    while k > 0:
        j = parent[i][k]
        bounds.append((j, i))
        i, k = j, k - 1
    bounds.reverse()
    return [chain[a:b] for a, b in bounds]
