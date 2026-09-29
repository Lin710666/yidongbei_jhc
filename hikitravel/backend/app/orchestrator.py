"""Skill 协同调度器（Orchestrator）。

串联五个 Skill 形成流水线：
意图识别 → 必要信息校验 → 异常拦截 → 数据检索 → 规划生成 → 规划体检。

设计原则（与用户对齐）：
1. **不做静默默认值**：用户没填的关键信息（目的地 / 天数 / 人数 / 兴趣 / 预算）
   直接提示补充，不替用户拍脑袋决定。例如不再"目的地留空就默认杭州"，
   也不再把 city 参数悄悄换成别的城市——那会让用户拿到别处的景点。
2. **不保底、不伪造**：大模型 / 高德不可用时直接抛错提示用户，
   不降级成另一套口径，也不用编造的数据把流程走完。
"""
import logging
import time
from typing import Any, Callable, Dict, List, Optional

from .config import settings
from .models.plan import TravelPlan
from .models.preference import UserPreference
from .skills import CheckSkill, IntentSkill, PlannerSkill, RetrieveSkill
from .skills.errors import MissingRequiredInfoError

logger = logging.getLogger("travelplanner")

#: Skill 名 -> 给用户看的进度文案（前端流式进度条直接用这个）
SKILL_LABELS: Dict[str, str] = {
    "intent": "理解你的需求",
    "retrieve": "检索景点、餐厅与天气",
    "planner": "安排每天行程",
    "check": "规划体检（检查绕路 / 重复 / 时间）",
}


