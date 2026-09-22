"""Skill 协同包。

每个 Skill 负责流水线中的一个环节，可独立开发、测试与替换：
- intent_skill    : Skill1 用户意图识别与信息采集（输入层）
- guard_skill     : 异常拦截（输入层，需求矛盾检测）
- retrieve_skill  : Skill2 多源数据获取与检索（数据层）
- planner_skill   : Skill3 智能规划生成（核心处理层）
- output_guard    : 输出层质检（生成之后体检：超预算 / 门票缺价 / 跨城…）

为什么异常拦截要分两层：`guard_skill` 跑在生成**之前**，只能看用户画像；
一份超预算三成、贴士还张冠李戴的方案，它是看不见的（实测过）。
所以生成完再过一遍 `output_guard`，两层都产出 Conflict、走同一条提示通道。
"""
from .base import Skill
from .intent_skill import IntentSkill
from .guard_skill import GuardSkill
from .retrieve_skill import RetrieveSkill
from .planner_skill import PlannerSkill
from .output_guard import OutputGuardSkill

__all__ = [
    "Skill",
    "IntentSkill",
    "GuardSkill",
    "RetrieveSkill",
    "PlannerSkill",
    "OutputGuardSkill",
]
