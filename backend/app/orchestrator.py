"""Skill 协同调度器（Orchestrator）。

串联四个 Skill，形成需求文档要求的流水线：
意图识别 -> 异常拦截 -> 数据检索 -> 规划生成。

异常拦截只产出「建议」不擅自修改；当用户明确点击「采纳建议」后，
通过 apply_suggestions_flag 应用建议再生成规划。
"""
from typing import Any, Optional

from .models.plan import TravelPlan
from .models.preference import UserPreference
from .skills import GuardSkill, IntentSkill, OutputGuardSkill, PlannerSkill, RetrieveSkill
from .skills.guard_skill import apply_suggestions


class Orchestrator:
    """多 Skill 协同调度器。"""

    def __init__(self) -> None:
        self.intent = IntentSkill()
        self.guard = GuardSkill()
        self.retrieve = RetrieveSkill()
        self.planner = PlannerSkill()
        # 输出层质检：跑在 planner 之后，专门体检"生成出来的方案"
        self.output_guard = OutputGuardSkill()

    def run(
        self,
        raw_text: Optional[str] = None,
        preference: Optional[UserPreference] = None,
        apply_suggestions_flag: bool = False,
        base: Optional[dict] = None,
    ) -> TravelPlan:
        """执行完整流水线，返回旅游规划。

        Args:
            raw_text: 用户自然语言描述（对话模式）。
            preference: 用户结构化画像（表单模式）。
            apply_suggestions_flag: 是否应用异常拦截给出的建议（用户已明确同意）。
            base: 对话模式下，前端表单已填的部分画像（精确输入，优先级高于对话模糊解析）。
        """
        ctx: dict[str, Any] = {
            "raw_text": raw_text,
            "preference": preference,
            "warnings": [],
        }

        ctx = self.intent.run(ctx)    # Skill1 意图识别与信息采集
        if base is not None:
            # 对话 + 表单并存：先解析对话，再用表单已填字段覆盖（表单更精确，对话补缺）
            ctx["preference"] = self._merge_base(ctx["preference"], base)
        self._normalize(ctx["preference"])  # 容忍不完整画像（空字段用默认值补齐）
        ctx = self.guard.run(ctx)     # 异常拦截（输入层：检测矛盾，给出建议，不擅自修改）
        if apply_suggestions_flag:    # 用户明确同意后应用建议
            apply_suggestions(ctx["preference"], ctx.get("conflicts", []))
        ctx = self.retrieve.run(ctx)  # Skill2 多源数据获取与检索
        ctx = self.planner.run(ctx)   # Skill3 智能规划生成

        # ★ 输出层质检。
        #
        # 必须放在 planner **之后** —— 它检查的是"生成出来的方案"，
        # 而上面那个 guard 跑在生成之前，只看得到用户画像。
        # 实测：成都 4 天、预算 6000 的方案估到 8054 元（超 34%），
        # 只有输入层的话 warnings 是空的，用户拿到超支方案却一句提示都没有。
        ctx = self.output_guard.run(ctx)

        plan = ctx["plan"]
        conflicts = ctx.get("conflicts", [])
        plan.warnings = [c.message for c in conflicts]
        plan.conflicts = conflicts
        return plan

    @staticmethod
    def _normalize(pref: UserPreference) -> None:
        """容忍不完整画像：关键字段缺失/为空时，用合理默认值补齐。

        对应「零门槛」要求——用户什么都不填也能生成规划，填了细节则更精准。
        """
        if not pref.destination:
            pref.destination = "杭州"
        if not pref.preferences:
            pref.preferences = ["人文历史", "自然风光"]
        if pref.duration_days < 1:
            pref.duration_days = 1
        if pref.budget <= 0:
            pref.budget = 2000
        if pref.travelers.total < 1:
            pref.travelers.adults = 1

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


# ---------------------------------------------------------------------------
# 共享实例
# ---------------------------------------------------------------------------
_SHARED: Optional[Orchestrator] = None


def get_orchestrator() -> Orchestrator:
    """取全局唯一的编排器实例。

    为什么要有这个函数：api.py（HikiTravel 原生接口）和 routers/ui_compat.py
    （5.0 界面兼容层）各自在模块顶层 new 了一个 Orchestrator。两个实例本身
    没坏处——run() 用的是传进来的 ctx，实例无状态——但 RetrieveSkill 里挂着
    Retriever，它要加载知识库、首查时还要建向量索引。建两份就是白做两遍。

    返回同一个实例既省一次索引构建，也让两边共享同一份缓存。
    """
    global _SHARED
    if _SHARED is None:
        _SHARED = Orchestrator()
    return _SHARED
