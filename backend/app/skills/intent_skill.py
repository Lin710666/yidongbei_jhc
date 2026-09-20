"""Skill1：用户意图识别与信息采集（输入层）。

将用户的自然语言对话或极简表单转换为结构化 UserPreference 画像。
优先用 LLM（Ollama）做结构化抽取，LLM 不可用时退化为规则抽取，
保证无 AI 环境下也能跑通。
"""
import re
from typing import Any, Optional

from ..llm.client import LLMClient
from ..models.preference import Travelers, UserPreference
from .base import Skill


class IntentSkill(Skill):
    """意图识别与信息采集。"""

    name = "intent"
    description = "从对话/表单中提取用户画像 UserPreference"

    def __init__(self, llm: Optional[LLMClient] = None):
        self.llm = llm or LLMClient()

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        # 若上游已直接给出结构化画像（表单模式），跳过解析
        if ctx.get("preference") is not None:
            return ctx

        raw = ctx.get("raw_text", "")
        pref = self._parse_llm(raw)
        if pref is None:
            pref = self._parse_rules(raw)
        ctx["preference"] = pref
        return ctx

    # ---------------- LLM 结构化抽取 ----------------
    def _parse_llm(self, raw: str) -> Optional[UserPreference]:
        system = (
            "你是旅游需求结构化抽取助手。从用户描述中提取字段，只输出合法 JSON，"
            "结构如下："
            '{"travelers":{"adults":0,"children":0,"elderly":0},'
            '"destination":"","duration_days":0,"budget":0,'
            '"preferences":[],"must_visit":[],"pace":"悠闲|适中|特种兵",'
            '"transportation":"自驾|高铁|飞机|本地",'
            '"dietary_restrictions":[],"avoidances":[],'
            '"start_date":"","origin":""}。'
            "缺省字段用合理默认值，preferences 取值限于：人文历史/自然风光/美食/娱乐；"
            "must_visit 为用户特别想去的景点名列表（如「想去雷峰塔和西湖」应提取为 [\"雷峰塔\",\"西湖\"]），无则留空。"
        )
        data = self.llm.chat_json(system, raw)
        if data is None:
            return None
        try:
            return UserPreference.model_validate(data)
        except Exception:
            return None

    # ---------------- 规则抽取（降级）----------------
    def _parse_rules(self, raw: str) -> UserPreference:
        pref = UserPreference()

        # 目的地：去/到/游 + 地名
        m = re.search(r"(?:去|到|游|玩)\s*([一-龥]{2,8})", raw)
        if m:
            pref.destination = m.group(1).rstrip("市县")

        # 人数与同行人构成（对话模式做「尽力而为」的粗提取；精确输入请用前端表单）
        m = re.search(r"(\d+)\s*人", raw)
        total = int(m.group(1)) if m else 1
        # 情侣/夫妻/两人等表述隐含 2 名成人
        if re.search(r"情侣|夫妻|两口子|二人|两人|双人", raw):
            total = 2
        elderly = 1 if re.search(r"老人|奶奶|爷爷|外婆|外公|[7-9]0岁", raw) else 0
        children = 1 if re.search(r"小孩|孩子|儿童|宝宝", raw) else 0
        adults = max(total - elderly - children, 0) if (elderly or children) else total
        pref.travelers = Travelers(adults=adults, children=children, elderly=elderly)

        # 天数
        m = re.search(r"(\d+)\s*天", raw)
        if m:
            pref.duration_days = int(m.group(1))

        # 预算（支持「2000元」与「预算2000」两种写法）
        m = re.search(r"(\d+)\s*(?:元|块钱|块)", raw) or re.search(r"预算\s*(\d+)", raw)
        if m:
            pref.budget = float(m.group(1))

        # 特别想去的景点（「想去X」「必去X」等表述，尽力提取；精确输入请用表单）
        m = re.search(r"(?:想去|必去|一定要去|特别想去)\s*([^\。，,；;]+)", raw)
        if m:
            seg = re.split(r"[、，,和与及]|\s+", m.group(1))
            pref.must_visit = [s.strip(" 的了啊呀吧").strip() for s in seg if s.strip()]

        # 兴趣导向
        tags = []
        if re.search(r"人文|历史|文化|古迹|博物馆", raw):
            tags.append("人文历史")
        if re.search(r"自然|风光|山水|风景|公园", raw):
            tags.append("自然风光")
        if re.search(r"美食|小吃|餐厅|吃", raw):
            tags.append("美食")
        if re.search(r"娱乐|演出|主题|乐园", raw):
            tags.append("娱乐")
        pref.preferences = tags or ["人文历史", "自然风光"]

        # 节奏
        if re.search(r"特种兵|紧凑|打卡|暴走", raw):
            pref.pace = "特种兵"
        elif re.search(r"悠闲|轻松|躺平|慢|度假", raw):
            pref.pace = "悠闲"

        # 交通
        if "自驾" in raw:
            pref.transportation = "自驾"
        elif "高铁" in raw:
            pref.transportation = "高铁"
        elif "飞机" in raw or "航班" in raw:
            pref.transportation = "飞机"

        # 饮食禁忌
        if re.search(r"海鲜|过敏", raw):
            pref.dietary_restrictions.append("海鲜")
        if "清真" in raw:
            pref.dietary_restrictions.append("清真")
        if "素食" in raw:
            pref.dietary_restrictions.append("素食")

        # 避雷
        if "爬山" in raw:
            pref.avoidances.append("爬山")
        if "排队" in raw:
            pref.avoidances.append("排队")
        if "网红" in raw:
            pref.avoidances.append("网红打卡")

        return pref
