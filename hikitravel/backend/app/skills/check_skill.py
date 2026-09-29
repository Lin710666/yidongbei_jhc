"""Skill4：规划体检与定向修复。

流程（检查 → 优化 → 对账 → 再判断 → 必要时重新生成）：
1. **确定性路线体检**：用真实坐标与真实里程算每天的总移动距离、折返、超长单段、
   异常绕行——这类问题不用问大模型，算就是了；
2. **定向优化**：按最近邻重排每天的景点顺序（从当天起点出发），
   然后用和首次生成同一套逻辑重建时间轴、餐厅、酒店与预算。
   **不调用大模型**，所以是秒级、可复现的；只换顺序，不换景点；
3. **预算对账**：估算总花费 vs 用户填的预算，超了就明说（一行减法，同样不问大模型）；
4. **大模型审查**：只审**代码算不出来**的三类语义问题——点位到底是不是个景点、
   有没有跟用户原话冲突、有没有偏离用户填的兴趣。
   路线顺序 / 距离 / 折返 / 预算分项 / 景点重复 / 时间重叠这些系统已经算过，明确不让它重复报告：
   实测让 7B 模型把全部七项都审一遍，它主要在复述代码的结论，还会编出"必去景点没排进去"
   这种与事实相反的结论，需要上百行过滤器去兜；
5. **带反馈重新生成**：只有在"硬伤"（系统判定的严重问题）还没解决时，
   才带着这些问题重新生成一版（最多一次）。
   ——如果直接整份作废重排，既慢又不稳定，所以这里只修该修的，且只修一次。

体检结论只报告、不悄悄改；凡是系统自动改过的（路线顺序、重新生成），
都会在结论里明确写出来给用户看。
"""
import json
import logging
import re
import time
from typing import Any, List, Optional

from ..llm.client import LLMClient
from ..models.plan import CheckIssue, PlanCheck, TravelPlan
from .base import Skill
from .errors import LLMOutputError, LLMUnavailableError
from .route import day_route_stats_from_day, order_nearest
from .scoring import distance_km, has_location

logger = logging.getLogger("travelplanner.check")

_SYSTEM_PROMPT = """你是一个旅游行程审稿人。下面给你一份已经排好的行程规划，
请只挑出**系统算不出来、必须靠理解语义**的问题，并只输出一个合法 JSON 对象
（不要输出解释文字、不要用代码块）。

输出结构：
{
  "passed": true 或 false,
  "summary": "一句话体检结论",
  "issues": [
    {
      "category": "地点真实性 | 地点 | 路径 | 重复 | 覆盖 | 时间 | 预算 | 其他",
      "severity": "high | medium | low",
      "message": "问题是什么（说人话，直接指出哪天哪个点）",
      "suggestion": "建议用户怎么处理"
    }
  ]
}

只审以下三类：
1. 地点真实性：行程里的景点/餐厅/酒店**是不是真的景点**？有没有把停车场、
   海湾／海滩这类自然地名、电影院、写字楼、商铺当成景点排进去？
   有没有明显属于别的城市的点位？（category 用「地点真实性」）
2. 与用户原话的冲突（**只在给了「用户原话」时判**）：原话里说过的要求有没有被违反？
   例如「不想爬山」却排了要爬的景区、「带老人」却一天排了四个点、
   「想吃海鲜」却全是快餐。有冲突才写，没冲突就什么都别写。（category 用「其他」）
   **这条只判景点，不判餐厅和酒店**；而且必须是"确实需要爬山/上山的景区"
   （名字里有山、峰、索道、栈道、缆车这类），**不能因为店名里带个「山」字就报**
   （例如餐厅「南山人家」不是爬山的地方）。没把握就不要写。
3. 与画像的匹配度：整份行程有没有偏离用户填的兴趣与节奏（例如选了自然风光，
   行程里却全是商场景点）。（category 用「其他」）

以下这些**不用你判**，系统已经按真实坐标与真实里程算过了，重复报告只会干扰用户：
路线顺序、单段距离、当天总里程、折返、绕行、预算分项、必去景点是否漏排、
景点是否重复、时间轴是否重叠、餐厅是否触犯饮食禁忌。这些即使你觉得有问题也不要写。

补充要求（很重要，避免误报）：
- 只根据上面给出的数据下结论，不要臆测不存在的日期、景点或行程
  （例如行程只有 3 天，就不要提"第 5 天"）。
- 没有把握就不要写：宁可少写一条，也不要写一条用户一看就是错的。
- 描述问题时引用行程里的具体日期与名称，便于用户核对。
- 同一个问题只写一条，不要换着说法重复列。
- 输出尽量精简：issues 最多 3 条，每条 message 一句话讲清"哪天、哪个点、什么问题"。

只输出 JSON。"""


