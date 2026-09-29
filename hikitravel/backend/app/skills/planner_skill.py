"""Skill3：智能规划生成（核心处理层）。

分工（与用户对齐）：
- **大模型只做它擅长的**：从候选池里挑出"这次要去哪些景点"，给出游玩贴士，
  并且保证必去景点一个不漏。不要求它分天、不要求它排时间——"哪天去哪几个"本质是
  几何问题，交给代码算得更准，输出也更短（生成更快）。
- **系统做确定性的部分**：
  1. 按地理邻近把选中的景点聚成「每天一区」（同一天不会横跨全城）；
  2. **先按综合分定当天酒店**（评分 + 离当天/次日活动区的距离），
     再把酒店当起点做最近邻排序 —— 这样路线不折返；
  3. 按作息规则插午餐/晚餐（不早于 8:00 出发、午餐不晚于 14:00、晚餐不早于 17:30）；
  4. 用高德真实路线算接驳、按真实价格算预算。

只走大模型这一条路：大模型不可用直接抛 LLMUnavailableError，不降级、不伪造数据。
"""
import json
import logging
import math
from datetime import date, timedelta
from typing import Any, Dict, List, Optional
from uuid import uuid4

from pydantic import BaseModel, Field

from ..llm.client import LLMClient
from ..config import settings
from ..models.plan import (
    BudgetBreakdown,
    CheckIssue,
    DailyPlan,
    POI,
    TimelineItem,
    TransportToNext,
    TravelPlan,
    Weather,
)
from ..services.amap import AmapClient
from .base import Skill
from .errors import LLMOutputError, LLMUnavailableError
from .metrics import RoadMetrics
from .opening_hours import fits_open_time
from .route import cluster_into_days, order_chain, order_nearest, split_chain_into_days
from .scoring import (
    distance_km,
    has_location,
    hotel_cut_score,
    is_local_specialty,
    meal_score,
    option_score,
)

logger = logging.getLogger("travelplanner.planner")

# 各类 POI 的默认耗时（小时）。景点与餐厅的耗时随节奏变化——见下面 PACE_DURATION。
def _nearest_km(poi: POI, pool: List[POI], metrics: Any = None) -> float:
    """该点到一组点的最近距离；都缺坐标时返回 inf（当作"够不着"）。"""
    ds = [d for d in (distance_km(poi, other, metrics) for other in pool) if d is not None]
    return min(ds) if ds else float("inf")


def _within_detour(
    poi: POI,
    prev_poi: Optional[POI],
    next_poi: Optional[POI],
    metrics: Any = None,
) -> bool:
    """"专门去吃的店"离链上前后任一站在允许范围内就算顺得上。

    内容优先不等于无限绕路：太远的仍然退回几何挑法，并如实告诉用户没排进去。
    """
    anchors = [p for p in (prev_poi, next_poi) if p is not None]
    if not anchors:
        return True
    distances = [distance_km(poi, a, metrics) for a in anchors]
    known = [d for d in distances if d is not None]
    if not known:
        return True
    return min(known) <= MEAL_FEATURED_MAX_KM


def _rough_km(
    poi: POI, prev_poi: Optional[POI], next_poi: Optional[POI], metrics: Any = None
) -> float:
    """该点到链上前后两点的里程之和（缺坐标的段不计）。用于"绕路多少"的比较。"""
    total = 0.0
    for anchor in (prev_poi, next_poi):
        if anchor is None:
            continue
        d = distance_km(poi, anchor, metrics)
        if d is not None:
            total += d
    return total


def _featured_detour_ok(
    best: POI,
    candidates: List[POI],
    prev_poi: Optional[POI],
    next_poi: Optional[POI],
    metrics: Any = None,
    start_minute: Optional[int] = None,
    meal_minutes: int = 60,
) -> bool:
    """内容店可以多绕路，但要有额度：最多比"就近能吃的备选"多绕 MEAL_CONTENT_EXTRA_KM。

    比较基准只取"到点还在营业"的备选——如果附近的店那时都关门了，拿它们当基准
    是不公平的（那样内容店反而会被自己的优点卡住）。
    """
    usable = [
        p
        for p in candidates
        if start_minute is None or fits_open_time(p.open_time, start_minute, meal_minutes)
    ]
    pool = usable or candidates
    baseline = min(
        (_rough_km(p, prev_poi, next_poi, metrics) for p in pool), default=None
    )
    if baseline is None:
        return True
    return _rough_km(best, prev_poi, next_poi, metrics) <= baseline + MEAL_CONTENT_EXTRA_KM


DURATION_BY_TYPE: Dict[str, float] = {
    "购物": 2.0, "住宿": 0.5, "交通": 0.5,
}

#: 节奏 -> 每个景点 / 每餐的耗时（小时）。
#:
#: 为什么必须随节奏变：每天**景点数**本来就随节奏变（悠闲 2 / 适中 3 / 特种兵 4），
#: 但耗时原来是固定的 2.5 小时。算一下特种兵的一天：
#:     4 个景点 × 2.5h = 10h，加两餐 3h = 13h，再加接驳必然超过 8:00~21:00 的窗口
#: 于是"超时砍景点"的逻辑会把第 4 个景点砍掉——**"特种兵"和"适中"实际没差别**。
#: 节奏本来就该同时决定"去几个"和"每个待多久"。
PACE_DURATION: Dict[str, Dict[str, float]] = {
    "悠闲": {"景点": 2.5, "餐厅": 1.5},
    "适中": {"景点": 1.8, "餐厅": 1.2},
    "特种兵": {"景点": 1.2, "餐厅": 1.0},
}


def _duration(poi: POI, pace: Optional[str]) -> float:
    """某个节点的耗时（小时）：先按节奏查，再退回按类型的默认值。"""
    table = PACE_DURATION.get(pace or "", {})
    if poi.type in table:
        return table[poi.type]
    return DURATION_BY_TYPE.get(poi.type, 2.0)

# 节奏 -> 每天建议景点数
PACE_COUNT: Dict[str, int] = {"悠闲": 2, "适中": 3, "特种兵": 4}

# 作息规则（与用户对齐）：除了特种兵，出发不早于 8 点；午餐不晚于 14 点；晚餐不早于 17:30
DAY_START_EARLIEST = "08:00"
DAY_START_EARLIEST_SPECIAL = "07:00"
LUNCH_EARLIEST = "11:30"
LUNCH_LATEST = "14:00"
DINNER_EARLIEST = "17:30"

# 室内景点关键词：雨天 Plan B 与前端「一键换成室内」保持一致
INDOOR_KEYWORDS = (
    "博物馆", "美术馆", "科技馆", "展览馆", "陈列馆", "图书馆",
    "商场", "购物中心", "剧院", "室内",
)

# 体力消耗大的景点关键词：只用于"同行有老人"时给一条提示。
# 这是对高德返回的 POI 名称做归类（和上面的 INDOOR_KEYWORDS 同一性质），
# 不是用来理解用户语言的——用户怎么说都还能表达，POI 名字却只有这一种来源。
# 命中只提示、不干预排线，措辞里也注明以景区官方说明为准。
ARDUOUS_KEYWORDS = ("山", "峰", "岭", "峡", "栈道", "索道", "漂流", "长城", "徒步")

# 步行阈值（公里）：低于该距离直接步行，不再调驾车路线
WALK_THRESHOLD_KM = 1.5

# 微调餐厅时允许的绕路余量（公里）：在这个范围内不比距离，只比综合分
MEAL_DIST_TOLERANCE_KM = 0.3

# 选酒店时先用"直线×系数"粗筛出离切点最近的几家，再对这几家查真实路线。
# 候选池有几十家酒店，全部查两条真实路线会白白多花上百次调用。
HOTEL_SHORTLIST = 6

#: 挑餐厅时只看"链上这个位置附近"的前几家，再在其中比综合分。
#: 不先收窄的话，评分权重（0.4）会让远处的高分店胜出——实测出现过 9.32 公里的接驳。
MEAL_NEARBY_LIMIT = 5

#: 收窄候选时的"内容通道"名额：除了最近的 5 家，再按综合分放进来几家**本地特色店**
#: （要求"比最近的那家最多多绕 MEAL_CONTENT_EXTRA_KM"，见下）。
#: 为什么需要这条通道：只按距离取前 5 家时，景点门口的麦当劳永远在名单里，而 2 公里外
#: 的本地老店连参评资格都没有——加分再多也救不回来。实测（平潭）就是这样把
#: 「麦当劳(龙王头海洋公园店)」排进了第 2 天的午餐。
MEAL_LOCAL_EXTRA = 3

#: **内容最多值多少路**（公里，前后两段合计）。口径是"比最近的那家多开多少"，
#: 不是"离景点几公里以内"——后者会放进这种店：它离下一个景点只有 4 公里，
#: 但从当前位置过去要开 10 公里（实测平潭第 1 天的午餐就是这样）。
#: 同一个额度用在三个地方，保证口径一致：
#: ①"值得专门去吃"的店要不要为它改就近的店；②本地特色店能不能进候选池；
#: ③最后比综合分时，明显更远的候选直接不参与（免得评分/特色压过"少开几公里"）。
#: 实测标定：平潭第 1 天那家本地老店比最近候选多绕 6.7 公里（不该排进去），
#: 而挨着景点、多绕不到 1 公里的本地老店（该排进去），6.0 正好卡在两者之间。
MEAL_CONTENT_EXTRA_KM = 6.0

#: 给大模型挑"值得专门去吃"的店时，最多给几家候选。
#: 给全量会让提示词暴涨（实测全塞进去 ≈ +2700 token ≈ +50 秒预填充）。
DINING_CANDIDATE_LIMIT = 12

#: "专门去吃的店"允许的最大绕路（公里）：离链上前后任一站在这个范围内才优先安排。
#: 内容优先不等于无限绕路——太远的仍然退回几何挑法，并如实告诉用户没排进去。
MEAL_FEATURED_MAX_KM = 15.0

#: 补足名额时，先按质量圈定这么多个候选，再从里面挑离已选景点最近的。
#: 太大就等于没按位置挑，太小又会把质量压得很低。
FILL_QUALITY_POOL = 6

