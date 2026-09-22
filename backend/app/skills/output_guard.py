"""输出层质检 Skill（生成之后的体检）。

## 为什么需要它

原来的 `GuardSkill` 是**输入层**的：它在 `orchestrator.run()` 里跑在
「检索 → 规划」**之前**，所以只能看用户画像（预算偏低、老人配特种兵节奏…），
**永远看不到生成出来的那份方案**。

后果实测过：

   成都 4 天，用户预算 6000 元 → 方案估算 8054 元（超 34%）
   plan.warnings == []          ← 一句提示都没有

一份超预算三分之一、贴士还张冠李戴的方案，系统一声不吭地交给用户。
评审表里"异常拦截"是加分项，而它恰好拦不住该拦的。

## 这一层查什么（全部只看生成结果，不看输入）

1. **超预算** —— 估出来的总花费明显高于用户给的预算
2. **门票未计入** —— 有景点没拿到票价（高德景点 POI 大多不带 `biz_ext.cost`），
   预算里按 0 算，**必须说清楚**，不能默认"免费"
3. **天数对不上** —— 排出来的天数 ≠ 用户要的天数
4. **跨城** —— 行程里出现了非目的地的地点
5. **时间倒挂** —— 同一天的时间段不是递增的
6. **同一景区拆成多项** —— 例如「周庄古镇」和「周庄沈厅」占掉一整个下午，
   本质是一个地方；提示用户这是在同一个景区里逛。

产出照旧走 `Conflict`，因而和输入层的警告是同一条通道：
规则里只给「提示 + 建议」，**不擅自改方案**。
"""
from typing import Any, List

from ..models.plan import Conflict, TravelPlan
from .base import Skill


