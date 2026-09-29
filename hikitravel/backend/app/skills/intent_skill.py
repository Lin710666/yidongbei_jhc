"""Skill1：用户意图识别与信息采集（输入层）。

这里**不使用任何正则或关键词硬编码**：
自然语言的说法无穷无尽（「带娃」「老人腿脚不便」「想拍拍照」「别安排爬山」…），
写死的规则既容易漏，也容易把意思理解歪，更没法覆盖没预想到的表达。
所以只保留一条路径——把用户原话和结构化字段说明交给大模型，由它输出结构化画像。

大模型不可用时**不再退化为规则抽取**，而是抛出 LLMUnavailableError，
由 API 层明确提示用户（不静默降级、不猜）。
"""
import json
from typing import Any, Optional

from ..config import settings
from ..llm.client import LLMClient
from ..models.preference import UserPreference
from .base import Skill
from .errors import LLMOutputError, LLMUnavailableError, MissingRequiredInfoError

#: 输出结构说明（与 models/preference.py 的 UserPreference 字段一一对应）
_SCHEMA_HINT = """{
  "travelers": {"adults": 0, "children": 0, "elderly": 0},
  "destination": "",
  "duration_days": 0,
  "budget": 0,
  "preferences": [],
  "must_visit": [],
  "pace": "悠闲|适中|特种兵",
  "transportation": "自驾|高铁|飞机|本地",
  "dietary_restrictions": [],
  "start_date": "YYYY-MM-DD 或空字符串",
  "departure_time": "HH:MM"
}"""

_SYSTEM_PROMPT = f"""你是一个旅游需求结构化助手。请从用户的一句话需求里抽取字段，
只输出一个合法 JSON 对象，不要输出任何解释文字、不要用 markdown 代码块包裹。

输出结构必须严格如下（字段名、层级都不要改）：
{_SCHEMA_HINT}

抽取规则：
1. destination（目的地）：只有用户明确说了目的地才填。用户没说就**必须留空字符串**，
   绝对不要猜测、不要默认任何城市——系统会据此提示用户补充目的地。
2. must_visit（特别想去的景点）：这是最重要的字段。凡是用户表达出
   「想去 / 必去 / 一定要去 / 点名要去 / 特别想去 / 顺便打卡」的**具体景点名**，
   都要逐个完整列进数组，一个都不能漏，也不要合并同类项。
   例如「想去雷峰塔和西湖，顺便看看灵隐寺」→ ["雷峰塔", "西湖", "灵隐寺"]。
   每项只需要写**名字**（字符串），不要编造坐标、adcode 等你没有的信息。
   用户没有点名具体景点时留空数组，不要编造景点名。
3. preferences（兴趣导向）：取值只能是 ["人文历史", "自然风光", "美食", "娱乐"] 的子集。
   用户明确表达兴趣时按原意填；**用户没有表达时留空数组 []**，
   不要推断、不要默认填哪几项——系统会把「空 = 未填写」当作「全部类别都检索」，
   这样才能既拿到完整推荐，又不会让系统替你认领一个你从没提过的兴趣。
4. travelers / duration_days / budget：用户没说就填 0（或 0 人），**不要替用户编造**。
   「情侣 / 夫妻 / 两个人」= adults 2；「带老人」= elderly 至少 1；「带孩子」= children 至少 1。
   注意：除非用户明确说是"帮别人规划 / 替我爸妈安排"，否则**用户本人也是同行人**，
   adults 至少为 1（例如「带 80 岁老人游杭州」= adults 1 + elderly 1，共 2 人）。
5. pace（节奏）：用户说了按原意填；用户没说时，结合同行人推断
   （有老人或幼儿倾向「悠闲」，年轻人结伴且强调多玩可判为「特种兵」），否则用「适中」。
6. dietary_restrictions（饮食禁忌）：如「海鲜过敏」「清真」「素食」「不吃辣」等。
7. 其余未提及的字段用空字符串 / 空数组，不要编造。

只输出 JSON。"""

_REVISION_PROMPT = """你是一个旅游需求修订助手。用户已经有一版行程规划，现在提出了新的要求。
请输出**修订后的完整用户画像 JSON**：结构与「当前画像」完全一致，只改用户新要求涉及到的部分，
其余字段原样保留。

规则：
1. 只输出一个合法 JSON 对象，不要解释文字、不要用 markdown 代码块。
2. 字段名、层级、取值必须与原画像一致（枚举字段只能取原有取值：
   pace 只能是 悠闲/适中/特种兵，transportation 只能是 自驾/高铁/飞机/本地）。
3. 用户新要求里没提到的字段**保持原值**，不要顺手改。
4. 常见的修改意图请这样落到字段上：
   - "预算压到 2500 / 控制在 3000 以内" → 改 budget；
   - "有老人，别太赶 / 想悠闲一点" → 改 pace（必要时也补 travelers.elderly）；
   - "带小孩 / 加一个人" → 改 travelers；
   - "想去 XX / 一定要去 XX" → 加到 must_visit；
   - "改成 4 天 / 多玩一天" → 改 duration_days；
   - "坐高铁去 / 改成自驾" → 改 transportation。
   - must_visit 里的每一项都有 name / adcode / lat / lng：
     已有的项**连同 adcode、lat、lng 一起原样保留**（不要只留名字）；
     新增的项只写 name 即可，其余字段留空。
   - "想早点出发 / 8 点半出门" → 改 departure_time（HH:MM）；
   - "晚上想早点回酒店 / 9 点前回酒店" → 改 return_hotel_time（HH:MM）。
5. 用户是在已有规划基础上提要求，不要凭空重写整个需求。

只输出 JSON。"""


