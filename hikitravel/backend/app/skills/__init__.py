"""Skill 协同包。

每个 Skill 负责流水线中的一个环节，可独立开发、测试与替换：
- intent_skill    : Skill1 用户意图识别与信息采集（输入层，纯大模型，无正则）
- retrieve_skill  : Skill2 多源数据获取与检索（数据层，综合分排序）
- planner_skill   : Skill3 智能规划生成（核心处理层，大模型选点 + 系统组装）
- check_skill     : Skill4 规划体检（把第一版规划再喂回大模型审查）

公共约定见 base.py（统一 run(ctx) 接口）与 errors.py（统一异常）。

（原 Skill「异常拦截 GuardSkill」已删除：它是硬编码规则、只覆盖几条窄场景，
而"采纳建议"要重跑整单，性价比低。它想提供的矛盾提示由体检卡片承担。）
"""
from .base import Skill
from .check_skill import CheckSkill
from .intent_skill import IntentSkill
from .planner_skill import PlannerSkill
from .retrieve_skill import RetrieveSkill

__all__ = [
    "Skill",
    "IntentSkill",
    "RetrieveSkill",
    "PlannerSkill",
    "CheckSkill",
]
