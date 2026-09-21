"""Skill3：智能规划生成（核心处理层）。

生成 TravelPlan：时间轴 / 交通接驳 / 实时天气与 Plan B / 预算明细。
- 优先使用 Ollama（LLM）生成，失败自动降级为规则引擎。
- 规则引擎基于「真实 API 数据」（高德 POI / 天气）编排，不伪造景点或价格。
"""
import json
import math
import re
from datetime import date, timedelta
from typing import Any, Dict, List, Optional
from uuid import uuid4

from ..llm.client import LLMClient
from ..models.plan import (
    BudgetBreakdown,
    DailyPlan,
    Location,
    POI,
    TimelineItem,
    TransportToNext,
    TravelPlan,
    Weather,
)
from ..services.amap import AmapClient
from .base import Skill

# 各类 POI 的默认游玩耗时（小时）
DURATION_BY_TYPE: Dict[str, float] = {
    "景点": 2.5, "餐厅": 1.5, "购物": 2.0, "住宿": 0.5, "交通": 0.5,
}

# 节奏 -> 每日景点数
PACE_COUNT: Dict[str, int] = {"悠闲": 2, "适中": 3, "特种兵": 4}

# 室内景点关键词（雨天 Plan B 判断，与前端「一键换成室内」保持一致）
INDOOR_KEYWORDS = ("博物馆", "美术馆", "科技馆", "展览馆", "陈列馆", "图书馆", "商场", "购物中心", "剧院", "室内")


def _is_indoor(poi: POI) -> bool:
    """判断景点是否为室内（雨天可替换户外景点）。"""
    return any(k in poi.name for k in INDOOR_KEYWORDS)