class IntentSkill(Skill):
    """意图识别与信息采集。"""

    name = "intent"
    description = "从用户原话提取结构化画像 UserPreference（纯大模型抽取，无正则）"

    def __init__(self, llm: Optional[LLMClient] = None):
        self.llm = llm or LLMClient()
        # 抽取是"照着说明填空"，对模型能力的要求低于规划与体检，
        # 因此允许单独指定一个更小的模型来提速（留空 = 与规划同款）。
        self.model = settings.ollama_intent_model or ""

    def run(self, ctx: dict[str, Any]) -> dict[str, Any]:
        # 表单模式：上游已经给出结构化画像，不需要再做语言解析
        if ctx.get("preference") is not None:
            return ctx

        raw = (ctx.get("raw_text") or "").strip()
        if not raw:
            raise MissingRequiredInfoError(
                "没有收到行程描述。请告诉我目的地、天数、同行人和想去的地方。"
            )

        if not self.llm.available():
            raise LLMUnavailableError(
                "未接入大模型 API（本地 Ollama 未启动或未安装），无法解析你的需求。"
                "请先启动大模型服务，或改用左侧表单逐项填写。"
            )

        ctx["preference"] = self._extract(raw)
        return ctx

    def _extract(self, raw: str) -> UserPreference:
        """调用大模型抽取画像；失败即报错，不再用规则兜底。"""
        # 温度 0：抽取任务要的是稳定复现，不需要发挥
        data = self.llm.chat_json(
            _SYSTEM_PROMPT,
            raw,
            options={"temperature": 0, "num_ctx": 4096},
            model=self.model or None,
        )
        if data is None:
            raise LLMOutputError(
                "大模型没有返回可解析的 JSON 画像"
                + (f"：{self.llm.last_error}" if self.llm.last_error else "")
                + "。请重试，或改用左侧表单逐项填写。"
            )
        try:
            return UserPreference.model_validate(data)
        except Exception as exc:  # 字段类型 / 取值不符约定
            raise LLMOutputError(
                f"大模型返回的画像字段不符合约定（{exc}）。请重试，或改用表单填写。"
            ) from exc

    # ---------------- 对话式修改规划：在既有画像上应用新要求 ----------------
    def apply_revision(
        self, current: UserPreference, plan_digest: str, instruction: str
    ) -> UserPreference:
        """把用户的新要求合并进当前画像（例如"预算压到 2500""第二天换室内"）。

        这样做的好处是"上下文"有地方存：修完的画像会跟着新规划一起返回并入库，
        用户下次还能继续在此基础上改，不需要重填表单。
        """
        if not self.llm.available():
            raise LLMUnavailableError(
                "未接入大模型 API（本地 Ollama 未启动或未安装），无法理解你的修改要求。"
                "请先启动大模型服务后重试。"
            )
        payload = json.dumps(
            {
                "当前画像": current.model_dump(),
                "当前行程（供参考）": plan_digest,
                "用户的新要求": instruction,
            },
            ensure_ascii=False,
        )
        data = self.llm.chat_json(
            _REVISION_PROMPT,
            payload,
            options={"temperature": 0, "num_ctx": 4096},
            model=self.model or None,
        )
        if data is None:
            raise LLMOutputError(
                "大模型没有返回可解析的画像 JSON"
                + (f"：{self.llm.last_error}" if self.llm.last_error else "")
                + "。请重试。"
            )
        try:
            return self._keep_must_visit_locations(current, UserPreference.model_validate(data))
        except Exception as exc:
            raise LLMOutputError(f"大模型返回的画像字段不符合约定（{exc}）。请重试。") from exc

    @staticmethod
    def _keep_must_visit_locations(
        current: UserPreference, revised: UserPreference
    ) -> UserPreference:
        """把原画像里必去景点的坐标补回修订结果。

        修订提示词要求模型"原样保留未提到的字段"，但坐标是嵌套字段，
        小模型很容易在重写 JSON 时只留下名字。用户明明在下拉里选过具体地点，
        丢坐标就等于退回到按名字猜，所以这里做一次确定性的回填。
        """
        by_name = {m.name: m for m in current.must_visit if m.has_location}
        if not by_name:
            return revised
        for item in revised.must_visit:
            if item.has_location:
                continue
            origin = by_name.get(item.name)
            if origin is not None:
                item.adcode = origin.adcode
                item.lat = origin.lat
                item.lng = origin.lng
        return revised