class CheckSkill(Skill):
    """规划体检与定向修复（路线优化 + 大模型审查 + 一次性重生成）。"""

    name = "check"
    description = "检查路线与合理性、按真实坐标优化顺序，必要时带反馈重新生成一次"

    def __init__(
        self,
        llm: Optional[LLMClient] = None,
        planner: Any = None,
        max_regenerate: int = 1,
        check_model: str = "",
    ):
        self.llm = llm or LLMClient()
        self.planner = planner  # PlannerSkill：用于重建/重新生成
        self.max_regenerate = max_regenerate
        self.check_model = check_model

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        plan: TravelPlan = ctx["plan"]

        # 体检是核心能力，不做"可关闭"开关：大模型不可用就明确报错，而不是悄悄跳过
        if not self.llm.available():
            raise LLMUnavailableError(
                "未接入大模型 API（本地 Ollama 未启动或未安装），无法对规划做合理性体检。"
            )

        # 1) 确定性路线优化 + 只报告优化后仍存在的问题
        issues: List[CheckIssue] = list(ctx.get("plan_issues", []))
        issues += self._optimize_routes(ctx, plan)
        issues += self._route_issues(plan, ctx)

        # 路线优化是纯计算（秒级），优化完先把这一版发出去：
        # 用户能看到"顺序已经理顺了"，而不用等大模型审查跑完。
        self._emit(
            ctx,
            {
                "type": "plan",
                "stage": "路线已优化",
                "note": "已按真实坐标理顺当天顺序，正在做整体合理性审查",
                "plan": plan.model_dump(),
            },
        )

        # 2) 硬伤（系统判定 / 路线）未解决 → 带着问题重新生成一次，再体检一遍
        if self.max_regenerate > 0 and self.planner is not None and self._has_high(issues):
            outcome = self._regenerate(ctx, plan, issues)
            if outcome is not None:
                plan, regen_notes = outcome
                issues = list(ctx.get("plan_issues", [])) + regen_notes
                issues += self._route_issues(plan, ctx)
                issues.append(
                    CheckIssue(
                        category="其他",
                        severity="low",
                        message="已按上一版体检结论重新生成一版规划。",
                        suggestion="若仍不满意，可补全信息（如往返交通、节奏）后再次生成。",
                    )
                )

        # 2.5) 预算对账：用户填了预算就把估算和它比一比。
        #      这是确定性判断（一行减法），不该指望大模型想起来提一句。
        issues += self._budget_issues(plan)

        # 3) 大模型审查（审的是最终这一版规划）
        #    体检是**附加的质量报告**：它失败不该作废已经排好的行程。
        #    所以这里把失败如实写进问题清单，而不是抛出去让整单变成错误。
        try:
            issues += self._llm_review(plan, ctx)
        except LLMOutputError as exc:
            issues.append(
                CheckIssue(
                    category="其他",
                    severity="low",
                    message=f"规划体检未能完成：{exc}",
                    suggestion="这份行程本身是完整可用的；可以再点一次「生成」重试体检。",
                )
            )

        # 摘要自己生成：大模型的原话可能提到已被事实校验过滤掉的误报，会自相矛盾
        if issues:
            kinds = "、".join(sorted({i.category for i in issues}))
            summary = f"体检发现 {len(issues)} 个需要留意的问题（{kinds}）。"
        else:
            summary = "体检通过：没有发现明显问题。"
        plan.checks = PlanCheck(passed=len(issues) == 0, summary=summary, issues=issues)
        ctx["plan"] = plan
        return ctx

    # ---------------- 确定性路线体检与优化 ----------------
    def _optimize_routes(
        self, ctx: dict[str, Any], plan: TravelPlan
    ) -> List[CheckIssue]:
        """按最近邻重排每天景点顺序并重建规划；返回"改动说明"（没有改动就返回空）。"""
        if self.planner is None:
            return []

        day_orders: List[List] = []
        changed: List[tuple[int, float, float]] = []  # (第几天, 原距离, 优化后距离)
        metrics = ctx.get("metrics")  # 规划阶段预热好的真实驾车距离
        for i, day in enumerate(plan.daily_plans):
            attractions = [it.poi for it in day.timeline if it.poi.type == "景点"]
            # 当天起点：前一晚住的酒店（第一天没有则用现有顺序的第一个点）
            start = plan.daily_plans[i - 1].hotel if i > 0 else None
            # 当天终点：当晚酒店。判断"有没有更省路"时，前后必须用同一条完整链
            # （起点 → 景点 → 当晚酒店），否则会把"省了景点间、却多跑了回酒店那段"当成优化
            end = day.hotel
            reordered = (
                order_nearest(attractions, start, end, metrics)
                if len(attractions) > 1
                else attractions
            )
            before_km = self._distance_km_of(attractions, start, end, metrics)
            after_km = self._distance_km_of(reordered, start, end, metrics)
            # 只在真的更省路时才换顺序，并用同一个口径记录前后距离
            if [p.name for p in reordered] != [p.name for p in attractions] and after_km < before_km:
                changed.append((i, before_km, after_km))
            else:
                reordered = attractions
            day_orders.append(reordered)

        if not changed:
            return []

        rebuild_issues: List[CheckIssue] = []
        self.planner.rebuild_plan(ctx, plan, rebuild_issues, day_orders)

        details = "；".join(
            f"{plan.daily_plans[i].date} 景点间移动 {before:.0f} → {after:.0f} 公里"
            for i, before, after in changed
        )
        return rebuild_issues + [
            CheckIssue(
                category="路径",
                severity="low",
                message=f"已按真实坐标优化当天景点顺序（{details}）。",
                suggestion="顺序是按高德坐标算的最近邻；想按自己的习惯走，可以手动调整。",
            )
        ]

    @staticmethod
    def _distance_km_of(pois: List, start, end=None, metrics=None) -> float:
        """走完「起点 → 这些点 → 终点」的总距离（用于判断重排有没有更省路）。"""
        from .route import total_distance_km

        chain = ([start] if start is not None else []) + list(pois)
        if end is not None:
            chain = chain + [end]
        return total_distance_km(chain, metrics)

    @staticmethod
    def _day_points(day) -> List:
        """当天时间轴上的点（景点 + 餐厅），用于算移动距离。"""
        return [it.poi for it in day.timeline]

    @staticmethod
    def _budget_issues(plan: TravelPlan) -> List[CheckIssue]:
        """预算对账：估算总花费 vs 用户填的预算（确定性，不问大模型）。

        为什么值得单独判：预算是用户亲口给的硬约束。实测杭州 3 天那份规划
        估算 3892 元、用户填的是 2000 元，之前的体检一个字都没提——
        只有本地模型偶尔想起来才会说一句，说不说全看运气。
        """
        budget = plan.user_budget or 0
        total = plan.total_budget_estimate or 0
        if budget <= 0 or total <= budget:
            return []
        over = total - budget
        return [
            CheckIssue(
                category="预算",
                severity="medium",
                message=(
                    f"估算总花费 {total:.0f} 元，超出你填的预算 {budget:.0f} 元"
                    f" 共 {over:.0f} 元（{over / budget:.0%}）。"
                ),
                suggestion="可以把住宿换成更低的价位档、减少一个景点，或改坐高铁 / 缩短一天；"
                "预算明细在右下角，改完会实时重算。",
            )
        ]

    def _route_issues(self, plan: TravelPlan, ctx: dict[str, Any] = None) -> List[CheckIssue]:
        """报告优化后仍然存在的路线问题（长距离挪动、折返、绕行）。

        绕行判定用**本趟规划自己估出来的绕行系数**当基线（见 route.py 的说明），
        所以这种地形复杂的城市不会天天报"这段绕了 1.6 倍"。
        """
        issues: List[CheckIssue] = []
        metrics = (ctx or {}).get("metrics")
        baseline = float(getattr(metrics, "factor", 1.0) or 1.0)
        for day in plan.daily_plans:
            # 用时间轴版统计：里程取真实驾车里程，不再是直线距离
            stats = day_route_stats_from_day(day, road_baseline=baseline)
            for a, b, km in stats["long_legs"][:2]:
                issues.append(
                    CheckIssue(
                        category="路径",
                        severity="medium",
                        message=f"{day.date} 有一大段移动：{a} → {b} 约 {km:.0f} 公里。",
                        suggestion="这一处离当天其它点很远，建议换到更近的那天，或从景点备选池换成顺路的点。",
                    )
                )
            # 绕行：直线看着近、实际要绕一大圈（跨海、绕湾、单行线都会这样）
            for a, b, straight_km, road_km in stats.get("detours", [])[:2]:
                issues.append(
                    CheckIssue(
                        category="路径",
                        severity="medium",
                        message=(
                            f"{day.date} 的 {a} → {b} 直线只有 {straight_km:.1f} 公里，"
                            f"实际驾车要 {road_km:.1f} 公里（绕 {road_km / straight_km:.1f} 倍）。"
                        ),
                        suggestion="这一段实际比看上去远得多，建议换掉其中一个点，或改用更顺路的接驳方式。",
                    )
                )
            for a, b, c, extra in stats["backtracks"][:2]:
                issues.append(
                    CheckIssue(
                        category="路径",
                        severity="medium",
                        message=f"{day.date} 的 {a} → {b} → {c} 属于折返，多跑约 {extra:.0f} 公里。",
                        suggestion="调整这三处的先后顺序可以省下这段路。",
                    )
                )
        return issues

    @staticmethod
    def _has_high(issues: List[CheckIssue]) -> bool:
        return any(i.severity == "high" for i in issues)

    @staticmethod
    def _emit(ctx: dict[str, Any], event: dict) -> None:
        """把体检内部的进展播报给 SSE 流。

        约定与 Orchestrator._emit 一致：回调是"观察者"，它出错不该影响生成，
        所以这里吞掉异常只记日志。
        """
        callback = ctx.get("on_event")
        if callback is None:
            return
        try:
            callback(event)
        except Exception:  # pragma: no cover - 理论上不该发生
            logger.warning("体检进度回调失败", exc_info=True)

    # ---------------- 带反馈重新生成（最多一次） ----------------
    def _regenerate(
        self, ctx: dict[str, Any], plan: TravelPlan, issues: List[CheckIssue]
    ) -> Optional[tuple[TravelPlan, List[CheckIssue]]]:
        """把尚未解决的严重问题当反馈，让规划器重新排一版；更差就保留原版。

        返回 (新规划, 新规划上的提示)，返回 None 表示"保留原版"。
        """
        feedback = [i.message for i in issues if i.severity == "high"][:5]
        if not feedback:
            return None
        old_issues = list(ctx.get("plan_issues", []))
        # 这一步要重新调用大模型排一版，耗时和大模型规划相当，必须让用户看到
        self._emit(
            ctx,
            {
                "type": "step",
                "skill": "regenerate",
                "label": "按体检结论重排行程",
                "state": "start",
            },
        )
        started = time.perf_counter()
        try:
            new_plan, new_issues = self.planner.regenerate(ctx, feedback)
        except (LLMOutputError, LLMUnavailableError):
            # 重新生成失败：保留现有规划，不折腾用户
            ctx["plan"] = plan
            ctx["plan_issues"] = old_issues
            return None
        finally:
            self._emit(
                ctx,
                {
                    "type": "step",
                    "skill": "regenerate",
                    "label": "按体检结论重排行程",
                    "state": "done",
                    "seconds": round(time.perf_counter() - started, 1),
                },
            )

        # 新版也做一次确定性路线优化，两版在同一条件下比较
        notes = self._optimize_routes(ctx, new_plan)
        if self._metric(new_plan, new_issues) < self._metric(plan, old_issues):
            return new_plan, notes

        # 新版没更好：把原版放回去（重新生成只是尝试，不该让结果变差）
        ctx["plan"] = plan
        ctx["plan_issues"] = old_issues
        return None

    def _metric(self, plan: TravelPlan, issues: List[CheckIssue]) -> tuple:
        """比较两版规划好坏的粗略尺子：先看严重问题数，再看总移动距离。"""
        high = sum(1 for i in issues if i.severity == "high")
        total_km = sum(
                day_route_stats_from_day(d)["total_km"] for d in plan.daily_plans
        )
        return (high, round(total_km, 1))

    # ---------------- 大模型审查 ----------------
    def _llm_review(
        self, plan: TravelPlan, ctx: dict[str, Any]
    ) -> List[CheckIssue]:
        """把规划喂回大模型，取回问题清单（摘要由系统自己生成，避免与过滤后的问题矛盾）。"""
        pref = ctx["preference"]
        payload = json.dumps(
            {
                # 只给审查真正需要的字段：提示词越短，本地模型出结论越快
                "目的地": pref.destination,
                # 用户原话（对话模式才有）。画像字段装不下的诉求——"不想爬山""带老人"
                # 这类——只有原话里才有；排斥项删掉之后，这条是它们唯一的入口。
                **(
                    {"用户原话": (ctx.get("raw_text") or "").strip()}
                    if (ctx.get("raw_text") or "").strip()
                    else {}
                ),
                "必去景点": [m.name for m in pref.must_visit],
                "出行人数": pref.travelers.model_dump(),
                "节奏": pref.pace,
                "饮食禁忌": pref.dietary_restrictions,
                "行程天数（不要提到这个范围以外的第 N 天）": len(plan.daily_plans),
                "日期范围": (
                    f"{plan.daily_plans[0].date} ~ {plan.daily_plans[-1].date}"
                    if plan.daily_plans
                    else ""
                ),
                "住宿晚数": max(len(plan.daily_plans) - 1, 0),
                "预算": {
                    "总预算估算": plan.total_budget_estimate,
                    "分项": plan.budget_breakdown.model_dump(),
                    "用户预算": plan.user_budget,
                },
                "行程": [
                    {
                        "日期": day.date,
                        "天气": day.weather.model_dump(),
                        "当晚酒店": (day.hotel.name if day.hotel else None),
                    "当日移动距离(公里)": day_route_stats_from_day(day)["total_km"],
                        "安排": [
                            {
                                "时间": item.time,
                                "类型": item.poi.type,
                                "名称": item.poi.name,
                                "地址": item.poi.description,
                                "下一段交通": (
                                    f"{item.transport_to_next.mode} "
                                    f"{item.transport_to_next.duration}"
                                    if item.transport_to_next
                                    else None
                                ),
                            }
                            for item in day.timeline
                        ],
                    }
                    for day in plan.daily_plans
                ],
            },
            ensure_ascii=False,
        )

        data = self.llm.chat_json(
            _SYSTEM_PROMPT,
            payload,
            options={"temperature": 0.1, "num_predict": 350, "num_ctx": 4096},
            model=self.check_model or None,
        )
        if data is None:
            raise LLMOutputError(
                "规划体检失败：大模型没有返回可解析的 JSON 结果"
                + (f"（{self.llm.last_error}）" if self.llm.last_error else "")
                + "。请重试。"
            )

        raw_issues = data.get("issues")
        if not isinstance(raw_issues, list):
            if data.get("passed") is False:
                return [
                    CheckIssue(
                        category="其他",
                        severity="low",
                        message="规划体检未通过，但大模型没有给出具体问题。",
                        suggestion="建议人工核对一遍行程顺序与距离，或重新生成一次。",
                    )
                ]
            return []

        issues: List[CheckIssue] = []
        for raw in raw_issues:
            if not isinstance(raw, dict) or not raw.get("message"):
                continue
            try:
                issues.append(CheckIssue.model_validate(raw))
            except Exception:
                issues.append(
                    CheckIssue(
                        category="其他",
                        severity="low",
                        message=str(raw.get("message")),
                        suggestion=str(raw.get("suggestion") or ""),
                    )
                )
        return self._drop_contradicted(issues, plan)

    @staticmethod
    def _drop_contradicted(issues: List[CheckIssue], plan: TravelPlan) -> List[CheckIssue]:
        """丢掉与规划事实直接矛盾的问题。

        大模型偶尔会误报（例如住宿费明明有、却说"预算未包含住宿"）。
        这里只做能一眼证实/证伪的事实校验，不一刀切替换模型的判断。
        """
        breakdown = plan.budget_breakdown.model_dump()
        labelled = {
            "住宿": breakdown.get("hotel", 0),
            "门票": breakdown.get("tickets", 0),
            "餐饮": breakdown.get("dining", 0),
            "交通": breakdown.get("transport", 0),
        }
        # 事实一：每个景点出现在几天（用于证伪"景点重复"）
        days_of_name: dict[str, set[str]] = {}
        for day in plan.daily_plans:
            for item in day.timeline:
                if item.poi.type == "景点":
                    days_of_name.setdefault(item.poi.name, set()).add(day.date)
        # 事实二：时间轴里到底有没有重叠
        has_overlap = any(CheckSkill._has_time_overlap(d) for d in plan.daily_plans)
        # 事实三：行程里到底有哪些点（用于证伪"某某没被安排"）
        planned_names = {
            item.poi.name for day in plan.daily_plans for item in day.timeline
        } | {day.hotel.name for day in plan.daily_plans if day.hotel}
        #: 用户点名的"必去景点"。同一条高德记录在行程里会用**景点库里的正式名**
        #: （用户写"长江澳"，行程里是"平潭国际旅游岛·长江澳"），所以证伪
        #: "必去景点没排进去"这类误报时，要按"名字互相包含"来比，不能只比全等。
        must_names = [
            entry.name
            for entry in (plan.user_preference.must_visit if plan.user_preference else [])
            if entry.name
        ]
        missing_claims = ("未安排", "没有安排", "未被安排", "未出现", "没排", "遗漏")
        # 事实四：行程里各点的真实坐标（用于核对"相距 XX 公里"这类说法）
        located = {
            item.poi.name: item.poi
            for day in plan.daily_plans
            for item in day.timeline
            if has_location(item.poi)
        }
        plan_dates = [day.date for day in plan.daily_plans]

        kept: List[CheckIssue] = []
        for issue in issues:
            text = issue.message
            if issue.category == "预算":
                contradicted = any(
                    label in text
                    and ("未包含" in text or "未计入" in text)
                    and amount > 0
                    for label, amount in labelled.items()
                )
                if contradicted:
                    continue
            if "重叠" in text and not has_overlap:
                continue
            # 说"某个景点重复出现"（不管它归到哪一类），但没有任何景点出现在两天以上 → 矛盾
            has_duplicate = any(len(dates) > 1 for dates in days_of_name.values())
            if not has_duplicate and any(
                k in text for k in ("重复", "再次出现", "两次", "又安排")
            ):
                continue
            # 模型偶尔把 1 公里出头说成"距离较远"：2 公里以内步行/打车都不算问题，
            # 这类轻微夸大直接丢掉（阈值写在这里便于以后调）
            if "公里" in text:
                mentioned = [
                    float(v) for v in re.findall(r"(\d+(?:\.\d+)?)\s*公里", text)
                ]
                if mentioned and max(mentioned) < 2.0:
                    continue
            # 说某个点"没被安排"，但那个点明明就在行程里 → 矛盾
            if any(k in text for k in missing_claims):
                if any(len(name) >= 2 and name in text for name in planned_names):
                    continue
                # 换了个名字的同一处景点：问题里点名"长江澳"，行程里是
                # "平潭国际旅游岛·长江澳" → 也属于"明明排了却说没排"
                if any(
                    must in text
                    and any(must in name or name in must for name in planned_names)
                    for must in must_names
                    if len(must) >= 2
                ):
                    continue
            mentioned = [name for name in located if name in text]
            # 说"距离 XX 公里"，但按真实坐标算差得太远 → 矛盾（例如把 3 公里的两点说成 40 公里）
            if "公里" in text and len(mentioned) >= 2:
                real = distance_km(located[mentioned[0]], located[mentioned[1]])
                claimed = [
                    float(v) for v in re.findall(r"(\d+(?:\.\d+)?)\s*公里", text)
                ]
                if real and claimed and max(claimed) > max(real * 3, real + 10):
                    continue
            # 只说"距离较远/过远"但没给数字时，用真实坐标核对：
            # 两个点实际 3 公里以内（打车约十分钟）就属于轻微夸大，丢弃
            if (
                len(mentioned) == 2
                and any(k in text for k in ("较远", "过远", "距离远", "太远", "很远"))
            ):
                real = distance_km(located[mentioned[0]], located[mentioned[1]])
                if real is not None and real <= 3.0:
                    continue
            # 说"某景点被安排在这两天"，但实际没有任何景点出现在两天（且这只是一句判断，不是建议）
            dates_in_text = {d for d in plan_dates if d in text}
            if (
                not has_duplicate
                and mentioned
                and len(dates_in_text) >= 2
                and not any(k in text for k in ("建议", "可以", "不妨", "考虑"))
            ):
                continue
            kept.append(issue)
        return kept

    @staticmethod
    def _has_time_overlap(day) -> bool:
        """当天时间轴是否真的存在重叠（用来证伪模型的"时间重叠"误报）。"""

        def _minutes(value: str) -> Optional[int]:
            try:
                h, m = value.split(":")
                return int(h) * 60 + int(m)
            except (ValueError, AttributeError):
                return None

        spans = []
        for item in day.timeline:
            if "-" not in item.time:
                continue
            start_text, _, end_text = item.time.partition("-")
            start, end = _minutes(start_text), _minutes(end_text)
            if start is None or end is None:
                continue
            spans.append((start, end))
        spans.sort()
        return any(spans[i][1] > spans[i + 1][0] for i in range(len(spans) - 1))
