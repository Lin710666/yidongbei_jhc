"""异常拦截 Skill（输入层，比赛加分项）。

设计原则（与用户对齐）：系统只「检测 + 建议」，不擅自替用户修改画像。
例如「带80岁老人却要特种兵」，系统会提示并给出「调整为悠闲」的建议，
但把最终决定权交给用户——用户身体好、就是要特种兵，可以保持原样。
"""
from typing import Any, List

from ..models.plan import Conflict
from .base import Skill


class GuardSkill(Skill):
    """需求矛盾检测与建议（不擅自修改画像）。"""

    name = "guard"
    description = "检测需求矛盾并给出建议（选择权交给用户）"

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        pref = ctx["preference"]
        conflicts: List[Conflict] = []

        total = pref.travelers.total
        days = max(pref.duration_days, 1)
        per_person_per_day = pref.budget / max(total * days, 1)

        # 1. 预算偏低（仅提示，系统无法替用户"加钱"）
        if per_person_per_day < 100:
            conflicts.append(
                Conflict(
                    id="low_budget",
                    message=f"人均预算约 {per_person_per_day:.0f} 元/天，偏低",
                    suggestion="规划将优先安排免费景点，餐饮住宿从简",
                )
            )

        # 2. 老人 + 特种兵节奏（给出建议，可坚持原样）
        if pref.travelers.elderly > 0 and pref.pace == "特种兵":
            conflicts.append(
                Conflict(
                    id="elderly_pace",
                    message="同行有老人，但选择了「特种兵」节奏",
                    suggestion="可调整为「悠闲」节奏",
                    field="pace",
                    suggested_value="悠闲",
                )
            )

        # 3. 老人 + 爬山偏好
        if pref.travelers.elderly > 0 and "爬山" in pref.preferences:
            conflicts.append(
                Conflict(
                    id="elderly_climb",
                    message="同行有老人，但偏好包含「爬山」",
                    suggestion="可从偏好中移除「爬山」",
                    field="preferences",
                    suggested_value=[p for p in pref.preferences if p != "爬山"],
                )
            )

        # 4. 儿童 + 特种兵节奏
        if pref.travelers.children > 0 and pref.pace == "特种兵":
            conflicts.append(
                Conflict(
                    id="child_pace",
                    message="同行有儿童，但选择了「特种兵」节奏",
                    suggestion="可调整为「适中」节奏",
                    field="pace",
                    suggested_value="适中",
                )
            )

        # 5. 高龄老人 + 极低预算（强冲突）
        if pref.travelers.elderly > 0 and per_person_per_day < 30:
            conflicts.append(
                Conflict(
                    id="severe_budget_elderly",
                    message="预算与同行人体力存在较大冲突",
                    suggestion="可调整为免费、平缓的休闲游",
                    field="pace",
                    suggested_value="悠闲",
                )
            )

        # 6. 必去景点过多（仅提示，仍会全部安排，只是行程更紧凑）
        if len(pref.must_visit) > days * 4:
            conflicts.append(
                Conflict(
                    id="too_many_must",
                    message=f"特别想去的景点有 {len(pref.must_visit)} 个，{days} 天行程较难全部深度游玩",
                    suggestion="可考虑延长天数或精简必去清单",
                )
            )

        ctx["conflicts"] = conflicts
        return ctx


def apply_suggestions(pref: Any, conflicts: List[Conflict]) -> None:
    """将冲突中的可自动调整项应用到用户画像。

    仅当用户在前端明确点击「采纳建议」后才会调用本函数，
    保证系统的调整始终经过用户同意。
    """
    for c in conflicts:
        if c.field == "pace" and c.suggested_value is not None:
            pref.pace = c.suggested_value
        elif c.field == "preferences" and c.suggested_value is not None:
            pref.preferences = c.suggested_value