class OutputGuardSkill(Skill):
    """对生成好的方案做体检，产出提示（不改方案）。"""

    name = "output_guard"
    description = "对生成的方案做质检：超预算 / 门票缺价 / 天数 / 跨城 / 时间倒挂"

    #: 超过预算这个比例才提示（留一点余量，估算本来就有误差）
    BUDGET_TOLERANCE = 1.10

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        plan: TravelPlan | None = ctx.get("plan")
        if plan is None:
            return ctx
        pref = ctx.get("preference")
        found: List[Conflict] = []
        found += self._budget(plan, pref)
        found += self._tickets(plan)
        found += self._days(plan, pref)
        found += self._cross_city(plan, pref)
        found += self._time_order(plan)
        found += self._late_meal(plan)
        found += self._same_scenic(plan)
        found += self._round_trip_note(plan, pref)
        # 和输入层的警告合并：ctx["conflicts"] 是输入层已经放好的
        ctx["conflicts"] = list(ctx.get("conflicts") or []) + found
        return ctx

    # ------------------------------------------------------------------ 各项

    @staticmethod
    def _round_trip_note(plan: TravelPlan, pref: Any) -> List[Conflict]:
        """没填出发地时，**明确告诉用户往返大交通是估的**。

        为什么要有这一条：预算里的"往返大交通"要靠「出发地 → 目的地」的距离算，
        而工作台里出发地是**选填**，多数人不会填。没填时只能退回到一个固定值
        （高铁 150 元/人·单程），跟实际距离可能差很多 —— 杭州→上海约 73 元、
        杭州→乌鲁木齐要上千。

        与其让用户对着一个不知从哪来的数字发愣，不如把口径摆出来：
        填上出发地就会按实际距离重算。
        """
        if pref is None:
            return []
        mode = str(getattr(pref, "transportation", "") or "")
        origin = str(getattr(pref, "origin", "") or "").strip()
        if mode in ("", "本地") or origin:
            return []
        bd = getattr(plan, "budget_breakdown", None)
        est = float(getattr(bd, "transport", 0) or 0) if bd else 0.0
        if est <= 0:
            return []
        return [Conflict(
            id="round_trip_estimated",
            message=(
                f"没填出发地，交通里的「往返大交通」是按 {mode} 的固定值估的"
                f"（共 {est:.0f} 元）—— 跟实际距离可能差很多"
            ),
            suggestion="填上「出发地」后会按出发地到目的地的实际距离重算（同城则为 0）",
        )]

    @staticmethod
    def _budget(plan: TravelPlan, pref: Any) -> List[Conflict]:
        budget = float(getattr(pref, "budget", 0) or 0)
        est = float(plan.total_budget_estimate or 0)
        if budget <= 0 or est <= 0:
            return []
        if est <= budget * OutputGuardSkill.BUDGET_TOLERANCE:
            return []
        over = est - budget
        pct = over / budget * 100
        return [Conflict(
            id="budget_over",
            message=f"方案估算 {est:.0f} 元，比你给的预算 {budget:.0f} 元高 {over:.0f} 元（{pct:.0f}%）",
            suggestion="可以缩短天数、换更经济的住宿，或在设置里调高预算；也可以直接照着用，估算本来偏保守",
        )]

    @staticmethod
    def _tickets(plan: TravelPlan) -> List[Conflict]:
        """有景点没票价时必须说清楚 —— 预算里是按 0 算的。"""
        no_price = [
            it.poi.name
            for d in plan.daily_plans
            for it in d.timeline
            if it.poi and it.poi.type == "景点" and not it.poi.price
        ]
        if not no_price:
            return []
        shown = "、".join(no_price[:3])
        more = f" 等 {len(no_price)} 个" if len(no_price) > 3 else ""
        return [Conflict(
            id="ticket_unknown",
            message=f"{len(no_price)} 个景点没拿到门票价（{shown}{more}），预算里的门票按 0 计",
            suggestion="这些景点可能有门票，实际花费会比估算高；请以景区公告为准",
        )]

    @staticmethod
    def _days(plan: TravelPlan, pref: Any) -> List[Conflict]:
        want = int(getattr(pref, "duration_days", 0) or 0)
        got = len(plan.daily_plans or [])
        if not want or want == got:
            return []
        return [Conflict(
            id="day_mismatch",
            message=f"你要求 {want} 天，方案里排了 {got} 天",
            suggestion="可重新生成，或手动增删天数",
        )]

    @staticmethod
    def _cross_city(plan: TravelPlan, pref: Any) -> List[Conflict]:
        dest = str(getattr(pref, "destination", "") or "").strip()
        if not dest:
            return []
        others: List[str] = []
        for d in plan.daily_plans:
            for it in (d.timeline or []):
                city = str(getattr(it.poi, "city", "") or "")
                # 用"包含"判断：「成都市」也算「成都」
                if city and dest not in city and city not in dest:
                    if city not in others:
                        others.append(city)
        if not others:
            return []
        return [Conflict(
            id="cross_city",
            message=f"行程里出现了非目的地的地点（{ '、'.join(others[:3]) }），目的地是「{dest}」",
            suggestion="这通常是搜索关键词太宽导致的，可换更具体的关键词或手动替换景点",
        )]

    @staticmethod
    def _time_order(plan: TravelPlan) -> List[Conflict]:
        bad: List[str] = []
        for d in plan.daily_plans:
            ts = [it.time for it in (d.timeline or []) if it.time]
            if ts != sorted(ts):
                bad.append(d.date)
        if not bad:
            return []
        return [Conflict(
            id="time_order",
            message=f"{ '、'.join(bad[:3]) } 的时间段不是依次递增的",
            suggestion="可手动调整顺序，或去掉过长的单项",
        )]

    @staticmethod
    def _late_meal(plan: TravelPlan) -> List[Conflict]:
        """正餐被排到深夜 / 凌晨 —— 一天塞太满的信号。

        实测：成都方案里第三天晚餐是 **23:20-00:50**、第二天 21:33 开始。
        根源是"每天固定排 3 个景点"，09:00 出发算下来就是会排到半夜
        （已在 planner 的 _safe_per_day 里按时间预算夹住）。
        这里再兜一道：万一是"必去景点太多"顶出来的，也要明确告诉用户。
        """
        late: List[str] = []
        for d in plan.daily_plans:
            for it in (d.timeline or []):
                if not it.poi or it.poi.type != "餐厅":
                    continue
                hh = (it.time or "")[:2]
                if not hh.isdigit():
                    continue
                h = int(hh)
                if h >= 21 or h < 6:
                    late.append(f"{d.date} {it.time} {it.poi.name[:16]}")
        if not late:
            return []
        return [Conflict(
            id="late_meal",
            message=f"有正餐被排到了深夜/凌晨：{ '；'.join(late[:2]) }（共 {len(late)} 顿）",
            suggestion="这一天排得太满了，可以少安排一个景点，或把节奏调成「悠闲」",
        )]

    @staticmethod
    def _same_scenic(plan: TravelPlan) -> List[Conflict]:
        """同一景区被拆成多项（名称互相包含）。

        实测：苏州 Day2 排了「周庄古镇」+「周庄沈厅」，两项占掉整个下午 ——
        本质是一个景区里逛，分开列会让人以为去了两个地方。
        """
        pairs: List[str] = []
        for d in plan.daily_plans:
            names = [it.poi.name for it in (d.timeline or []) if it.poi and it.poi.type == "景点"]
            for i in range(len(names)):
                for j in range(i + 1, len(names)):
                    a, b = names[i], names[j]
                    if a and b and (a in b or b in a):
                        pairs.append(f"{a} / {b}")
        if not pairs:
            return []
        return [Conflict(
            id="same_scenic",
            message=f"同一天里有看起来属于同一景区的条目：{ '；'.join(pairs[:2]) }",
            suggestion="如果是同一个景区，可以合并成一项、把时间留给别处",
        )]
