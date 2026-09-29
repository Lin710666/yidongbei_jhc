"""Skill 层的领域异常。

统一原则（与用户对齐）：不静默降级、不猜测、不伪造数据。
任何"没法继续"的情况都抛出明确异常，由 API 层翻译成用户看得懂的中文提示。
"""


class SkillError(Exception):
    """Skill 流水线领域异常基类。"""


class LLMUnavailableError(SkillError):
    """未接入大模型 API（Ollama 未启动 / 未安装 / 模型未拉取）。"""


class LLMOutputError(SkillError):
    """大模型返回的内容不是可用的结构化结果。"""


class MissingRequiredInfoError(SkillError):
    """用户画像缺少生成规划所必需的信息（目的地 / 天数 / 人数 / 兴趣 / 预算）。"""

