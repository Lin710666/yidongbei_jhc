"""Skill 基类：所有协同 Skill 的统一接口。

设计约定：
- 每个 Skill 通过 run(ctx) 接收一个「上下文字典」，处理后返回更新后的上下文。
- 上下文在 Orchestrator 中按顺序流转，形成
  「意图识别 -> 异常拦截 -> 数据检索 -> 规划生成」的协同流水线。
- 上下文采用 dict 而非强类型，是为了让 Skill 之间解耦、可独立插拔。
"""
from abc import ABC, abstractmethod
from typing import Any


class Skill(ABC):
    """Skill 抽象基类。"""

    #: Skill 名称，用于日志与调度追踪
    name: str = "base"
    #: 一句话描述，用于 README 与调试
    description: str = ""

    @abstractmethod
    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        """执行该 Skill。

        Args:
            ctx: 上游传入的上下文字典。
        Returns:
            更新后的上下文字典，供下一个 Skill 使用。
        """
        raise NotImplementedError