class Orchestrator:
    """多 Skill 协同调度器。"""

    def __init__(self) -> None:
        self.intent = IntentSkill()
        self.retrieve = RetrieveSkill()
        self.planner = PlannerSkill()
        # 体检需要调用规划器做「定向优化后的重建」与「带反馈重新生成」
        self.check = CheckSkill(
            planner=self.planner,
            max_regenerate=settings.plan_max_regenerate,
            check_model=settings.ollama_check_model,
        )

    def run(
        self,
        raw_text: Optional[str] = None,
        preference: Optional[UserPreference] = None,
        base: Optional[dict] = None,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> TravelPlan:
        """执行完整流水线，返回旅游规划。

        Args:
            raw_text: 用户自然语言描述（对话模式）。
            preference: 用户结构化画像（表单模式）。
            base: 对话模式下，前端表单已填的部分画像（精确输入，优先级高于对话解析）。
            on_event: 进度回调（供 SSE 流式接口使用）。每个 Skill 开始/结束、
                以及行程初稿与最终结果就绪时各回调一次；只做通知，传 None 即完全关闭。
        """
        ctx: dict[str, Any] = {
            "raw_text": raw_text,
            "preference": preference,
            "on_event": on_event,
        }

        ctx = self._run_skill(self.intent, ctx, on_event)  # Skill1 意图识别与信息采集（纯大模型）
        if base is not None:
            # 对话 + 表单并存：先解析对话，再用表单已填字段覆盖（表单更精确，对话补缺）
            ctx["preference"] = self._merge_base(ctx["preference"], base)

        self._require_basic_info(ctx["preference"])  # 缺信息直接提示，不静默补默认值
        return self._pipeline(ctx, on_event)

    def revise(
        self,
        message: str,
        plan: TravelPlan,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> TravelPlan:
        """对话式修改已有规划。

        上下文就存在规划本身里（plan.user_preference）：用户在既有画像上提新要求，
        大模型只改要求的字段，其余保持不变，然后重新走一遍检索/规划/体检。
        用户不用重填表单，也不用重新描述一遍需求。
        """
        current = plan.user_preference
        if current is None:
            raise MissingRequiredInfoError(
                "这版规划是旧版本生成的，没有保存当时的画像，无法直接按对话修改。"
                "请重新生成一版规划后再做调整。"
            )
        if not (message or "").strip():
            raise MissingRequiredInfoError("请先写下你想怎么改，例如「预算压到 2500，改成悠闲」")

        digest = self._plan_digest(plan)
        revised = self.intent.apply_revision(current, digest, message.strip())
        self._require_basic_info(revised)
        ctx: dict[str, Any] = {
            "preference": revised,
            "raw_text": message,
            "on_event": on_event,
        }
        return self._pipeline(ctx, on_event)

    def _pipeline(
        self,
        ctx: dict[str, Any],
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> TravelPlan:
        """执行「数据检索 → 规划生成 → 规划体检」这三段（意图识别已在调用方完成）。

        （原先还有一段 GuardSkill「需求矛盾检测」，现已删除：它是硬编码规则、
        只能判几条窄场景，而"采纳"要重跑整单，体验薄。逻辑上它想做的事
        ——矛盾提示——已经由体检卡片承担。）
        """
        ctx = self._run_skill(self.retrieve, ctx, on_event)  # Skill2 多源数据获取与检索
        ctx = self._run_skill(self.planner, ctx, on_event)  # Skill3 智能规划生成

        # 行程初稿先发出去：体检是最耗时的一步（本机实测 59~75 秒），
        # 不该让用户为了看行程而等它跑完（详见 routers/api.py 的 SSE 接口）。
        plan = ctx["plan"]
        self._emit(
            on_event,
            {
                "type": "plan",
                "stage": "初稿",
                "note": "行程已排好，正在做规划体检（检查绕路、重复、时间安排）",
                "plan": plan.model_dump(),
            },
        )

        ctx = self._run_skill(self.check, ctx, on_event)  # Skill4 规划体检（优化 + 审查）

        plan = ctx["plan"]
        self._emit(
            on_event,
            {
                "type": "done",
                "plan": plan.model_dump(),
                "checks": plan.checks.model_dump() if plan.checks else None,
            },
        )
        return plan

    @staticmethod
    def _plan_digest(plan: TravelPlan) -> str:
        """把行程压缩成几行文字，作为"当前安排"提供给大模型参考。"""
        lines: List[str] = []
        for day in plan.daily_plans:
            names = "、".join(item.poi.name for item in day.timeline)
            lines.append(f"{day.date}（{day.weather.condition}）：{names}")
        return "\n".join(lines)

    @staticmethod
    def _run_skill(
        skill: Any,
        ctx: dict[str, Any],
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> dict[str, Any]:
        """执行单个 Skill 并记录耗时（便于定位"生成慢在哪一步"）。

        同时把「开始 / 结束 + 耗时」通过 on_event 播报出去，供前端显示实时进度。
        """
        name = getattr(skill, "name", "?")
        label = SKILL_LABELS.get(name, name)
        Orchestrator._emit(
            on_event, {"type": "step", "skill": name, "label": label, "state": "start"}
        )
        started = time.perf_counter()
        try:
            return skill.run(ctx)
        finally:
            seconds = time.perf_counter() - started
            logger.info("skill=%s 用时 %.1fs", name, seconds)
            Orchestrator._emit(
                on_event,
                {
                    "type": "step",
                    "skill": name,
                    "label": label,
                    "state": "done",
                    "seconds": round(seconds, 1),
                },
            )

    @staticmethod
    def _emit(
        on_event: Optional[Callable[[Dict[str, Any]], None]], event: Dict[str, Any]
    ) -> None:
        """把进度播报出去。回调出错只记日志——进度观察者不该影响生成本身。"""
        if on_event is None:
            return
        try:
            on_event(event)
        except Exception:  # pragma: no cover - 理论上不该发生
            logger.warning("进度回调失败", exc_info=True)

    @staticmethod
    def _require_basic_info(pref: UserPreference) -> None:
        """关键信息缺失就直接提示用户补充，不用默认值替用户做决定。"""
        missing: List[str] = []
        if not (pref.destination or "").strip():
            missing.append("目的地（例如「杭州」）")
        if pref.duration_days < 1:
            missing.append("游玩天数")
        if pref.travelers.total < 1:
            missing.append("出行人数（至少 1 人）")
        # 兴趣导向**不设为必填**：它只影响"搜哪几类景点"，不是规划能否成立的前提。
        # 没填时由 RetrieveSkill 搜全部类别（见那边 PREFERENCE_TYPES 的兜底），
        # 用户拿到的是一份综合推荐，比「因为少选一项就不给生成」有用得多。
        # 注意这不算"静默替用户做决定"——目的地/天数/人数/预算才是会改变
        # 规划正确性的关键信息，缺了必须问；兴趣只是筛选范围。
        if pref.budget <= 0:
            missing.append("总预算")
        if missing:
            raise MissingRequiredInfoError(
                "还缺少这些信息，请补充后再生成规划：" + "、".join(missing) + "。"
            )

    @staticmethod
    def _merge_base(text_pref: UserPreference, base: dict) -> UserPreference:
        """合并「对话解析结果」与「表单已填画像」：表单字段优先（更精确），对话补缺。

        base 为前端表单的 Partial 画像（仅含用户实际填写的字段），travelers 做子字段合并。
        """
        data = text_pref.model_dump()
        travelers = base.get("travelers")
        if isinstance(travelers, dict):
            data["travelers"].update(travelers)
        for k, v in base.items():
            if k != "travelers":
                data[k] = v
        return UserPreference.model_validate(data)