def _haversine(a: Location, b: Location) -> float:
    """两点球面距离（公里）。"""
    r = 6371.0
    lat1, lng1 = math.radians(a.lat), math.radians(a.lng)
    lat2, lng2 = math.radians(b.lat), math.radians(b.lng)
    h = (
        math.sin((lat2 - lat1) / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(h))


def _add_minutes(t: str, minutes: int) -> str:
    """'HH:MM' 增加分钟数。"""
    h, m = map(int, t.split(":"))
    total = h * 60 + m + minutes
    return f"{total // 60 % 24:02d}:{total % 60:02d}"


class PlannerSkill(Skill):
    """智能规划生成。"""

    name = "planner"
    description = "生成可交互旅游规划 TravelPlan"

    def __init__(self, llm: Optional[LLMClient] = None, amap: Optional[AmapClient] = None):
        self.llm = llm or LLMClient()
        self.amap = amap or AmapClient()

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        must = ctx.get("must_visit_pois") or []
        plan = None
        if self.llm.available():
            plan = self._generate_llm(ctx)  # 优先 LLM，失败返回 None
        if plan and must and not self._covers(plan, must):
            plan = None  # LLM 漏排必去景点 -> 规则引擎兜底，保证必去景点全覆盖
        if plan and self._has_duplicates(plan):
            plan = None  # LLM 重复安排同一景点 -> 规则引擎兜底
        plan = plan or self._generate_rules(ctx)  # 降级规则引擎
        # 附加餐饮/酒店分档推荐与景点备选池（数据来自检索，与生成方式无关）
        plan.dining_options = ctx.get("dining_options", [])
        plan.hotel_options = ctx.get("hotel_options", [])
        plan.attraction_options = ctx.get("attraction_options", [])
        plan.travelers = ctx["preference"].travelers.total  # 出行人数，供前端预算实时重算
        plan.user_budget = ctx["preference"].budget  # 用户预算，供前端结余/超出对比
        self._finalize(plan, ctx)  # 统一收口：补齐每晚酒店 + 按统一口径重算预算（LLM 与规则路径一致）
        ctx["plan"] = plan
        return ctx

    def _finalize(self, plan: TravelPlan, ctx: dict[str, Any]) -> None:
        """统一收口：无论 LLM 还是规则引擎生成，都补齐每晚酒店并重算预算。

        原因：LLM 生成的 plan 通常不含每晚酒店（提示词未要求），预算也是模型自行
        估算的数值，与规则口径不一致。这里用检索到的酒店备选 + 统一预算公式收口，
        保证「装了 Ollama」与「未装 Ollama」两种环境看到的是同一套口径。
        """
        pref = ctx["preference"]
        nights = max(len(plan.daily_plans) - 1, 0)
        hotels = self._pick_hotels(ctx.get("hotel_options", []), nights)
        for i, day in enumerate(plan.daily_plans):
            if day.hotel is None and i < nights:
                day.hotel = hotels[i]
        transport_sum = sum(
            (item.transport_to_next.cost if item.transport_to_next else 0)
            for d in plan.daily_plans for item in d.timeline
        )
        total, breakdown = self._budget(pref, plan.daily_plans, transport_sum)
        plan.total_budget_estimate = total
        plan.budget_breakdown = breakdown

    @staticmethod
    def _covers(plan: TravelPlan, must: List[POI]) -> bool:
        """校验规划是否包含全部必去景点（按名称匹配）。"""
        names = {item.poi.name for d in plan.daily_plans for item in d.timeline}
        return all(m.name in names for m in must)

    @staticmethod
    def _has_duplicates(plan: TravelPlan) -> bool:
        """校验规划中的景点是否有重复安排。"""
        names = [
            item.poi.name for d in plan.daily_plans for item in d.timeline if item.poi.type == "景点"
        ]
        return len(names) != len(set(names))

    # ---------------- LLM 生成（可选增强）----------------
    def _generate_llm(self, ctx: dict[str, Any]) -> Optional[TravelPlan]:
        pref = ctx["preference"]
        candidates = ctx.get("attractions", [])[:12]
        payload = json.dumps(
            {
                "偏好": pref.model_dump(),
                "候选景点(名称+坐标，只能使用这些)": [p.model_dump() for p in candidates],
                "天气": {d: w.model_dump() for d, w in ctx.get("weather", {}).items()},
            },
            ensure_ascii=False,
        )
        system = (
            "你是旅游规划师。根据用户偏好和候选景点，输出一个 JSON 旅游规划，"
            "结构包含 plan_id/summary/total_budget_estimate/budget_breakdown/daily_plans。"
            "只能使用候选景点列表中的景点及其坐标，禁止编造景点名或坐标。"
            "若偏好中的 must_visit 非空，必须将其中每个景点都排进规划，并均匀分配到各天。"
            "每个景点最多只能安排一次，禁止在不同天重复同一个景点。"
        )
        data = self.llm.chat_json(system, payload)
        if not data:
            return None
        try:
            return TravelPlan.model_validate(data)
        except Exception:
            return None

    # ---------------- 规则引擎生成（稳健降级）----------------
    def _generate_rules(self, ctx: dict[str, Any]) -> TravelPlan:
        pref = ctx["preference"]
        attractions: List[POI] = ctx.get("attractions", [])
        restaurants: List[POI] = ctx.get("restaurants", [])
        weather_map: Dict[str, Weather] = ctx.get("weather", {})
        rag_tips: List[str] = ctx.get("rag_tips", [])

        # 1. 按节奏选取景点数量；必去景点必须全部纳入，均匀分摊到各天
        per_day = PACE_COUNT.get(pref.pace, 3)
        must: List[POI] = ctx.get("must_visit_pois", [])
        if must:
            per_day = max(per_day, math.ceil(len(must) / pref.duration_days))
        capacity = per_day * pref.duration_days
        others = [p for p in attractions if p.name not in {m.name for m in must}]
        selected = must + others[: max(0, capacity - len(must))]
        # 去重兜底：确保同名景点只安排一次
        seen_names: set[str] = set()
        deduped: List[POI] = []
        for p in selected:
            if p.name not in seen_names:
                seen_names.add(p.name)
                deduped.append(p)
        selected = deduped

        # 2. 生成逐日计划（每晚独立安排一家酒店，优先中档；末天退房/返程不安排住宿）
        start = pref.start_date or date.today().isoformat()
        nights = max(pref.duration_days - 1, 0)
        hotels = self._pick_hotels(ctx.get("hotel_options", []), nights)
        days: List[DailyPlan] = []
        for i in range(pref.duration_days):
            day_date = (date.fromisoformat(start) + timedelta(days=i)).isoformat()
            day_pois = selected[i * per_day : (i + 1) * per_day]
            lunch = self._pick(restaurants, i)
            dinner = self._pick(restaurants, i + pref.duration_days)
            weather = weather_map.get(day_date) or Weather(condition="", temp="")
            timeline = self._build_timeline(pref, day_pois, lunch, dinner)
            plan_b = self._plan_b(weather, attractions)
            days.append(
                DailyPlan(
                    date=day_date, weather=weather, timeline=timeline,
                    plan_b=plan_b, tips=rag_tips,
                    hotel=hotels[i] if i < nights else None,
                )
            )

        # 3. 预算拆解
        transport_sum = sum(
            (item.transport_to_next.cost if item.transport_to_next else 0)
            for d in days for item in d.timeline
        )
        total, breakdown = self._budget(pref, days, transport_sum)

        main_tags = "·".join(pref.preferences) if pref.preferences else ""
        summary = f"{pref.destination}{pref.duration_days}日{pref.pace}{main_tags}游"
        return TravelPlan(
            plan_id=str(uuid4()),
            summary=summary,
            total_budget_estimate=total,
            budget_breakdown=breakdown,
            daily_plans=days,
            travelers=pref.travelers.total,
            user_budget=pref.budget,
        )

    def _pick(self, restaurants: List[POI], i: int) -> POI:
        """按天轮换选取餐厅；无餐厅数据时返回「就近用餐」占位。"""
        if restaurants:
            return restaurants[i % len(restaurants)]
        return POI(
            name="就近用餐", type="餐厅", location=Location(lat=0, lng=0),
            tips="到店后可用地图搜索附近餐厅",
        )

    @staticmethod
    def _pick_hotels(hotel_options: List[POI], nights: int) -> List[Optional[POI]]:
        """为每个夜晚独立选一家酒店（优先中档，其次按序轮换）；无数据返回全 None。"""
        if not hotel_options:
            return [None] * nights
        mids = [h for h in hotel_options if h.tier == "中档"] or list(hotel_options)
        return [mids[i % len(mids)] for i in range(nights)]

    def _build_timeline(
        self, pref: Any, day_pois: List[POI], lunch: POI, dinner: POI
    ) -> List[TimelineItem]:
        """构建单日时间轴：上午景点 -> 午餐 -> 下午景点 -> 晚餐。"""
        mid = max(1, len(day_pois) // 2)
        seq = day_pois[:mid] + [lunch] + day_pois[mid:] + [dinner]

        items: List[TimelineItem] = []
        t = pref.departure_time
        for idx, poi in enumerate(seq):
            dur_min = int(DURATION_BY_TYPE.get(poi.type, 2.0) * 60)
            end = _add_minutes(t, dur_min)
            tips = poi.tips
            if poi.type == "景点":
                tips = (poi.tips + "；热门景点建议通过官方渠道提前预约，以景区公告为准。").strip("；")
            items.append(TimelineItem(time=f"{t}-{end}", poi=poi, tips=tips))
            t = end
            # 到下一节点的交通接驳
            if idx < len(seq) - 1:
                trans = self._transport(poi, seq[idx + 1])
                items[-1].transport_to_next = trans
                t = _add_minutes(t, self._transport_minutes(trans.duration))
        return items

    def _transport(self, a: POI, b: POI) -> TransportToNext:
        """计算两点间交通方式、耗时与费用（优先高德真实路线）。"""
        if a.location.lat == 0 or b.location.lat == 0:
            return TransportToNext(mode="步行", duration="10分钟", cost=0)
        dist = _haversine(a.location, b.location)
        # 短距离步行
        if dist < 1.5:
            mins = int(dist / 4.5 * 60) + 5
            return TransportToNext(mode="步行", duration=f"{max(mins, 5)}分钟", cost=0)
        # 长距离尝试高德驾车路线（真实耗时 + 打车费用）
        try:
            data = self.amap.get_route(
                f"{a.location.lng},{a.location.lat}",
                f"{b.location.lng},{b.location.lat}",
                "driving",
            )
            route = data["route"]
            path = route["paths"][0]
            dur_sec = int(path.get("duration", 0))
            cost = float(route.get("taxi_cost") or 0)  # 打车费在 route.taxi_cost，非 path.cost
            return TransportToNext(mode="打车", duration=f"{max(dur_sec // 60, 1)}分钟", cost=round(cost, 1))
        except Exception:
            # 高德不可用时按距离估算
            mins = int(dist / 25 * 60) + 10
            cost = max(13 + (dist - 3) * 2.5, 10) if dist > 3 else 13
            return TransportToNext(mode="打车", duration=f"{mins}分钟", cost=round(cost, 1))

    @staticmethod
    def _transport_minutes(duration: str) -> int:
        """从「15分钟」等字符串提取分钟数。"""
        m = re.search(r"\d+", duration)
        return int(m.group()) if m else 0

    @staticmethod
    def _plan_b(weather: Weather, attractions: List[POI]) -> str:
        """雨天备选方案：替换为室内景点。"""
        if weather.condition and "雨" in weather.condition:
            indoor = [p.name for p in attractions if _is_indoor(p)][:3]
            if indoor:
                return "今日有雨，可改为室内：" + "、".join(indoor)
            return "今日有雨，建议改为室内博物馆/商场，或调整行程。"
        return ""

    def _budget(self, pref: Any, days: List[DailyPlan], transport_sum: float):
        """预算拆解（估算，价格以实时为准）。

        口径说明（前端编辑后按同一口径实时重算）：
        - 门票：规划中所有景点票价求和（高德未提供票价记 0）
        - 餐饮：按每餐所选餐厅人均 × 出行人数求和（无人均按 60 元/餐/人）
        - 住宿：按每个夜晚所选酒店每晚价 × 房间数求和（未选酒店按 350 元/晚/间）
        - 交通：景点间接驳 + 往返大交通
        总预算 = 前四项之和（不虚增「购物」凑数；用户预算以 user_budget 另做结余/超出对比）
        """
        days_n = pref.duration_days
        people = pref.travelers.total
        nights = max(days_n - 1, 0)
        rooms = max(1, math.ceil(people / 2))
        tickets = sum(
            it.poi.price or 0 for d in days for it in d.timeline if it.poi.type == "景点"
        )
        meals = [it.poi for d in days for it in d.timeline if it.poi.type == "餐厅"]
        dining = sum((m.price or 60) for m in meals) * people
        hotel = sum((d.hotel.price if d.hotel else 350) for d in days[:nights]) * rooms
        transport = round(transport_sum + self._round_trip(pref), 1)
        total = round(tickets + dining + hotel + transport, 1)
        breakdown = BudgetBreakdown(
            transport=round(transport, 1), tickets=round(tickets, 1),
            dining=round(dining, 1), hotel=round(hotel, 1),
        )
        return total, breakdown

    @staticmethod
    def _round_trip(pref: Any) -> float:
        """往返大交通估算。"""
        people = pref.travelers.total
        if pref.transportation == "高铁":
            return 150 * people * 2
        if pref.transportation == "飞机":
            return 500 * people * 2
        if pref.transportation == "自驾":
            return 300
        return 0
