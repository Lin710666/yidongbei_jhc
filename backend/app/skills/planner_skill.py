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

# ---- 市内接驳的分档阈值（公里）----
#
# 为什么要有这几档：原来 `_transport()` 只要距离 ≥1.5km 就一律按「打车」计费，
# 于是"从松江广富林打车 40 公里回人民广场吃饭"这种段落被算成 138 元，
# 跨城的段更是一次四五百 —— 用户看到的"预算虚高"主要来自这里。
# 现实里这段距离的常态是地铁/公交（2~8 元/人），不是打车。
WALK_MAX_KM = 1.5        # 走路过去
TRANSIT_MAX_KM = 12.0    # 地铁/公交够用
TAXI_MAX_KM = 60.0       # 打车合理（跨区、近郊）；再远就是城际，不该按打车算

#: 城市名 → 经纬度、以及两城距离的进程内缓存。
#: 键为 ("geo", 城市名) 或 (出发地, 目的地)。
_CITY_DIST_CACHE: Dict[Any, Any] = {}

#: 城市名归一化时要剥掉的后缀（"杭州市" 与 "杭州" 要认成同一个）
_CITY_SUFFIXES = ("市辖区", "自治州", "地区", "盟", "市", "县", "区", "镇")


def _same_city(a: str, b: str) -> bool:
    """两个地名是不是同一个城市（宽松判断：剥掉"市/县/区"等后缀再比）。

    用来识别"出发地就是目的地"——这种情况不该再收一笔往返大交通。
    """
    def norm(s: str) -> str:
        t = str(s or "").strip().replace(" ", "")
        for suf in _CITY_SUFFIXES:
            if len(t) > len(suf) and t.endswith(suf):
                t = t[: -len(suf)]
                break
        return t

    na, nb = norm(a), norm(b)
    if not na or not nb:
        return False
    # 「杭州」vs「杭州西湖区」这种也算同城：短的包含在长的里
    return na == nb or na in nb or nb in na


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
    #: 一天排到几点算"排太满"。超过它就该少放一个景点，而不是把晚饭挤到深夜。
    DAY_END = "20:30"

    @staticmethod
    def _safe_per_day(pref: Any, want: int) -> int:
        """按**当天真实可用时间**反算一天能放几个景点。

        为什么需要：原来直接取 PACE_COUNT（悠闲2 / 适中3 / 特种兵4），
        默认「适中」就是 3 个景点/天。而每个景点按 DURATION_BY_TYPE 是 2.5 小时，
        再加两餐 3 小时、景点间接驳，从 09:00 出发算下来是 11 小时以上 ——
        实测成都的方案里，第三天的晚餐被排到了 **23:20-00:50**，
        第二天的晚餐 21:33 开始。一天塞 3 个景点就是会排到半夜。

        算法：可用时长 = 出发 → DAY_END；减去两餐；剩下的按
        「单个景点 + 一次接驳」平摊。算出来至少留 1 个。
        """
        try:
            hh, mm = (pref.departure_time or "09:00").split(":")[:2]
            start = int(hh) * 60 + int(mm)
            eh, em = PlannerSkill.DAY_END.split(":")
            end = int(eh) * 60 + int(em)
            free = end - start
        except Exception:                       # noqa: BLE001 - 时间格式怪就用默认窗口
            free = 690                          # 09:00 → 20:30
        meal_min = int(DURATION_BY_TYPE["餐厅"] * 60) * 2      # 午餐 + 晚餐
        per_item = int(DURATION_BY_TYPE["景点"] * 60) + 30     # 景点 + 接驳
        if per_item <= 0:
            return want
        fits = (free - meal_min) // per_item
        return max(1, min(want, int(fits)))

    def _generate_rules(self, ctx: dict[str, Any]) -> TravelPlan:
        pref = ctx["preference"]
        attractions: List[POI] = ctx.get("attractions", [])
        restaurants: List[POI] = ctx.get("restaurants", [])
        weather_map: Dict[str, Weather] = ctx.get("weather", {})
        rag_tips: List[str] = ctx.get("rag_tips", [])

        # 1. 按节奏选取景点数量；必去景点必须全部纳入，均匀分摊到各天
        #
        # 「节奏」只决定**上限**，真正放几个还要看一天装不装得下（_safe_per_day）。
        # 不夹这一道的话，"适中"会把晚饭排到 23 点之后（实测踩过）。
        per_day = self._safe_per_day(pref, PACE_COUNT.get(pref.pace, 3))
        must: List[POI] = ctx.get("must_visit_pois", [])
        if must:
            # 必去景点是用户点名要的，装不下也得装（超时交给输出层质检提示）
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

        # ★ 按"就近串联"重排，再按天切片。
        #
        # 原来 selected 就是高德相关度顺序，然后 `selected[i*per_day:(i+1)*per_day]`
        # 直接切成每天 —— 于是一天的景点可能横跨全城：实测上海会排出
        # 「松江广富林（40km 外）+ 市中心城隍庙」同一天，光这两点之间打车就 140 元。
        # 用最近邻把点串成一条地理上连续的路线之后，同一天的点都在附近，
        # 长距离打车自然就没了（同时每天的游览动线也更合理）。
        selected = self._nearest_neighbour_order(selected)

        # 2. 生成逐日计划（每晚独立安排一家酒店，优先中档；末天退房/返程不安排住宿）
        start = pref.start_date or date.today().isoformat()
        nights = max(pref.duration_days - 1, 0)
        hotels = self._pick_hotels(ctx.get("hotel_options", []), nights)
        people = pref.travelers.total
        used_restaurants: set = set()          # 同一家餐厅不要重复出现在两天里
        days: List[DailyPlan] = []
        for i in range(pref.duration_days):
            day_date = (date.fromisoformat(start) + timedelta(days=i)).isoformat()
            day_pois = selected[i * per_day : (i + 1) * per_day]
            mid = max(1, len(day_pois) // 2)
            # 午餐锚在**上午那半**景点附近、晚餐锚在**下午那半**附近 ——
            # 不能都用全天中心点：实测下午在 32km 外的广富林时，
            # 晚餐被安排回市中心，又多出 32km / 136 元的一趟车。
            # 时间轴的顺序就是 [上午景点] [午餐] [下午景点] [晚餐]（见 _build_timeline）。
            lunch = self._pick(restaurants, i, anchors=day_pois[:mid] or day_pois, used=used_restaurants)
            used_restaurants.add(lunch.name)
            dinner = self._pick(
                restaurants, i + pref.duration_days,
                # 只锚在**下午那半**景点上，不要把午餐也算进来 ——
                # 午餐多半在市中心，把它的坐标平均进去会把晚餐又拉回市区，
                # 于是"下午在 32km 外的广富林、晚餐排回人广"再来一趟 138 元的车。
                anchors=day_pois[mid:] or day_pois, used=used_restaurants,
            )
            used_restaurants.add(dinner.name)
            weather = weather_map.get(day_date) or Weather(condition="", temp="")
            timeline = self._build_timeline(pref, day_pois, lunch, dinner, people)
            plan_b = self._plan_b(weather, attractions)
            days.append(
                DailyPlan(
                    date=day_date, weather=weather, timeline=timeline,
                    plan_b=plan_b,
                    # 按天分发，不要每天贴同一份（见 _split_tips 的注释）
                    tips=self._split_tips(rag_tips, pref.duration_days, i),
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

    def _pick(
        self,
        restaurants: List[POI],
        i: int,
        anchors: Optional[List[POI]] = None,
        used: Optional[set] = None,
    ) -> POI:
        """选一家餐厅：**优先当天景点附近的**，而不是盲目轮换。

        ★ 这是"打车费虚高"的另一半根因。

        原来写的是 `restaurants[i % len(restaurants)]` —— 只按天数轮换，
        **完全不看位置**。于是会出现：
            在松江「广富林文化遗址」玩完，午餐安排到人民广场的「Ministry Of Crab」，
            中间打车 40 公里、138 元（实测数据）。
        同一天里景点和餐厅离得远，交通费自然就飞起来了。

        现在的做法：当天景点地理位置的中心点（没景点就用第一个锚点），
        在**没用过**的餐厅里挑距离最近的那家。位置拿不到（坐标为 0）时退回轮换，
        保证行为和以前一样可用。
        """
        if not restaurants:
            return POI(
                name="就近用餐", type="餐厅", location=Location(lat=0, lng=0),
                tips="到店后可用地图搜索附近餐厅",
            )

        pool = [r for r in restaurants if r.name not in (used or set())] or list(restaurants)
        anchor = self._anchor_location(anchors or [])
        if anchor is None:
            return pool[i % len(pool)]

        def dist_to(r: POI) -> float:
            if r.location.lat == 0 and r.location.lng == 0:
                return float("inf")            # 没坐标的排最后，别让它抢了就近的位
            return _haversine(anchor, r.location)

        # 按距离排序；距离相同的保持原顺序（restaurants 本身是按相关度来的）
        best = sorted(enumerate(pool), key=lambda kv: (dist_to(kv[1]), kv[0]))[0][1]
        if any(r.location.lat or r.location.lng for r in pool):
            return best
        return pool[i % len(pool)]

    @staticmethod
    def _nearest_neighbour_order(pois: List[POI]) -> List[POI]:
        """按最近邻把 POI 串成一条地理上连续的路线（贪心，够用且便宜）。

        为什么需要：`selected` 是高德的相关度顺序，直接按 N 个一天切片，
        一天之内可能出现横跨 40 公里的两个点（实测：松江广富林 + 市中心城隍庙），
        那一段打车就 140 元。串成连续路线之后，同一天的点都在附近。

        细节：
          · 从第一个点出发（它通常是相关度最高的，起点保持稳定）
          · 没有坐标的点不参与排序，**保持它们的相对位置垫在最后** ——
            否则会把"就近用餐"这类占位 POI 搅进路线里
          · 点数很少时（≤2）直接返回，不必折腾
        """
        with_geo = [p for p in pois if p.location.lat or p.location.lng]
        without = [p for p in pois if not (p.location.lat or p.location.lng)]
        if len(with_geo) <= 2:
            return list(pois)

        rest = with_geo[1:]
        ordered = [with_geo[0]]
        while rest:
            cur = ordered[-1].location
            idx = min(
                range(len(rest)),
                key=lambda i: _haversine(cur, rest[i].location),
            )
            ordered.append(rest.pop(idx))
        return ordered + without

    @staticmethod
    def _anchor_location(pois: List[POI]) -> Optional[Location]:
        """一组 POI 的地理中心；全都没坐标就返回 None。"""
        pts = [p.location for p in pois if p.location.lat or p.location.lng]
        if not pts:
            return None
        return Location(
            lat=sum(p.lat for p in pts) / len(pts),
            lng=sum(p.lng for p in pts) / len(pts),
        )

    @staticmethod
    def _pick_hotels(hotel_options: List[POI], nights: int) -> List[Optional[POI]]:
        """为每个夜晚独立选一家酒店（优先中档，其次按序轮换）；无数据返回全 None。"""
        if not hotel_options:
            return [None] * nights
        mids = [h for h in hotel_options if h.tier == "中档"] or list(hotel_options)
        return [mids[i % len(mids)] for i in range(nights)]

    @staticmethod
    def _split_tips(tips: List[str], days: int, i: int) -> List[str]:
        """把检索到的贴士**按天分发**，而不是每天贴同一份。

        原来写的是 `tips=rag_tips` —— 把同一个列表对象塞进每一天，
        于是方案里同一条贴士出现 N 次（实测：2 天方案 10 条贴士里 5 条重复）。
        贴士本来就该是"今天这几条"，不是"每天全部"。

        分发方式：按天取模切片（第 i 天拿 tips[i::days]、再按天去重），
        条数够就雨露均沾，条数不够就后面的天少几条 —— 总之不重复。
        """
        if not tips:
            return []
        per_day = tips if days <= 1 else tips[i::days]
        return list(dict.fromkeys(per_day))     # 去重但保持原顺序

    def _build_timeline(
        self, pref: Any, day_pois: List[POI], lunch: POI, dinner: POI, people: int = 1
    ) -> List[TimelineItem]:
        """构建单日时间轴：上午景点 -> 午餐 -> 下午景点 -> 晚餐。

        `people` 只用于交通费 —— 地铁/公交按人计价，打车按车计价，
        两者的口径不一样，所以要把人数传下去（见 `_transport`）。
        """
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
                trans = self._transport(poi, seq[idx + 1], people)
                items[-1].transport_to_next = trans
                t = _add_minutes(t, self._transport_minutes(trans.duration))
        return items

    def _transport(self, a: POI, b: POI, people: int = 1) -> TransportToNext:
        """计算两点间交通方式、耗时与费用（优先高德真实路线）。

        ★ 按距离分档，**不再一律按打车计费**。

        原来的写法是：只要距离 ≥1.5km 就调高德驾车路线、取 `route.taxi_cost`
        （打车费）当这段的交通费。于是计划里出现"从松江广富林打车 40 公里回
        人民广场吃饭"这种段落时，光那一段就 138 元；要是哪天混进跨城的点，
        一次就是四五百 —— 用户看到的"预算虚高"主要来自这里。

        实测（修复前）：上海 2 天，6 段接驳全是"打车"，合计 350 元，
        其中两段 137~138 元。

        现在的分档：
             < 1.5km  步行        0 元
          ≤ 12km     地铁/公交    按人计价 2~8 元（20km/h 含换乘）
          ≤ 60km     打车        用高德真实出租车费（跨区/近郊，打车是合理的）
          > 60km     城际        不打车，按高铁二等座估（这种段本来就不该出现在同一天）
        """
        if a.location.lat == 0 or b.location.lat == 0:
            return TransportToNext(mode="步行", duration="10分钟", cost=0)
        dist = _haversine(a.location, b.location)
        n = max(int(people or 1), 1)

        # 短距离步行
        if dist < WALK_MAX_KM:
            mins = int(dist / 4.5 * 60) + 5
            return TransportToNext(mode="步行", duration=f"{max(mins, 5)}分钟", cost=0)

        # 市内公共交通：地铁/公交才是这个距离段的常态
        if dist <= TRANSIT_MAX_KM:
            fare = min(2.0 + max(0.0, dist - 4) * 0.25, 8.0)    # 2 元起步，封顶 8 元/人
            mins = int(dist / 20 * 60) + 8                       # 含候车换乘，按 20km/h
            return TransportToNext(
                mode="地铁", duration=f"{max(mins, 12)}分钟", cost=round(fare * n, 1)
            )

        # 跨区/近郊：打车是合理的，用高德真实出租车费
        if dist <= TAXI_MAX_KM:
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
                if cost <= 0:                              # 高德没给就按计价规则估
                    cost = 13 + (dist - 3) * 2.3
                return TransportToNext(
                    mode="打车", duration=f"{max(dur_sec // 60, 1)}分钟", cost=round(cost, 1)
                )
            except Exception:
                mins = int(dist / 25 * 60) + 10
                cost = 13 + (dist - 3) * 2.3
                return TransportToNext(mode="打车", duration=f"{mins}分钟", cost=round(cost, 1))

        # 城际：这么远**不能按打车算**（打车跨城既不现实、单价也离谱）
        per_km = 0.45                                            # 高铁二等座约 0.45 元/km/人
        fare = max(dist * per_km, 25.0) * n
        mins = int(dist / 200 * 60) + 40                         # 200km/h + 进出站
        return TransportToNext(mode="城际", duration=f"{mins}分钟", cost=round(fare, 1))

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

    def _round_trip(self, pref: Any) -> float:
        """往返大交通估算：按**出发地 → 目的地的实际距离**算，不再拍脑袋给固定值。

        原来写死了三个常数（高铁 150×人数×2 / 飞机 500×人数×2 / 自驾 300），
        还**完全无视出发地** —— 表单让用户填「出发地」，后端却从来没有用过它。
        后果：
          · 杭州→上海（约 170km）和杭州→乌鲁木齐（约 3900km）估出来一样；
          · **同城游也照收 600 元"往返高铁"**（实测：杭州市内 2 天、2 人，
            交通分项 830 = 接驳 230 + 凭空多出来的往返 600）。

        现在：同城 → 0；跨城 → 按两地实际距离 × 单价；拿不到距离
        （没填出发地 / 地理编码失败 / 没配高德 Key）才回退到原来的固定值 —— 宁可
        保守，也不假装知道。
        """
        people = pref.travelers.total
        mode = getattr(pref, "transportation", "") or "本地"
        if mode == "本地":
            return 0.0                              # 本地游没有大交通

        origin = str(getattr(pref, "origin", "") or "").strip()
        dest = str(getattr(pref, "destination", "") or "").strip()
        if origin and dest and _same_city(origin, dest):
            return 0.0                              # 出发地就是目的地，不存在往返

        km = self._city_distance_km(origin, dest) if (origin and dest) else None
        if km is None:
            # 回退：原来那套固定值（不知道距离时只能保守估）
            return {"高铁": 150.0 * people * 2, "飞机": 500.0 * people * 2, "自驾": 300.0}.get(mode, 0.0)

        if mode == "自驾":
            # 油费 + 过路费约 1 元/km，**按车算**（不乘人数），往返
            return round(max(km * 1.0, 30.0) * 2, 1)

        if mode == "飞机":
            one_way = max(km * 0.60, 250.0)         # 含机建燃油的粗估
        else:                                       # 高铁
            one_way = max(km * 0.45, 25.0)          # 二等座约 0.45 元/km
        return round(one_way * people * 2, 1)

    def _city_distance_km(self, origin: str, dest: str) -> Optional[float]:
        """两个城市之间的直线距离（公里）。查不到返回 None。

        走高德地理编码把城市名变成经纬度，再算球面距离。结果**进程内缓存** ——
        同一个城市名在一次进程里只查一次，不然每次规划都要多打两次接口。
        """
        cache = _CITY_DIST_CACHE
        key = (origin, dest)
        if key in cache:
            return cache[key]
        p1 = cache.get(("geo", origin))
        if p1 is None:
            p1 = self.amap.geocode(origin)
            cache[("geo", origin)] = p1
        p2 = cache.get(("geo", dest))
        if p2 is None:
            p2 = self.amap.geocode(dest)
            cache[("geo", dest)] = p2
        if not p1 or not p2:
            cache[key] = None
            return None
        km = round(
            _haversine(
                Location(lat=p1[0], lng=p1[1]),
                Location(lat=p2[0], lng=p2[1]),
            ),
            1,
        )
        cache[key] = km
        return km