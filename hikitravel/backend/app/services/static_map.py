"""把规划转成高德静态地图需要的参数（markers / paths / 中心点 / 缩放级别）。

为什么要后端做：静态地图接口需要 Key，浏览器直接调会把 Key 暴露出去；
由后端代理请求、只把图片给前端，Key 始终留在服务端。

**高德静态地图的硬限制**（实测得出，超了会返回 UNKNOWN_ERROR 而不是给图）：
- markers 最多 10 个标注组；
- paths 最多 4~5 条；
- 两者合计组数也别超过 ~14。
因此这里做两件事：
1. 标记最多选 10 个（优先"景点/住宿"，餐厅能省则省），保证编号与图例一一对应；
2. 轨迹按天分组，但最多 4 条——天数多时把相邻几天合并成一条（颜色按组区分），
   这样所有点位都能落到轨迹上，不会因为超限导致整张图取不到。
"""
import math
from typing import Any, Dict, List, Tuple

from ..models.plan import POI, TravelPlan

# 实测边界：标记 ≤ 10 组、路径 ≤ 4 条最稳（10 标记 + 4 路径 = 14 组仍可用）
MAX_MARKERS = 10
MAX_PATHS = 4
# 每天（或每条轨迹）的配色
DAY_COLORS = ["0x1677FF", "0x52C41A", "0xFA8C16", "0x722ED1", "0x13C2C2", "0xEB2F96"]
# 标记编号可用字符（高德只支持单字符标签，不要用容易混淆的 0/O）
LABELS = "123456789ABCDEFGHIJKLMN"


def _valid(poi: POI) -> bool:
    """是否有有效坐标（占位数据是 0,0）。"""
    return not (poi.location.lat == 0 and poi.location.lng == 0)


def _day_points(plan: TravelPlan) -> List[List[POI]]:
    """按天收集带坐标的点位（时间轴顺序，去掉相邻重复），末尾补上当晚酒店。"""
    days: List[List[POI]] = []
    for day in plan.daily_plans:
        points: List[POI] = []
        for item in day.timeline:
            if not _valid(item.poi):
                continue
            if points and points[-1].name == item.poi.name:
                continue
            points.append(item.poi)
        if day.hotel and _valid(day.hotel) and (not points or points[-1].name != day.hotel.name):
            points.append(day.hotel)
        days.append(points)
    return days


def _fit_zoom(
    min_lat: float, max_lat: float, min_lng: float, max_lng: float, width: int, height: int
) -> int:
    """选一个能把所有点装进图幅的缩放级别（留 20% 边距）。"""
    mean_lat = math.radians((min_lat + max_lat) / 2)
    span_w = max((max_lng - min_lng) * 111320 * math.cos(mean_lat), 200.0)
    span_h = max((max_lat - min_lat) * 110540, 200.0)
    for zoom in range(17, 3, -1):
        meters_per_pixel = 156543.03392 * math.cos(mean_lat) / (2 ** zoom)
        if span_w / meters_per_pixel <= width * 0.8 and span_h / meters_per_pixel <= height * 0.8:
            return zoom
    return 4


def _pick_markers(days: List[List[POI]], limit: int) -> List[Tuple[POI, int]]:
    """挑出要在地图上标注的点：优先景点/住宿，其次餐厅；返回 [(点, 第几天)]。"""
    candidates: List[Tuple[POI, int]] = [
        (poi, day_index) for day_index, points in enumerate(days) for poi in points
    ]
    if len(candidates) <= limit:
        return candidates
    preferred = [c for c in candidates if c[0].type in ("景点", "住宿")]
    others = [c for c in candidates if c[0].type not in ("景点", "住宿")]
    picked = preferred[:limit]
    # 优先点不够就按原顺序补餐厅，保持"图上顺序 = 行程顺序"
    for item in others:
        if len(picked) >= limit:
            break
        picked.append(item)
    return sorted(picked, key=lambda c: candidates.index(c))