#: 找替补时，"离餐厅的距离"折算成公里数的权重（相对"离当天其它点的最远距离"）。
#: 0.5 表示：为了离餐厅近 2 公里，可以接受当天跨度多 1 公里。
AMENITY_WEIGHT = 0.5

# 往返大交通估算单价（元/人/单程）：仅用于估算，真实票价以用户购票为准
ROUND_TRIP_UNIT = {"高铁": 150.0, "飞机": 500.0, "自驾": 300.0, "本地": 0.0}

_SYSTEM_PROMPT = """你是一个旅游景点挑选助手。请根据用户画像，从候选景点里挑出这次值得去的景点。
只输出一个合法 JSON 对象，不要输出解释文字或代码块。

输出结构：
{
  "summary": "一句话行程摘要",
  "attractions": [
    {"name": "景点名称（必须与候选列表完全一致）", "tips": "该景点的游玩贴士，可留空"}
  ],
  "dining": [
    {"name": "餐厅名称（必须与餐厅候选完全一致）", "tips": "为什么值得专门去吃，一句话"}
  ]
}

硬性要求：
1. 只能使用「候选景点」列表里的景点，name 必须完全一致；禁止编造景点名。
2. 「必去景点」必须全部包含，一个都不能漏。
3. 不要重复列出同一个景点。
4. 景点总数量参考「建议总数量」（= 天数 × 每天景点数），不要明显超出。
5. 「候选景点」已经按地理位置分成若干片，**每片对应一天**。请尽量在片内挑，
   不要把不同片（城市两端）的点凑到同一天——同一天的点必须能顺路走完。
6. **不要输出每一天的分配、不要输出时间、不要输出餐厅与酒店**——
  系统会按地理位置自动把景点分到每天，并按"先定酒店、再排路线"的方式安排顺序。
   （例外：见第 8 条，需要你挑几家"值得专门去吃"的店。）
7. 如果输入里给了「需要修正的问题（上一版体检结论）」，请针对这些问题重新挑选。
8. dining：从「餐厅候选」里挑出**值得专门去吃**的店（本地特色、老字号、口碑店），
   最多挑「天数」家。判断依据是店名与招牌菜，不要选连锁快餐（麦当劳/肯德基这类），
   除非候选里实在没有别的。没有合适的就留空数组。
   这些店允许为它多绕一点路，系统会优先把它们排进行程。

只输出 JSON。"""


class _DraftItem(BaseModel):
    """大模型给出的单个景点。"""

    name: str
    tips: str = ""


class _DraftPlan(BaseModel):
    """大模型给出的第一版规划（扁平景点清单 + 摘要 + 想专门去吃的店）。"""

    summary: str = ""
    attractions: List[_DraftItem] = Field(default_factory=list)
    #: 想**专门去吃**的餐厅（内容驱动，允许为它绕一点路）。
    #: 这是修"5/20 份规划把麦当劳排进行程"的关键：以前餐厅全由几何填空，
    #: 谁离景点近、评分不低谁赢，连锁快餐就这么赢了本地老店。
    dining: List[_DraftItem] = Field(default_factory=list)


def _to_minutes(t: str) -> int:
    """'HH:MM' -> 当天已过分钟数。"""
    h, m = map(int, t.split(":"))
    return h * 60 + m


def _from_minutes(total: int) -> str:
    """当天已过分钟数 -> 'HH:MM'（跨过 24 点按次日显示为 00:xx，仅用于兜底显示）。"""
    return f"{total // 60 % 24:02d}:{total % 60:02d}"


def _is_indoor(poi: POI) -> bool:
    """判断景点是否为室内（雨天可替换户外景点）。"""
    return any(k in poi.name for k in INDOOR_KEYWORDS)


def _match_poi(name: str, pool: List[POI]) -> Optional[POI]:
    """把大模型给出的景点名映射回候选池里的真实 POI（含坐标与价格）。"""
    target = (name or "").strip()
    if not target:
        return None
    for poi in pool:
        if poi.name == target:
            return poi
    for poi in pool:
        if target in poi.name or poi.name in target:
            return poi
    return None


def _duplicate_of(name: str, planned: Dict[str, str]) -> Optional[str]:
    """判断该景点是否已经安排过，返回已安排的那个名称。

    除同名外还要拦住"同一处的不同叫法"——高德对同一片景区会返回多个条目，
    例如「雷峰塔」/「雷峰塔景区」、「西湖」/「杭州西湖风景名胜区」。
    """
    target = (name or "").strip()
    for planned_name in planned:
        if planned_name == target:
            return planned_name
        shorter, longer = sorted((planned_name, target), key=len)
        if len(shorter) >= 2 and shorter in longer:
            return planned_name
    return None