def _path_groups(days: List[List[POI]]) -> List[List[POI]]:
    """把每天的点位合并成不超过 MAX_PATHS 条轨迹（天数多时相邻几天合并）。"""
    non_empty = [points for points in days if points]
    if not non_empty:
        return []
    bucket_size = max(1, math.ceil(len(non_empty) / MAX_PATHS))
    groups: List[List[POI]] = []
    for start in range(0, len(non_empty), bucket_size):
        merged: List[POI] = []
        for points in non_empty[start : start + bucket_size]:
            for poi in points:
                if merged and merged[-1].name == poi.name:
                    continue
                merged.append(poi)
        if merged:
            groups.append(merged)
    return groups


def build_static_map_params(
    plan: TravelPlan, width: int = 800, height: int = 520
) -> Dict[str, Any]:
    """生成 staticmap 接口所需参数（已按高德限制裁剪）。"""
    days = _day_points(plan)
    all_points: List[POI] = [p for day in days for p in day]
    if not all_points:
        raise ValueError("规划里没有带坐标的点位，无法生成地图。")

    markers: List[str] = []
    for index, (poi, day_index) in enumerate(_pick_markers(days, MAX_MARKERS)):
        color = DAY_COLORS[day_index % len(DAY_COLORS)]
        label = LABELS[index % len(LABELS)]
        markers.append(f"mid,{color},{label}:{poi.location.lng:.5f},{poi.location.lat:.5f}")

    paths: List[str] = []
    for index, group in enumerate(_path_groups(days)[:MAX_PATHS]):
        if len(group) < 2:
            continue
        color = DAY_COLORS[index % len(DAY_COLORS)]
        coords = ";".join(f"{p.location.lng:.5f},{p.location.lat:.5f}" for p in group)
        # 线宽, 颜色, 透明度, 填充色, 填充透明度
        paths.append(f"5,{color},0.9,0x000000,0:{coords}")

    lats = [p.location.lat for p in all_points]
    lngs = [p.location.lng for p in all_points]
    min_lat, max_lat = min(lats), max(lats)
    min_lng, max_lng = min(lngs), max(lngs)
    return {
        "center": f"{(min_lng + max_lng) / 2:.5f},{(min_lat + max_lat) / 2:.5f}",
        "zoom": _fit_zoom(min_lat, max_lat, min_lng, max_lng, width, height),
        "size": f"{width}*{height}",
        "markers": "|".join(markers),
        "paths": "|".join(paths),
    }


def build_legend(plan: TravelPlan) -> List[Dict[str, Any]]:
    """与图片上编号标记一一对应的图例（编号 / 名称 / 类型 / 日期 / 时间 / 颜色）。

    编号规则必须与 build_static_map_params 完全一致（同样按"优先景点/住宿"挑选、
    同样按行程顺序编号），前端才能把图上的编号和列表里的行对上。
    """
    days = _day_points(plan)
    picked = _pick_markers(days, MAX_MARKERS)
    label_by_name = {poi.name: LABELS[i % len(LABELS)] for i, (poi, _) in enumerate(picked)}

    legend: List[Dict[str, Any]] = []
    for day_index, day in enumerate(plan.daily_plans):
        for item in day.timeline:
            if item.poi.name not in label_by_name or not _valid(item.poi):
                continue
            legend.append(
                {
                    "label": label_by_name[item.poi.name],
                    "name": item.poi.name,
                    "type": item.poi.type,
                    "date": day.date,
                    "time": item.time,
                    "day_index": day_index,
                    "color": DAY_COLORS[day_index % len(DAY_COLORS)],
                }
            )
            label_by_name.pop(item.poi.name)  # 同一个点只出现在图例里一次
        # 酒店不在时间轴里，单独补一行，否则图上有标记、图例里却没有
        if day.hotel and day.hotel.name in label_by_name and _valid(day.hotel):
            legend.append(
                {
                    "label": label_by_name[day.hotel.name],
                    "name": day.hotel.name,
                    "type": day.hotel.type,
                    "date": day.date,
                    "time": "当晚住宿",
                    "day_index": day_index,
                    "color": DAY_COLORS[day_index % len(DAY_COLORS)],
                }
            )
            label_by_name.pop(day.hotel.name)
    return legend