class PlannerSkill(Skill):
    """智能规划生成。"""

    name = "planner"
    description = "大模型选点 + 系统按地理分区、先定酒店再排路线，并算接驳与预算"

    def __init__(self, llm: Optional[LLMClient] = None, amap: Optional[AmapClient] = None):
        self.llm = llm or LLMClient()
        self.amap = amap or AmapClient()

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        # 不保底：没有大模型就明确告诉用户，不用规则引擎硬凑一份规划
        if not self.llm.available():
            raise LLMUnavailableError(
                "未接入大模型 API（本地 Ollama 未启动或未安装），无法生成规划。"
                "请先启动大模型服务后重试。"
            )

        issues: List[CheckIssue] = []
        plan = self._generate(ctx, issues)
        ctx["plan"] = plan
        ctx["plan_issues"] = issues  # 交给 CheckSkill 一起汇总提示用户
        return ctx

    # ---------------- 供 CheckSkill 调用的定向修复 ----------------
    def rebuild_plan(
        self,
        ctx: dict[str, Any],
        plan: TravelPlan,
        issues: List[CheckIssue],
        day_orders: Optional[List[List[POI]]] = None,
    ) -> TravelPlan:
        """按给定的每日景点顺序重新组装规划（酒店 / 时间轴 / 餐厅 / 预算）。

        **不调用大模型**：顺序调好后用同一套组装逻辑重算一遍，口径与首次生成一致。
        """
        pref = ctx["preference"]
        dates = [date.fromisoformat(d.date) for d in plan.daily_plans]
        groups = day_orders or [
            [it.poi for it in d.timeline if it.poi.type == "景点"] for d in plan.daily_plans
        ]
        hotels = self._pick_hotels_for_groups(
            ctx.get("hotel_pool") or ctx.get("hotel_options", []),
            groups,
            issues,
            ctx.get("metrics"),
        )
        days = self._assemble_days(ctx, groups, dates, ctx.get("weather", {}), issues, hotels)
        plan.daily_plans = days
        total, breakdown = self._budget(
            pref,
            days,
            sum(
                (it.transport_to_next.cost if it.transport_to_next else 0)
                for d in days
                for it in d.timeline
            ),
        )
        plan.total_budget_estimate = total
        plan.budget_breakdown = breakdown
        return plan

    def regenerate(
        self, ctx: dict[str, Any], feedback: List[str]
    ) -> tuple[TravelPlan, List[CheckIssue]]:
        """带着体检结论重新生成一版规划（由 CheckSkill 控制次数，最多一次）。"""
        issues: List[CheckIssue] = []
        previous = ctx.pop("revision_feedback", None)
        ctx["revision_feedback"] = feedback
        try:
            plan = self._generate(ctx, issues)
        finally:
            if previous is None:
                ctx.pop("revision_feedback", None)
            else:
                ctx["revision_feedback"] = previous
        ctx["plan"] = plan
        ctx["plan_issues"] = issues
        return plan, issues

    # ---------------- 生成主流程 ----------------
    def _generate(self, ctx: dict[str, Any], issues: List[CheckIssue]) -> TravelPlan:
        pref = ctx["preference"]
        draft = self._llm_draft(ctx)
        pool: List[POI] = ctx.get("attractions", [])
        weather_map: Dict[str, Weather] = ctx.get("weather", {})
        must_pois: List[POI] = ctx.get("must_visit_pois", [])
        must_names = {p.name for p in must_pois}

        # 模型点名"值得专门去吃"的店：映射回真实 POI。
        # 映射不上的（模型编的名字）直接丢掉——绝不让它凭空进行程。
        ctx["featured_dine"] = self._pick_featured_dining(draft, ctx, issues)

        transport_note = self._note_budget_basis(pref, issues)
        self._note_resolved_region(ctx, issues)
        self._note_schedule_rules(pref, issues)
        self._note_dedupe(ctx.get("dedupe_notes", []), issues)
        self._note_geo_gate(ctx.get("geo_gate", {}), issues)
        self._note_spot_filter(ctx.get("spot_filter", []), issues)
        self._note_diet(ctx.get("diet_dropped", []), pref.dietary_restrictions, issues)

        start_date = self._resolve_start_date(pref, issues)
        per_day = PACE_COUNT.get(pref.pace, 3)
        days_n = pref.duration_days

        # 1) 选点：映射真实 POI、去重（含同景区别名）、必去保底、按容量补齐或裁剪
        selected = self._select_pois(
            pool, must_pois, draft, per_day, days_n, issues
        )
        # 选点完成后才谈得上"同行老人爬不爬得动"——这是行程属性，
        # 不是输入阶段的画像属性，所以放在这里判而不是 GuardSkill 里。
        self._note_arduous_for_elderly(pref, selected, issues)
        self._note_must_visit_issues(
            ctx.get("unlocated_must_visit", []),
            ctx.get("coord_only_must_visit", []),
            issues,
        )

        # 距离度量：选完点之后，把这批点之间的真实驾车距离取好——
        # 分天聚类和当天排序全都靠它。只预热这一批，理由见 skills/metrics.py
        # 的实测数据（全量换成真实路线要 5000+ 次调用，跑不动）。
        metrics = RoadMetrics(self.amap)
        ctx["metrics"] = metrics
        factor = metrics.estimate_factor(selected)
        primed = metrics.prime(selected)
        logger.info(
            "距离度量：绕行系数 %.2f，预热 %d 对真实路线（预算 %d）",
            factor,
            primed,
            metrics.budget,
        )

        # 2) 按地理邻近分区：每天一区，同一天不横跨全城
        #    用 metrics：真实驾车距离，而不是直线距离（平潭实测差 1.7~2.7 倍）
        groups = cluster_into_days(selected, days_n, per_day, must_names, metrics)
        # 2.5) 成链切天之后的最后一道校验：跨度 + 配套（见 _fix_day_quality）
        selected = self._fix_day_quality(
            selected,
            days_n,
            per_day,
            must_names,
            pool,
            ctx.get("dining_pool") or ctx.get("dining_options", []),
            ctx.get("hotel_pool") or ctx.get("hotel_options", []),
            metrics,
            issues,
        )
        groups = cluster_into_days(selected, days_n, per_day, must_names, metrics)
        while len(groups) < days_n:  # 景点太少时也要保证天数结构完整
            groups.append([])

        # 3) 先定酒店：每个区按综合分（评分 + 离当天/次日活动区距离）选一家
        hotels = self._pick_hotels_for_groups(
            ctx.get("hotel_pool") or ctx.get("hotel_options", []), groups, issues, metrics
        )

        # 4) 组装每天：以酒店为起点排路线 + 插餐 + 真实接驳
        dates = [start_date + timedelta(days=i) for i in range(days_n)]
        days = self._assemble_days(ctx, groups, dates, weather_map, issues, hotels)

        # 模型点名"值得专门去吃"的店，如果没能排进去，如实说清楚原因
        placed_meals = {it.poi.name for d in days for it in d.timeline}
        unplaced = [
            p.name for p in ctx.get("featured_dine", []) if p.name not in placed_meals
        ]
        if unplaced:
            issues.append(
                CheckIssue(
                    category="其他",
                    severity="low",
                    message="这些「值得专门去吃」的店没能排进行程：" + "、".join(unplaced[:3]) + "。",
                    suggestion="多半是离当天的路线太远（超过 15 公里）或营业时间对不上；"
                    "可在下方餐厅备选池里手动替换。",
                )
            )

        # 5) 门票价缺失如实说明，免得用户以为门票真的免费
        attraction_items = [it.poi for d in days for it in d.timeline if it.poi.type == "景点"]
        if attraction_items and not any(p.price for p in attraction_items):
            issues.append(
                CheckIssue(
                    category="预算",
                    severity="low",
                    message="景点门票价格未能从高德获取到，预算中的门票按 0 元计。",
                    suggestion="门票以景区官方公示为准；可点景点旁的「导航」查看实时票价与购票入口。",
                )
            )

        total, breakdown = self._budget(
            pref,
            days,
            sum(
                (it.transport_to_next.cost if it.transport_to_next else 0)
                for d in days
                for it in d.timeline
            ),
        )
        return TravelPlan(
            plan_id=str(uuid4()),
            summary=draft.summary.strip() or self._default_summary(pref),
            total_budget_estimate=total,
            budget_breakdown=breakdown,
            daily_plans=days,
            dining_options=ctx.get("dining_options", []),
            hotel_options=ctx.get("hotel_options", []),
            attraction_options=ctx.get("attraction_options", []),
            travelers=pref.travelers.total,
            user_budget=pref.budget,
            user_preference=pref,
            transport_note=transport_note,
        )

    # ---------------- 选点 ----------------
    @staticmethod
    def _pick_featured_dining(
        draft: _DraftPlan, ctx: dict[str, Any], issues: List[CheckIssue]
    ) -> List[POI]:
        """"把模型挑的"值得专门去吃的店"映射回真实 POI。"""
        pool: List[POI] = ctx.get("dining_pool") or ctx.get("dining_options") or []
        if not draft.dining or not pool:
            return []
        picked: List[POI] = []
        seen: set = set()
        for item in draft.dining:
            # 用与景点同一套匹配（先全等、再互相包含）：本地模型抄店名时常漏掉
            # 「(总店)」这类后缀，严格全等会让它白挑一场，用户就看不到任何内容推荐。
            poi = _match_poi(item.name, pool)
            if poi is None:
                issues.append(
                    CheckIssue(
                        category="地点",
                        severity="low",
                        message=f"大模型推荐的餐厅「{item.name}」不在候选里，已跳过。",
                        suggestion="该店可能不在目的地，或名称不准确；可在餐厅备选池里手动替换。",
                    )
                )
                continue
            if poi.name in seen:
                continue
            seen.add(poi.name)
            if item.tips:
                poi.tips = item.tips   # 模型的"为什么值得去"显示在卡片上
            picked.append(poi)
        return picked

    def _select_pois(
        self,
        pool: List[POI],
        must_pois: List[POI],
        draft: _DraftPlan,
        per_day: int,
        days_n: int,
        issues: List[CheckIssue],
    ) -> List[POI]:
        """把大模型给的名字映射成真实 POI，并做去重、必去保底、容量补齐/裁剪。"""
        planned: Dict[str, str] = {}  # 临时结构：记录已选景点，防止重复推荐
        picked: List[POI] = []

        for item in draft.attractions:
            poi = _match_poi(item.name, pool)
            if poi is None:
                issues.append(
                    CheckIssue(
                        category="地点",
                        severity="high",
                        message=f"大模型给出的景点「{item.name}」不在目的地候选景点内，已跳过。",
                        suggestion="该景点可能不在你填写的目的地，或名称不准确；"
                        "可在下方景点备选池里手动替换。",
                    )
                )
                continue
            dup_of = _duplicate_of(poi.name, planned)
            if dup_of:
                detail = (
                    f"「{dup_of}」被重复推荐（{planned[dup_of]}），已只保留一次。"
                    if item.name == dup_of
                    else f"「{item.name}」与已选的「{dup_of}」是同一处或同一片景区，已只保留一次。"
                )
                issues.append(
                    CheckIssue(
                        category="重复",
                        severity="medium",
                        message=detail,
                        suggestion="同一处不必重复安排，已保留先选的那次。",
                    )
                )
                continue
            planned[poi.name] = "模型推荐"
            if item.tips:
                poi.tips = item.tips
            picked.append(poi)

        # 必去景点保底：模型漏了就由系统补进来（确定性补位，不重排整份）
        for must in must_pois:
            if _duplicate_of(must.name, planned):
                continue
            planned[must.name] = "你点名必去"
            picked.insert(0, must)
            issues.append(
                CheckIssue(
                    category="覆盖",
                    severity="medium",
                    message=f"你点名要去的「{must.name}」大模型没有选进来，已按你的要求补上。",
                    suggestion="若该景点提示「未定位坐标」，建议换个更完整的名称重试。",
                )
            )

        # 容量控制：太少了补足，太多了裁掉靠后的非必去景点
        #
        # 补足这一步比看上去重要得多：实测最近 14 份规划**全部**触发了它，
        # 大模型通常只选 5~7 个而容量是 9——也就是说行程里 30~45% 的点是这里补的。
        # 所以补足必须"先看质量、再看位置"：只在分数靠前的一小撮候选里挑，
        # 然后从中选**离已选点最近**的那个。
        # 以前是直接按分数从前往后取（完全不看位置），可能把城市另一端的点塞进来。
        capacity = max(per_day * days_n, len(must_pois))
        if len(picked) < capacity:
            before = len(picked)
            while len(picked) < capacity:
                chosen = PlannerSkill._pick_filler(pool, picked)
                if chosen is None:
                    break
                planned[chosen.name] = "系统按综合分补齐"
                picked.append(chosen)
            if len(picked) > before:
                issues.append(
                    CheckIssue(
                        category="覆盖",
                        severity="low",
                        message=f"大模型只选出 {before} 个景点，已补足到 {len(picked)} 个"
                        "（在高分候选里优先挑离已选景点近的）。",
                        suggestion="补进来的景点可在下方景点备选池里替换成你更想去的。",
                    )
                )
        elif len(picked) > capacity:
            keep, dropped = [], 0
            for poi in picked:
                is_must = poi.name in {m.name for m in must_pois}
                if not is_must and len(keep) >= capacity - len(must_pois):
                    dropped += 1
                    continue
                keep.append(poi)
            picked = keep
            if dropped:
                issues.append(
                    CheckIssue(
                        category="覆盖",
                        severity="low",
                        message=f"大模型选出的景点超过日程容量，已按综合分保留前 {len(picked)} 个（去掉 {dropped} 个）。",
                        suggestion="想都去可以增加天数，或提高节奏强度。",
                    )
                )
        return picked

    @staticmethod
    def _pick_filler(pool: List[POI], picked: List[POI]) -> Optional[POI]:
        """补足名额时挑一个景点：**先看质量、再看位置**。

        做法：只在高分候选里挑（前 FILL_QUALITY_POOL 个），然后从中选离已选景点最近的那个。

        为什么不直接取分数最高的（那是原来的做法）：分数里只有热度与评分，
        **完全没有位置**——城市另一端的高分点会被塞进这一天的候选里，
        之后再怎么串链、怎么切天都救不回来（链只能在已选的点里做优化）。
        实测最近 14 份规划全部触发了补足，所以这一步直接决定行程的空间质量。
        """
        taken = {p.name for p in picked}
        fresh = [
            p for p in pool
            if p.name not in taken and _duplicate_of(p.name, {q.name: "" for q in picked}) is None
        ]
        if not fresh:
            return None
        # 先按质量圈定一小撮（池子本身已按"热度 × 评分"排好序）
        shortlist = fresh[:FILL_QUALITY_POOL]
        if not picked:
            return shortlist[0]

        def _nearest_km(poi: POI) -> float:
            ds = [d for d in (distance_km(poi, q) for q in picked) if d is not None]
            return min(ds) if ds else float("inf")

        return min(shortlist, key=_nearest_km)

    # ---------------- 成链后的「跨度 + 配套」校验 ----------------
    def _fix_day_quality(
        self,
        selected: List[POI],
        days_n: int,
        per_day: int,
        must_names: set,
        pool: List[POI],
        dining_pool: List[POI],
        hotel_pool: List[POI],
        metrics: Optional[RoadMetrics],
        issues: List[CheckIssue],
    ) -> List[POI]:
        """成链、切天之后的最后一道校验：每天的**跨度**与**配套**。

        为什么放在这里而不是留给体检：体检只能"报告"，那时行程已经排完了。
        而这两个问题是**点集本身**的毛病——选的这几个点空间上不成形
        （一天横跨十几公里），或者周围根本没有餐厅。链再怎么排都救不回来
        （链只能在已选的点里优化顺序），所以必须在组装之前改。

        做法：串链分天 → 找出有问题的天 → 把"最孤立 / 最没饭吃"的那个非必去景点
        换成候选池里更合适的（要靠近当天其它点、评分不差、还靠近餐厅）→ 重新分天。
        最多 settings.plan_fix_rounds 轮；**必去景点不动**；改了什么都会写进体检清单。
        """
        groups = cluster_into_days(selected, days_n, per_day, must_names, metrics)
        blocked: List[POI] = []  # 想换但换不了的必去景点：循环结束后按最终分组再复盘
        for _ in range(max(0, settings.plan_fix_rounds)):
            problems = self._day_problems(groups, dining_pool, metrics)
            if not problems:
                break
            taken = {p.name for p in selected}
            changed = False
            for _day_index, day_group, poi, reason in problems:
                if poi.name in must_names:
                    # 先记下来，等循环结束后**按最终这一版分组**复盘再报告：
                    # 修补过程中点集一直在变，中途的跨度数字到最后一版可能已经不成立了。
                    blocked.append(poi)
                    continue
                others = [q for q in day_group if q.name != poi.name]
                replacement = self._find_replacement(
                    pool, taken, others, dining_pool, metrics, (poi.rating or 0) - 0.5
                )
                if replacement is None:
                    issues.append(
                        CheckIssue(
                            category="其他",
                            severity="low",
                            message=f"{reason}，但候选里没有更合适的替代，已保留「{poi.name}」。",
                            suggestion="可以在下方景点备选池里手动替换，或增加天数分摊。",
                        )
                    )
                    continue
                selected = [replacement if p.name == poi.name else p for p in selected]
                taken.discard(poi.name)
                taken.add(replacement.name)
                changed = True
                issues.append(
                    CheckIssue(
                        category="其他",
                        severity="low",
                        message=f"{reason}，已把「{poi.name}」换成「{replacement.name}」。",
                        suggestion="不满意的可以在下方景点备选池里再换。",
                    )
                )
            if not changed:
                break
            groups = cluster_into_days(selected, days_n, per_day, must_names, metrics)
        self._note_blocked_must(blocked, groups, must_names, metrics, issues)
        # 住宿偏远只报告、不替换：换一个景点并不一定能解决，如实说更可信
        self._note_hotel_gaps(groups, hotel_pool, metrics, issues)
        return selected

    @staticmethod
    def _day_span(group: List[POI], metrics: Optional[RoadMetrics]) -> float:
        """一组点内部的最大距离（公里）。"""
        worst = 0.0
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                d = distance_km(group[i], group[j], metrics)
                if d is not None and d > worst:
                    worst = d
        return worst

    @classmethod
    def _note_blocked_must(
        cls,
        blocked: List[POI],
        groups: List[List[POI]],
        must_names: set,
        metrics: Optional[RoadMetrics],
        issues: List[CheckIssue],
    ) -> None:
        """复盘：只报告"最终这一版"里依然成问题的必去景点。

        修补过程中点集一直在变，中途算出来的跨度到最后一版可能已经不成立了
        （实测出现过：中途报"跨度 19 公里"，可最终那一版只有 7.3 公里）。
        所以统一放到最后、按最终分组复算一遍再决定报不报。
        """
        names = {p.name for p in blocked} & set(must_names)
        if not names:
            return
        for group in groups:
            hit = [p for p in group if p.name in names]
            if not hit:
                continue
            span = cls._day_span(group, metrics)
            if span <= settings.plan_day_span_limit:
                continue  # 换掉别的点之后已经不成问题了，不用再提
            issues.append(
                CheckIssue(
                    category="其他",
                    severity="low",
                    message=f"当天景点跨度 {span:.0f} 公里（最远的一段在「{hit[0].name}」），"
                    f"但「{hit[0].name}」是你点名必去的景点，已保留。",
                    suggestion="可以减少当天的其它景点、或增加天数来分摊这一天。",
                )
            )

    @staticmethod
    def _day_problems(
        groups: List[List[POI]], dining_pool: List[POI], metrics: Optional[RoadMetrics]
    ) -> List[tuple[int, List[POI], POI, str]]:
        """找出每天的两个问题：跨度太大、配套不足。

        返回 [(第几天下标, 当天点, 要换掉的那个点, 原因说明)]。
        """
        problems: List[tuple[int, List[POI], POI, str]] = []
        for index, group in enumerate(groups):
            if len(group) < 2:
                continue
            # ① 跨度：当天点集内部的最大距离
            worst_km = PlannerSkill._day_span(group, metrics)
            if worst_km > settings.plan_day_span_limit:
                # 换掉"最孤立"的那个：**到当天其它点的距离之和**最大。
                #
                # 这里不能用"到其它点的最远距离"——那个指标是对称的：
                # 市区点和远郊点互为一对，两边的"最远距离"一样大，
                # 取最大值时会挑中先出现的那个，结果把市区的点换到了远郊（实测踩过）。
                # 用距离之和就能正确指向那个"周围没人陪"的点。
                isolated = max(
                    group,
                    key=lambda p: sum(
                        (distance_km(p, q, metrics) or 0.0) for q in group if q is not p
                    ),
                )
                problems.append(
                    (
                        index,
                        group,
                        isolated,
                        f"当天景点跨度 {worst_km:.0f} 公里（最远的一段在「{isolated.name}」）",
                    )
                )
            # ② 配套：当天某个景点附近没有餐厅候选 → 会跑很远去吃饭
            if dining_pool:
                worst_food = max(group, key=lambda p: _nearest_km(p, dining_pool, metrics))
                gap = _nearest_km(worst_food, dining_pool, metrics)
                if gap > settings.plan_amenity_km:
                    problems.append(
                        (
                            index,
                            group,
                            worst_food,
                            f"「{worst_food.name}」附近 {gap:.0f} 公里内没有餐厅候选",
                        )
                    )
        return problems

    @staticmethod
    def _find_replacement(
        pool: List[POI],
        taken: set,
        others: List[POI],
        dining_pool: List[POI],
        metrics: Optional[RoadMetrics],
        min_rating: float,
    ) -> Optional[POI]:
        """给要换掉的那个点找替补：靠近当天的其它点，同时别离餐厅太远。

        min_rating 是质量下限（原点评分 − 0.5）：**宁可保留原来那个点，
        也不要用一个差很多的点去换"看起来更顺路"**。
        """
        if not others:
            return None
        best: Optional[POI] = None
        best_score: Optional[float] = None
        for cand in pool:
            if cand.name in taken or (cand.rating or 0) < min_rating:
                continue
            dists = [
                d for d in (distance_km(cand, q, metrics) for q in others) if d is not None
            ]
            if not dists:
                continue
            food = _nearest_km(cand, dining_pool, metrics) if dining_pool else 0.0
            if food == float("inf"):
                food = 0.0
            score = max(dists) + AMENITY_WEIGHT * food
            if best_score is None or score < best_score:
                best, best_score = cand, score
        return best

    @staticmethod
    def _note_hotel_gaps(
        groups: List[List[POI]],
        hotel_pool: List[POI],
        metrics: Optional[RoadMetrics],
        issues: List[CheckIssue],
    ) -> None:
        """住宿配套只报告：某晚的落脚点附近没有酒店候选时如实说明。"""
        if not hotel_pool:
            return
        for index in range(max(len(groups) - 1, 0)):
            anchors: List[POI] = []
            if groups[index]:
                anchors.append(groups[index][-1])
            if index + 1 < len(groups) and groups[index + 1]:
                anchors.append(groups[index + 1][0])
            if not anchors:
                continue
            nearest = min(_nearest_km(a, hotel_pool, metrics) for a in anchors)
            if nearest > settings.plan_amenity_km:
                issues.append(
                    CheckIssue(
                        category="其他",
                        severity="low",
                        message=f"第 {index + 1} 晚的落脚点附近 {nearest:.0f} 公里内没有酒店候选。",
                        suggestion="可在酒店备选池里手动选一家，或换个目的地描述重试。",
                    )
                )

    # ---------------- 酒店：落在"切点"上 ----------------
    def _pick_hotels_for_groups(
        self,
        hotel_pool: List[POI],
        groups: List[List[POI]],
        issues: List[CheckIssue],
        metrics: Optional[RoadMetrics] = None,
    ) -> List[Optional[POI]]:
        """在每天之间的**切点**上选酒店：看它到「当天最后一个景点」和
        「次日第一个景点」的距离，再加上评分。

        为什么不按"当天/次日活动区的中心"选（那是原来的做法）：
        中心是经纬度平均出来的**合成点**，可能落在海里或山腰，
        根本没有"到它的驾车距离"，只能直线乘一个系数拍脑袋。
        而切点两侧是两个真实景点——正好是「今天玩完回酒店」和「明早从这里出发」
        这两段，可以查真实路线，算出来的也是用户真正要走的路。
        顺带一个好处：链的切点就是酒店，于是"当天的起点/终点"和链天然对齐。

        最后一晚不需要酒店（当天返程）。候选池为空时如实记录问题，不编造酒店。

        **允许连住同一家**。这里曾经把「前一晚用过的酒店」硬排除掉，
        结果是每晚强制换店：为了"换一家"，第二晚只能退而求其次选更远的。
        实测 99 个住宿夜里，有 8 次本可以在更近的酒店（近 2~4 公里）里选，
        却只因为它前一夜用过而被迫选远的。
        现实里同一城市连住同一家才是常态，也不用来回搬行李，
        所以直接放开，让评分自己决定要不要换——同一家仍然最优就继续住。
        """
        nights = max(len(groups) - 1, 0)
        hotels: List[Optional[POI]] = []
        for i in range(len(groups)):
            if i >= nights:
                hotels.append(None)
                continue
            if not hotel_pool:
                issues.append(
                    CheckIssue(
                        category="其他",
                        severity="medium",
                        message="没有可用的酒店候选，未安排住宿。",
                        suggestion="可在酒店备选池中手动选择，或换个目的地描述重试。",
                    )
                )
                hotels.append(None)
                continue
            # 切点两侧的真实景点：当天最后一个 / 次日第一个（groups 是链上连续的一段）
            prev_poi = groups[i][-1] if groups[i] else None
            next_poi = groups[i + 1][0] if i + 1 < len(groups) and groups[i + 1] else None
            hotels.append(self._best_hotel_at_cut(hotel_pool, prev_poi, next_poi, metrics))
        return hotels

    @staticmethod
    def _best_hotel_at_cut(
        hotel_pool: List[POI],
        prev_poi: Optional[POI],
        next_poi: Optional[POI],
        metrics: Optional[RoadMetrics] = None,
    ) -> POI:
        """切点上的最佳酒店：先用"直线×系数"粗筛几家，再对这几家查真实路线。"""
        if prev_poi is None and next_poi is None:
            return max(hotel_pool, key=lambda h: h.rating or 0)
        candidates = hotel_pool
        if metrics is not None and len(hotel_pool) > HOTEL_SHORTLIST:
            def _rough(hotel: POI) -> float:
                total = 0.0
                for anchor in (prev_poi, next_poi):
                    if anchor is None:
                        continue
                    km = distance_km(hotel, anchor, metrics)
                    if km is not None:
                        total += km
                return total

            candidates = sorted(hotel_pool, key=_rough)[:HOTEL_SHORTLIST]
        return max(
            candidates,
            key=lambda h: hotel_cut_score(h, prev_poi, next_poi, metrics),
        )

    # ---------------- 与大模型交互 ----------------
    def _llm_draft(self, ctx: dict[str, Any]) -> _DraftPlan:
        """把精简后的画像、候选景点、天气交给大模型，拿回"要去哪些景点"。"""
        pref = ctx["preference"]
        pool: List[POI] = ctx.get("attractions", [])
        weather: Dict[str, Weather] = ctx.get("weather", {})
        feedback = ctx.get("revision_feedback") or []

        per_day = PACE_COUNT.get(pref.pace, 3)
        # 候选**按地理分片**给模型，每片对应一天。
        #
        # 为什么不再平铺一个截断列表：以前给的是 `pool[:15]`——池子有二十多条，
        # 后十来个它根本看不到；而且它没有算距离的能力，把它自己排出来的点算一下，
        # 实测会出现同一天横跨 8~9 公里的情况（提示词里"优先挑距离近的"那条也没救回来）。
        # 按片给之后，它只需要在"这一片"里挑值得去的，几何交给代码。
        #
        # 分片用的是规划阶段同一套「先串链、再切段」，只是输入换成候选池。
        slices = split_chain_into_days(
            order_chain(pool, None),
            max(1, pref.duration_days),
            max(2, per_day * 2),
            None,
        )
        # 只给必要的字段：提示词越短，本地模型出结果越快（延迟主要来自预填充与生成长度）
        candidates = {
            f"第{i + 1}天候选": [
                {
                    "name": p.name,
                    "rating": p.rating,
                    "price": p.price,
                    "lat": round(p.location.lat, 4),
                    "lng": round(p.location.lng, 4),
                }
                for p in segment
            ]
            for i, segment in enumerate(slices)
        }
        # 餐厅候选：按"本地特色 + 评分"取前十几家（本地特色词是统计出来的，零人工）
        local_words: List[str] = list(ctx.get("local_keywords") or [])
        dining_pool: List[POI] = ctx.get("dining_pool") or ctx.get("dining_options") or []
        ranked_dining = sorted(
            dining_pool,
            key=lambda p: (
                1 if is_local_specialty(p, local_words) else 0,
                p.rating or 0,
            ),
            reverse=True,
        )[:DINING_CANDIDATE_LIMIT]
        dining_candidates = [
            {
                "name": p.name,
                "rating": p.rating,
                "cuisine": p.cuisine,
                "tags": p.tags[:6],
            }
            for p in ranked_dining
        ]
        payload = json.dumps(
            {
                "目的地": pref.destination,
                "天数": pref.duration_days,
                "出行人数": pref.travelers.model_dump(),
                "总预算": pref.budget,
                "兴趣导向": pref.preferences,
                "节奏": pref.pace or "未指定（默认适中）",
                "同行特征": {
                    "携带儿童": pref.travelers.children > 0,
                    "携带老人": pref.travelers.elderly > 0,
                },
                "饮食禁忌": pref.dietary_restrictions,
                "必去景点（必须全部包含）": [m.name for m in pref.must_visit],
                "建议总数量": pref.duration_days * per_day,
                "候选景点": candidates,
                # 餐厅候选：只给一小撮（按"本地特色 + 评分"挑），
                # 让模型挑出"值得专门去吃"的店。给全量会让提示词暴涨
                # （实测：景点+餐厅+酒店全塞进去 ≈ +2700 token ≈ +50 秒预填充）。
                "餐厅候选": dining_candidates,
                # 实时攻略摘要（可选，默认关闭）。只作偏好提示——
                # 模型据此挑出来的名字仍要映射回高德候选池，映射不上的会被丢掉。
                **(
                    {"网络攻略摘要（仅供参考，不是硬数据）": list(ctx.get("web_notes") or [])[:10]}
                    if ctx.get("web_notes")
                    else {}
                ),
                "天气": {d: w.condition for d, w in list(weather.items())[:pref.duration_days]},
                **({"需要修正的问题（上一版体检结论）": feedback} if feedback else {}),
            },
            ensure_ascii=False,
        )
        # 温度调低：这类"按约束挑选"的任务不需要发散，稳定输出更重要
        data = self.llm.chat_json(
            _SYSTEM_PROMPT,
            payload,
            options={"temperature": 0.2, "num_predict": 700, "num_ctx": 4096},
        )
        if data is None:
            raise LLMOutputError(
                "大模型没有返回可解析的规划 JSON"
                + (f"：{self.llm.last_error}" if self.llm.last_error else "")
                + "。请重试。"
            )
        try:
            return _DraftPlan.model_validate(data)
        except Exception as exc:
            raise LLMOutputError(
                f"大模型返回的规划结构不符合约定（{exc}）。请重试。"
            ) from exc

    # ---------------- 系统组装：路线 / 用餐 / 交通 ----------------
    def _assemble_days(
        self,
        ctx: dict[str, Any],
        groups: List[List[POI]],
        dates: List[date],
        weather_map: Dict[str, Weather],
        issues: List[CheckIssue],
        hotels: List[Optional[POI]],
    ) -> List[DailyPlan]:
        pref = ctx["preference"]
        dining_pool: List[POI] = ctx.get("dining_pool") or ctx.get("dining_options", [])
        attraction_options: List[POI] = ctx.get("attraction_options", [])
        must_names = {p.name for p in ctx.get("must_visit_pois", [])}
        metrics: Optional[RoadMetrics] = ctx.get("metrics")

        used_meals: set = set()
        # 餐厅是"按天贪心分配 + 全程不重复"，先排的天会把后排最需要的餐厅抢走。
        # 实测案例（平潭）：离「长江澳风力发电景观区」最近的两家餐厅分别被第 1 天和第 3 天
        # 先占走，轮到这个点所在的第 2 天时，只能选到 9.3 公里外的一家。
        # 所以改成按「这天有多难找到餐厅」排序，最难的那天先挑。
        # 各天难度相同（默认都是 0）时顺序不变，行为与原来一致。
        assemble_order = sorted(
            range(len(groups)),
            key=lambda i: -self._meal_scarcity(groups[i], dining_pool, metrics),
        )
        assembled: Dict[int, DailyPlan] = {}
        for i in assemble_order:
            day_pois = groups[i]
            day_date = dates[i].isoformat()
            # 当天出发点 = 前一晚住的酒店；第一天没有则从第一个景点算起
            start_poi = hotels[i - 1] if i > 0 else None
            night_hotel = hotels[i] if i < len(hotels) else None
            # 终点也传进去：一天的真实代价是「起点 → 景点 → 当晚酒店」，
            # 只优化前半段会出现"玩到很晚、结果离酒店还有七八公里"
            ordered = (
                order_nearest(day_pois, start_poi, night_hotel, metrics)
                if len(day_pois) > 1
                else list(day_pois)
            )
            timeline, dropped = self._build_timeline(
                pref, ordered, start_poi, night_hotel, dining_pool, used_meals, must_names,
                day_date, issues, metrics, ctx.get("local_keywords"),
                ctx.get("featured_dine"),
            )

            weather = weather_map.get(day_date)
            if weather is None:
                weather = Weather(condition="", temp="")
                issues.append(
                    CheckIssue(
                        category="时间",
                        severity="low",
                        message=f"{day_date} 超出天气预报可覆盖范围，当天暂无预报。",
                        suggestion="临近出行前再刷新一次，可拿到更准的天气。",
                    )
                )

            assembled[i] = DailyPlan(
                    date=day_date,
                    weather=weather,
                    timeline=timeline,
                    plan_b=self._plan_b(weather, attraction_options, {p.name for p in day_pois}),
                    # 每天单独的贴士已不再由知识库填充：原来的实现是把同一批
                    # 通用话术原样贴到每一天，跟当天去了哪儿无关（形同虚设），
                    # 现在改为靠「每个 POI 自己的 tips（大模型给的游玩贴士、
                    # 高德给的地址与参考消费）」说话。字段保留是为了兼容旧数据。
                    tips=[],
                    hotel=night_hotel,
                )
        # 按天序返回：上面的组装顺序是按"找餐厅的难度"排的，不是按日期
        return [assembled[i] for i in range(len(groups)) if i in assembled]

    def _build_timeline(
        self,
        pref: Any,
        day_pois: List[POI],
        start_poi: Optional[POI],
        night_hotel: Optional[POI],
        dining_pool: List[POI],
        used_meals: set,
        must_names: set,
        day_date: str,
        issues: List[CheckIssue],
        metrics: Optional[RoadMetrics] = None,
        local_keywords: Optional[List[str]] = None,
        featured_dining: Optional[List[POI]] = None,
    ) -> tuple[List[TimelineItem], List[str]]:
        """把当天景点串成时间轴：酒店出发 → 景点 → 午餐 → 景点 → 晚餐。

        时间规则（与用户对齐）：
        - 出发：非特种兵不早于 8:00，特种兵不早于 7:00；
        - 午餐：在"已经过了 11:30"之后、且还没到 14:00 时安排；
        - 晚餐：不早于 17:30；
        - 超过期望的回酒店时间时，优先砍掉靠后的「非必去景点」，而不是砍掉晚餐。
        """
        if not day_pois:
            return [], []

        earliest = (
            DAY_START_EARLIEST_SPECIAL if pref.pace == "特种兵" else DAY_START_EARLIEST
        )
        day_start = max(_to_minutes(pref.departure_time or "09:00"), _to_minutes(earliest))
        cutoff = _to_minutes(pref.return_hotel_time or "21:00")

        attractions = list(day_pois)
        trimmed: List[str] = []
        while True:
            attempt_meals = set(used_meals)
            timeline, end_min, attempt_meals = self._simulate_day(
                pref, attractions, start_poi, night_hotel, dining_pool, attempt_meals,
                day_start, issues, metrics, local_keywords, featured_dining,
            )
            if end_min <= cutoff:
                used_meals.clear()
                used_meals.update(attempt_meals)
                break
            droppable = [i for i, p in enumerate(attractions) if p.name not in must_names]
            if not droppable:
                issues.append(
                    CheckIssue(
                        category="时间",
                        severity="medium",
                        message=f"{day_date} 的安排会超过你期望的 {pref.return_hotel_time or '21:00'} 回酒店时间，"
                        "但当天剩下的都是你点名必去的景点，未做删减。",
                        suggestion="可以把节奏调成「悠闲」、增加天数，或把回酒店时间调晚。",
                    )
                )
                break
            trimmed.append(attractions.pop(droppable[-1]).name)

        if trimmed:
            issues.append(
                CheckIssue(
                    category="时间",
                    severity="medium",
                    message=f"{day_date} 的安排会超过你期望的 {pref.return_hotel_time or '21:00'} 回酒店时间，"
                    "已去掉排在最后的景点：" + "、".join(reversed(trimmed)) + "。",
                    suggestion="想保留这些点，可以增加天数、把节奏调成「悠闲」，或把回酒店时间调晚。",
                )
            )
        return timeline, trimmed

    def _simulate_day(
        self,
        pref: Any,
        attractions: List[POI],
        start_poi: Optional[POI],
        night_hotel: Optional[POI],
        dining_pool: List[POI],
        used_meals: set,
        day_start: int,
        issues: List[CheckIssue],
        metrics: Optional[RoadMetrics] = None,
        local_keywords: Optional[List[str]] = None,
        featured_dining: Optional[List[POI]] = None,
    ) -> tuple[List[TimelineItem], int, set]:
        """算一天的时间轴，返回 (时间轴, 结束分钟, 用掉的餐厅)。"""
        pace = getattr(pref, "pace", None)
        local_keywords: List[str] = list(local_keywords or [])
        featured: List[POI] = list(featured_dining or [])
        meal_min = self._meal_minutes(pace)
        # 1) 先定顺序：景点 + 午餐 + 晚餐（用直线距离粗估到达时间，避免重复调高德）
        seq: List[POI] = []
        # 每个餐位落在时间轴第几位、大约几点开始吃：营业时间校验与后续微调都要用
        slot_start: dict[int, int] = {}
        cursor = day_start
        prev_poi: Optional[POI] = start_poi
        lunch_done = False

        for idx, poi in enumerate(attractions):
            # 两个条件任一满足就在这个景点之前安排午餐：
            # 1) 已经到了饭点（11:30 之后）；
            # 2) 这是当天最后一个景点——宁可午饭稍早点，也不能把它排到所有景点之后
            #    （以前就出现过"下午两点多才吃午饭"）。
            is_last = idx == len(attractions) - 1
            if not lunch_done and seq and (
                cursor >= _to_minutes(LUNCH_EARLIEST) or is_last
            ):
                lunch = self._pick_meal(
                    dining_pool, used_meals, prev_poi, poi, metrics,
                    cursor, meal_min, local_keywords, featured,
                )
                if lunch is not None:
                    slot_start[len(seq)] = cursor
                    seq.append(lunch)
                    prev_poi = lunch
                lunch_done = True
            seq.append(poi)
            cursor += int(_duration(poi, pace) * 60)
            nxt = attractions[idx + 1] if idx + 1 < len(attractions) else None
            if nxt is not None:
                cursor += self._estimate_travel_minutes(poi, nxt, metrics)
            prev_poi = poi

        if not lunch_done:
            # 一整天都在赶路（景点少、路途远）：午餐安排在最后一个景点之后
            lunch = self._pick_meal(
                dining_pool, used_meals, prev_poi, None, metrics,
                cursor, meal_min, local_keywords, featured,
            )
            if lunch is not None:
                slot_start[len(seq)] = cursor
                seq.append(lunch)
                prev_poi = lunch

        # 晚餐的"下一站"是当晚要住的酒店：吃完回酒店这段路也要顺，别为了吃饭绕远
        dinner_start = max(cursor, _to_minutes(DINNER_EARLIEST))
        dinner = self._pick_meal(
            dining_pool, used_meals, prev_poi, night_hotel, metrics,
            dinner_start, meal_min, local_keywords, featured,
        )
        if dinner is not None:
            slot_start[len(seq)] = dinner_start
            seq.append(dinner)

        # 局部优化：按综合分选出来的餐厅可能让整天路线绕远（例如午饭在反方向），
        # 这里逐个餐位试换候选，选"当天总移动距离最短"的那个。
        self._optimize_meals(
            seq, dining_pool, used_meals, metrics, slot_start, meal_min,
            local_keywords, featured,
        )

        if not any(p.type == "餐厅" for p in seq):
            issues.append(
                CheckIssue(
                    category="其他",
                    severity="medium",
                    message="没有可用的餐厅候选，当天未安排用餐。",
                    suggestion="可在餐厅备选池中手动添加，或换个目的地描述重试。",
                )
            )

        # 2) 再按真实接驳算时间轴（这里才调高德路线）
        items: List[TimelineItem] = []
        cursor = day_start
        for idx, poi in enumerate(seq):
            if poi.type == "餐厅":
                earliest_meal = (
                    LUNCH_EARLIEST if not any(i.poi.type == "餐厅" for i in items) else DINNER_EARLIEST
                )
                cursor = max(cursor, _to_minutes(earliest_meal))
                if earliest_meal == LUNCH_EARLIEST and cursor > _to_minutes(LUNCH_LATEST):
                    issues.append(
                        CheckIssue(
                            category="时间",
                            severity="low",
                            message=f"当天午餐安排到了 {_from_minutes(cursor)}（晚于 {LUNCH_LATEST}），"
                            "说明上午的景点或路上耗时较长。",
                            suggestion="可以把节奏调成「悠闲」，或减少当天的景点数量。",
                        )
                    )
            end = cursor + int(_duration(poi, pace) * 60)
            item = TimelineItem(
                time=f"{_from_minutes(cursor)}-{_from_minutes(end)}", poi=poi, tips=poi.tips
            )
            items.append(item)
            cursor = end
            if idx < len(seq) - 1:
                nxt = seq[idx + 1]
                try:
                    leg = self._transport(poi, nxt)
                except Exception as exc:
                    leg = None
                    issues.append(
                        CheckIssue(
                            category="路径",
                            severity="low",
                            message=f"{poi.name} → {nxt.name} 的接驳路线暂时取不到（{exc}）。",
                            suggestion="可到场后用地图实时导航。",
                        )
                    )
                if leg is not None:
                    mode, leg_minutes, cost, leg_km = leg
                    item.transport_to_next = TransportToNext(
                        mode=mode,
                        duration=f"{leg_minutes}分钟",
                        cost=cost,
                        distance_km=leg_km,
                    )
                    cursor += leg_minutes
        return items, cursor, used_meals

    @staticmethod
    def _optimize_meals(
        seq: List[POI],
        pool: List[POI],
        used_meals: set,
        metrics: Optional[RoadMetrics] = None,
        slot_start: Optional[dict] = None,
        meal_minutes: int = 60,
        local_keywords: Optional[List[str]] = None,
        featured: Optional[List[POI]] = None,
    ) -> None:
        """微调餐厅选择：距离不许明显变差，同等路程下比综合分（只动餐厅，不动景点顺序）。

        这里曾经是"当天总距离最短"的纯几何目标，容差只有 0.01 公里——
        为了省 10 米，它可以把一家 4.9 分的餐厅换成 3.0 分的。
        现在改成两步：先用「不增加超过 MEAL_DIST_TOLERANCE_KM」筛掉绕远的候选，
        再在剩下的候选里比 meal_score（离前后两点 + 评分 + 本地特色/连锁修正），
        距离、口碑和"内容"都照顾到。

        另外：**模型点名"值得专门去吃"的店不参与微调**。它们是特意绕路来的内容，
        不能被"省 0.3 公里"挤掉——实测踩过这个坑：内容店刚被排进时间轴，
        就被这一步按纯几何分换成了景点门口的连锁快餐。
        """

        def _total_km(points: List[POI]) -> float:
            legs = [
                distance_km(points[i], points[i + 1], metrics)
                for i in range(len(points) - 1)
            ]
            return sum(d for d in legs if d is not None)

        featured_names = {p.name for p in (featured or [])}

        for idx, poi in enumerate(seq):
            if poi.type != "餐厅":
                continue
            if poi.name in featured_names:
                continue
            prev_poi = seq[idx - 1] if idx > 0 else None
            next_poi = seq[idx + 1] if idx + 1 < len(seq) else None
            base_km = _total_km(seq)
            best, best_score = poi, meal_score(
                poi, prev_poi, next_poi, metrics, local_keywords
            )
            for candidate in pool:
                if candidate.name == poi.name or candidate.name in used_meals:
                    continue
                # 微调也不能把一家"到点已经关门"的店换进来
                start = (slot_start or {}).get(idx)
                if start is not None and not fits_open_time(
                    candidate.open_time, start, meal_minutes
                ):
                    continue
                trial = list(seq)
                trial[idx] = candidate
                if _total_km(trial) > base_km + MEAL_DIST_TOLERANCE_KM:
                    continue
                score = meal_score(candidate, prev_poi, next_poi, metrics, local_keywords)
                if score > best_score + 1e-9:
                    best, best_score = candidate, score
            if best is not poi:
                used_meals.discard(poi.name)
                used_meals.add(best.name)
                seq[idx] = best

    @staticmethod
    def _pick_meal(
        pool: List[POI],
        used: set,
        prev_poi: Optional[POI],
        next_poi: Optional[POI],
        metrics: Optional[RoadMetrics] = None,
        start_minute: Optional[int] = None,
        meal_minutes: int = 60,
        local_keywords: Optional[List[str]] = None,
        featured: Optional[List[POI]] = None,
    ) -> Optional[POI]:
        """挑餐厅：先排除"到了饭点不营业"的，再取"链上这个位置附近"的几家，再比综合分。

        三道筛子，每一道都是修一个实测到的问题：

        ① **营业时间**：解析不出来就不拦（不因为读不懂就少给候选）。
           实测出现过「晚餐排在 17:30 开始，而这家店 10:30-17:30 已经关门」。
        ② **离链上这个位置近**：不先收窄的话，评分权重（0.4）会让远处的高分店胜出
           ——实测出现过 9.32 公里的接驳。
        ③ **内容修正**（见 scoring.meal_score）：本地特色店加分、连锁快餐降权。
           不做这一项，连锁快餐会靠"就在景点旁边 + 评分不低"赢掉本地老店
           ——实测 5/20 份规划把麦当劳/肯德基排进了行程。

        ②和③之间还有一条**内容通道**（见 MEAL_LOCAL_EXTRA）：只按距离取前 5 家时，
        本地老店可能连参评资格都没有，加分也就无从谈起，所以额外放几家本地特色店进候选。
        ④ 最后一道是**内容额度**（见 MEAL_CONTENT_EXTRA_KM）：比最近候选多绕超过额度的店
           直接不参与比价。评分和特色能值几公里，但值不了七八公里——实测平潭第 1 天的午餐
           就是这样：那一段第 5 近的餐厅已经要开 10.1 公里（合计比最近的多 6.7 公里），
           却被 4.6 分 + 本地特色推成了当天的午饭。

        如果所有候选都"到点不营业"，那就退回未过滤的候选——宁可给一家可能打烊的店，
        也不要让那一顿饭凭空消失（行程里会明写营业时间，用户能自己核对）。

        （饮食禁忌不在这里判：明显违反的店在检索阶段就已经被排除了。）
        """
        candidates = [p for p in pool if p.name not in used]
        if not candidates:
            return None
        # ⓪ **内容优先**：模型点名"值得专门去吃"的店先落位（允许为它绕一点路）。
        #    不这么做的话，连锁快餐会靠"就在景点旁边"赢掉本地老店。
        if featured:
            ready = [
                p for p in featured
                if p.name not in used
                and (start_minute is None or fits_open_time(p.open_time, start_minute, meal_minutes))
                and _within_detour(p, prev_poi, next_poi, metrics)
            ]
            if ready:
                best = max(
                    ready, key=lambda p: option_score(p, prev_poi, next_poi, metrics)
                )
                if _featured_detour_ok(
                    best, candidates, prev_poi, next_poi, metrics, start_minute, meal_minutes
                ):
                    used.add(best.name)
                    return best
                # 绕得太狠：这一顿仍按就近挑，排不进去的店由上层如实告知用户
        if start_minute is not None:
            open_now = [
                p for p in candidates
                if fits_open_time(p.open_time, start_minute, meal_minutes)
            ]
            if open_now:
                candidates = open_now

        # 「内容最多值多少路」的统一基准：到链上前后两点的里程之和，取最近的那家。
        baseline = min(
            (_rough_km(p, prev_poi, next_poi, metrics) for p in candidates), default=0.0
        )

        def _worth_detour(p: POI) -> bool:
            """多绕在内容额度内（见 MEAL_CONTENT_EXTRA_KM）。"""
            return _rough_km(p, prev_poi, next_poi, metrics) <= baseline + MEAL_CONTENT_EXTRA_KM

        if len(candidates) > MEAL_NEARBY_LIMIT:
            def _rough(p: POI) -> float:
                return _rough_km(p, prev_poi, next_poi, metrics)

            by_distance = sorted(candidates, key=_rough)
            shortlist = by_distance[:MEAL_NEARBY_LIMIT]
            # 内容通道：距离榜之外，再按综合分补几家"顺得上的本地特色店"参评，
            # 免得它们在第一道距离筛子里就被无声淘汰。准入用"相对最近候选的
            # 额外里程"（前后两段合计），保证只是"为吃多开几公里"。
            extra = [
                p
                for p in by_distance[MEAL_NEARBY_LIMIT:]
                if is_local_specialty(p, local_keywords or [])
                and _worth_detour(p)
            ]
            if extra:
                extra.sort(
                    key=lambda p: meal_score(p, prev_poi, next_poi, metrics, local_keywords),
                    reverse=True,
                )
                shortlist = shortlist + extra[:MEAL_LOCAL_EXTRA]
            candidates = shortlist
        # 最后一道：明显更远的候选不参与比价。近处就有店时，"评分高 0.2 分"或
        # "本地特色"不该值七八公里——这正是用户抱怨过的"到下一个餐厅那么远"。
        affordable = [p for p in candidates if _worth_detour(p)]
        if affordable:
            candidates = affordable
        best = max(
            candidates,
            key=lambda p: meal_score(p, prev_poi, next_poi, metrics, local_keywords),
        )
        used.add(best.name)
        return best

    @staticmethod
    def _meal_minutes(pace: Optional[str]) -> int:
        """一餐按多久算（分钟）：取自节奏对应的耗时表。"""
        table = PACE_DURATION.get(pace or "", {})
        return int(table.get("餐厅", 1.5) * 60)

    @staticmethod
    def _estimate_travel_minutes(
        a: POI, b: POI, metrics: Optional[RoadMetrics] = None
    ) -> int:
        """粗估两点耗时（只用于决定午餐插在哪，不调用高德）。"""
        d = distance_km(a, b, metrics)
        if d is None:
            return 15
        if d < WALK_THRESHOLD_KM:
            return max(int(d / 4.5 * 60) + 5, 5)
        return max(int(d / 20 * 60) + 5, 8)

    def _transport(self, a: POI, b: POI) -> Optional[tuple[str, int, float, float]]:
        """两点间交通：返回 (方式, 分钟, 费用, 公里)；坐标缺失返回 None。"""
        if not (has_location(a) and has_location(b)):
            return None
        dist = distance_km(a, b)
        if dist is not None and dist < WALK_THRESHOLD_KM:
            minutes = max(int(dist / 4.5 * 60) + 5, 5)
            return "步行", minutes, 0.0, round(dist, 2)
        # 长距离走高德真实驾车路线（真实耗时 + 打车费）
        data = self.amap.get_route(
            f"{a.location.lng},{a.location.lat}",
            f"{b.location.lng},{b.location.lat}",
            "driving",
        )
        route = data["route"]
        path = route["paths"][0]
        duration_sec = int(path.get("duration", 0))
        cost = float(route.get("taxi_cost") or 0)  # 打车费在 route.taxi_cost
        # 里程就在同一个响应里，顺手带出去给体检用，不额外发请求
        road_km = round(float(path.get("distance") or 0) / 1000.0, 2)
        return "打车", max(duration_sec // 60, 1), round(cost, 1), road_km

    @staticmethod
    def _plan_b(weather: Weather, attractions: List[POI], used_names: set) -> str:
        """雨天备选方案：替换为当天没排过的室内景点。"""
        if not weather.condition or "雨" not in weather.condition:
            return ""
        indoor = [p.name for p in attractions if _is_indoor(p) and p.name not in used_names]
        if indoor:
            return "今日有雨，可改为室内：" + "、".join(indoor[:3])
        return "今日有雨，建议改为室内博物馆/商场，或调整行程。"

    # ---------------- 说明与预算 ----------------
    def _note_budget_basis(self, pref: Any, issues: List[CheckIssue]) -> str:
        """把预算口径讲清楚：往返交通是估算值，真实机票/高铁票以用户购票为准。

        返回的文案会挂到 plan.transport_note 上，前端直接显示在预算栏里。
        """
        if not pref.transportation:
            note = "未填写往返交通方式，预算未包含往返大交通（机票 / 高铁票等）。"
            issues.append(
                CheckIssue(
                    category="预算",
                    severity="low",
                    message="你没有填写往返交通方式，预算未包含往返大交通。",
                    suggestion="补上往返交通方式（高铁 / 飞机 / 自驾）后重新生成，预算会更准。",
                )
            )
            return note
        people = pref.travelers.total
        unit = ROUND_TRIP_UNIT.get(pref.transportation, 0.0)
        if unit <= 0:
            return ""
        if pref.transportation == "自驾":
            detail = f"自驾按全程约 {unit:.0f} 元估算"
        else:
            detail = f"按「{pref.transportation} {unit:.0f} 元/人/单程 × 2 程 × {people} 人 = {unit * 2 * people:.0f} 元」估算"
        note = (
            f"往返大交通为估算值（{detail}）；"
            "你自己买的机票 / 高铁票价格（折扣、舱位、购票时间不同）可能与此不同，"
            "本预算未包含真实票价差额，以实际购票为准。"
        )
        issues.append(
            CheckIssue(
                category="预算",
                severity="low",
                message=note,
                suggestion="机票 / 高铁票以你的实际购票金额为准。",
            )
        )
        return note

    @staticmethod
    def _note_resolved_region(ctx: dict[str, Any], issues: List[CheckIssue]) -> None:
        """目的地被高德规范化解析时如实告知用户，而不是悄悄换个地方检索。"""
        region = ctx.get("resolved_region") or {}
        original = (region.get("input") or "").strip()
        city = (region.get("city") or "").strip()
        if not original or not city:
            return
        if original in city or city in original:
            return
        issues.append(
            CheckIssue(
                category="地点",
                severity="low",
                message=f"目的地「{original}」已按高德行政区划解析为「{city}」进行检索。",
                suggestion="若解析得不对，换个更明确的写法（例如直接写城市名）再生成一次。",
            )
        )

    @staticmethod
    def _note_schedule_rules(pref: Any, issues: List[CheckIssue]) -> None:
        """出发时间早于节奏下限时如实说明——不悄悄改掉用户填的时间。"""
        raw = (pref.departure_time or "").strip()
        if not raw:
            return
        earliest = DAY_START_EARLIEST_SPECIAL if pref.pace == "特种兵" else DAY_START_EARLIEST
        try:
            requested = _to_minutes(raw)
        except (ValueError, AttributeError):
            return
        if requested < _to_minutes(earliest):
            issues.append(
                CheckIssue(
                    category="时间",
                    severity="low",
                    message=f"你填的出发时间 {raw} 早于「{pref.pace or '适中'}」节奏的建议下限，"
                    f"已按 {earliest} 安排。",
                    suggestion=f"想更早出发，可以把节奏调成「特种兵」（下限 {DAY_START_EARLIEST_SPECIAL}）。",
                )
            )

    @staticmethod
    def _meal_scarcity(
        day_pois: List[POI],
        dining_pool: List[POI],
        metrics: Optional[RoadMetrics] = None,
    ) -> float:
        """这一天"有多难找到餐厅"：当天各点到最近餐厅的距离里，最大的那个（公里）。

        为什么取最大而不是平均：只要有一个点周围没餐厅，那天就注定要跑远路吃饭。
        这个值用来决定"哪一天先挑餐厅"——越难的天越先挑，免得被别的天抢走。
        """
        anchors = [p for p in day_pois if has_location(p)]
        pool = [r for r in dining_pool if has_location(r)]
        if not anchors or not pool:
            return 0.0
        worst = 0.0
        for anchor in anchors:
            nearest = min(
                (
                    d
                    for d in (distance_km(anchor, r, metrics) for r in pool)
                    if d is not None
                ),
                default=0.0,
            )
            worst = max(worst, nearest)
        return worst

    @staticmethod
    def _note_dedupe(notes: List[Dict[str, Any]], issues: List[CheckIssue]) -> None:
        """如实汇报"哪几个候选被判定为同一处、合并掉了"。

        去重是系统替用户做的判断，所以必须写进体检清单让用户能核对与纠正，
        而不是悄悄把候选池改小（万一判错了，用户能在备选池里手动换回来）。
        """
        lines: List[str] = []
        for note in notes:
            merged = "、".join((note.get("merged") or [])[:3])
            if not merged or not note.get("kept"):
                continue
            reason = note.get("reason") or "与已保留的景点是同一处"
            lines.append(f"「{merged}」与「{note['kept']}」{reason}")
        if not lines:
            return
        issues.append(
            CheckIssue(
                category="重复",
                severity="low",
                message="以下候选被判定为同一处，已合并只保留一个：" + "；".join(lines[:4]) + "。",
                suggestion="如果它们其实是两处不同的地方，可以在下方景点备选池里手动替换。",
            )
        )

    @staticmethod
    def _note_geo_gate(gate: Dict[str, Any], issues: List[CheckIssue]) -> None:
        """如实说明"哪些候选因为太远被排除在自动选点之外"。

        地域收敛是系统替用户做的取舍，必须写进体检清单让用户能核对与纠正：
        高德按行政区给结果（千岛湖属杭州市淳安县，离西湖 127 公里），
        不收敛的话模型会把它排进行程。想保留远的点，设成必去即可。
        """
        dropped = gate.get("dropped") or []
        if not dropped:
            return
        lines = "、".join(f"{name}（{km:.0f} 公里）" for name, km in dropped[:4])
        issues.append(
            CheckIssue(
                category="地点",
                severity="low",
                message=(
                    f"这些候选离你必去的地方 / 主城区太远（超过 {gate.get('gate_km') or 0:.0f} 公里），"
                    f"已排除在自动选点之外：" + lines
                    + ("…" if len(dropped) > 4 else "")
                    + "。"
                ),
                suggestion="想保留其中某个，可以把它填进左侧「必去景点」，系统会照办；"
                "也可以把天数加长，单独安排一天去远郊。",
            )
        )

    @staticmethod
    def _note_spot_filter(dropped: List[str], issues: List[CheckIssue]) -> None:
        """如实说明"哪些候选更像城市场馆、被排除在自动选点之外"。

        实测：兴趣里选了「娱乐」时，高德会把电影院（080601）当景点返回，
        于是「西航国际影城」排进了第 2 天的行程；「西湖区文体中心」（140800 文化宫）
        同理。现在分类码那一层已经断了源头，这里再如实汇报名字护栏拦下的点。
        """
        names = [name for name in dropped or [] if name]
        if not names:
            return
        issues.append(
            CheckIssue(
                category="地点",
                severity="low",
                message=(
                    "这些候选更像电影院 / 剧院 / 文体场馆，不属于景点，"
                    "已排除在自动选点之外：" + "、".join(names[:4])
                    + ("…" if len(names) > 4 else "") + "。"
                ),
                suggestion="想去的话可以在左侧「必去景点」里点名，系统会照办；"
                "也可以在下方景点备选池里手动替换进去。",
            )
        )

    @staticmethod
    def _note_diet(
        dropped: List[str], restrictions: List[str], issues: List[CheckIssue]
    ) -> None:
        """如实说明按饮食禁忌排除了哪些餐厅，以及判断口径的局限。"""
        if not dropped:
            return
        issues.append(
            CheckIssue(
                category="其他",
                severity="low",
                message=f"按你的饮食禁忌（{'、'.join(restrictions)}）排除了 {len(dropped)} 家餐厅："
                + "；".join(dropped[:3])
                + ("…" if len(dropped) > 3 else ""),
                suggestion="高德没有「是否清真 / 是否含海鲜」这类属性字段，这里只能按店名判断，"
                "名单可能不全，建议到店前再确认一次。",
            )
        )

    @staticmethod
    def _note_arduous_for_elderly(
        pref: Any, selected: List[POI], issues: List[CheckIssue]
    ) -> None:
        """同行有老人时，提示行程里体力消耗可能偏大的景点。

        这一条以前写在 GuardSkill 里，判的是 `"爬山" in pref.preferences`：
        而 preferences 被前后端同时锁死为「人文历史 / 自然风光 / 美食 / 娱乐」四个值，
        永远不可能等于「爬山」，所以那个分支从来没触发过。

        更重要的是位置：老人能不能爬得动，取决于**最终选中的景点**，
        而选点在检索之后才有结果，放在输入阶段判本来就没有依据。
        """
        if pref.travelers.elderly <= 0 or not selected:
            return
        hard = [p.name for p in selected if any(k in p.name for k in ARDUOUS_KEYWORDS)]
        if not hard:
            return
        issues.append(
            CheckIssue(
                category="其他",
                severity="low",
                message="同行有老人，行程里的 "
                + "、".join(hard[:3])
                + " 可能包含爬坡或较长步行。",
                suggestion="可点景点旁的「替换」换成更平缓的同类景点；实际难度以景区官方说明为准。",
            )
        )

    @staticmethod
    def _note_must_visit_issues(
        unlocated: List[str], coord_only: List[str], issues: List[CheckIssue]
    ) -> None:
        """点名要去的景点有问题时，明确告诉用户是哪几个、问题是什么。

        两种情况分开说，因为用户能做的补救不一样：
        - 没坐标：地图上根本画不出来，得换个写法或从下拉里重选；
        - 只有坐标、高德景点库里没有同名景点：位置上图了，但那可能不是个正规景点
          （典型是选中了「海湾」「停车场」这类条目），建议换成具体景点。
        """
        missing = [n for n in unlocated if n]
        if missing:
            issues.append(
                CheckIssue(
                    category="地点",
                    severity="medium",
                    message="以下你点名要去的景点没能定位到坐标：" + "、".join(missing[:5]) + "。",
                    suggestion="它们在行程里保留了位置，但不参与路线优化、也不会出现在地图上；"
                    "建议在左侧「必去景点」里从下拉候选中重新选择具体地点。",
                )
            )
        fuzzy = [n for n in coord_only if n]
        if fuzzy:
            issues.append(
                CheckIssue(
                    category="地点",
                    severity="medium",
                    message="以下你点名要去的名字，在高德景点库里没有对应景点，"
                    "只按输入时的候选坐标标了位置：" + "、".join(fuzzy[:5]) + "。",
                    suggestion="这类名字可能指的是海湾、海滩这类自然地名，或停车场等其他设施；"
                    "建议换成具体的景点名称（例如从候选里选某个景区），"
                    "这样才能拿到评分、实拍图，也才能参与路线优化。",
                )
            )

    @staticmethod
    def _resolve_start_date(pref: Any, issues: List[CheckIssue]) -> date:
        raw = pref.start_date or date.today().isoformat()
        try:
            return date.fromisoformat(raw)
        except ValueError:
            issues.append(
                CheckIssue(
                    category="时间",
                    severity="medium",
                    message=f"出行日期「{raw}」格式无法识别，已按今天开始计算。",
                    suggestion="建议填写 YYYY-MM-DD 格式的出行日期。",
                )
            )
            return date.today()

    @staticmethod
    def _default_summary(pref: Any) -> str:
        # 兴趣为空 = 用户没指定，就说「综合推荐」，而不是列出他从未提过的方向
        tags = "·".join(pref.preferences) if pref.preferences else "综合推荐"
        return f"{pref.destination}{pref.duration_days}日{pref.pace or '适中'}{tags}游"

    def _budget(self, pref: Any, days: List[DailyPlan], transport_sum: float):
        """预算拆解（估算，价格以实时为准）。

        口径说明（前端编辑后按同一口径实时重算）：
        - 门票：规划中所有景点票价求和（高德未提供票价记 0）
        - 餐饮：按每餐所选餐厅人均 × 出行人数求和（无人均按 60 元/餐/人）
        - 住宿：按每个夜晚所选酒店每晚价 × 房间数求和（未选到酒店按 350 元/晚/间）
        - 交通：景点间接驳 + 往返大交通（估算值，真实票价以购票为准）
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
        """往返大交通估算（未填写交通方式时返回 0，并由体检明确提示用户）。"""
        people = pref.travelers.total
        if pref.transportation == "高铁":
            return 150 * people * 2
        if pref.transportation == "飞机":
            return 500 * people * 2
        if pref.transportation == "自驾":
            return 300
        return 0
