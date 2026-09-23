"""用户画像输入模型（对应需求文档「模块1：用户意图识别与信息采集」）。

这是整个系统的输入层数据结构，由意图识别 Skill 从对话/表单中提取。
前端有同名 TypeScript 接口与之对齐，保证前后端字段一致。
"""
import re
from typing import Any, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

#: 「上午/9点/9:30/09:00」这类自然语言时间 -> "HH:MM"。
#: 顺序有意义：先匹配带分钟的具体时刻，再退到只给小时的，最后才是模糊的时段词。
_TIME_PATTERNS = (
    (re.compile(r"^\s*(\d{1,2})\s*[:：]\s*(\d{1,2})"), None),          # 9:30 / 09：00
    (re.compile(r"^\s*(\d{1,2})\s*点\s*半"), "half"),                   # 7点半 -> :30
    (re.compile(r"^\s*(\d{1,2})\s*点\s*(\d{1,2})?\s*分?"), None),       # 9点 / 9点30分
    (re.compile(r"^\s*(\d{1,2})\s*[时hH]"), None),                     # 9时 / 9h
)
#: 只给时段时的兜底时刻。
#: ★ 顺序有意义：**更具体的词必须排在更笼统的词前面**。
#:   比如「深夜」要排在「夜里」前、「凌晨」要排在「早上」前 ——
#:   否则会被更短/更早的那条先命中（这个坑在时间解析里很常见）。
_PERIOD_DEFAULTS = (
    ("凌晨", "05:00"), ("清晨", "06:00"), ("早上", "08:00"), ("早晨", "08:00"),
    ("半夜", "23:00"), ("深夜", "22:00"),
    ("上午", "09:00"), ("中午", "12:00"), ("下午", "14:00"),
    ("傍晚", "17:30"), ("晚上", "19:00"), ("夜里", "20:00"), ("晚点", "19:00"),
)


def norm_hhmm(value: Any, default: str = "09:00") -> str:
    """把各种写法的时间收敛成 `"HH:MM"`。

    ★ 为什么需要（实测踩到的 bug）：
      `departure_time` / `return_hotel_time` 在模型里声明成 "HH:MM"，
      但**没有任何校验或规范化**。而 `planner_skill._add_minutes()` 是直接

          h, m = map(int, t.split(":"))

      于是传进来 `"上午"` 就抛 ValueError，
      `POST /api/plan` 直接 500（不是 400，因为异常在生成阶段才炸）。

      桌面表单只填 `start_date`、时间靠默认值 "09:00"，所以一直没暴露；
      而手机端/对话端把"上午出发"这种自然语言填进去就会踩。
      一个字段类型没约束，整条规划链路就 500 —— 这种必须在模型层收口。

    转换规则：
        09:00 / 9:00 / 9：00   -> 09:00
        9点 / 9点30分           -> 09:00 / 09:30
        上午 / 下午 / 晚上       -> 09:00 / 14:00 / 19:00
        空 / 认不出来            -> default
    """
    if value is None:
        return default
    if isinstance(value, (int, float)):                 # 9 -> "09:00"
        h = int(value)
        return f"{h % 24:02d}:00" if 0 <= h <= 23 else default
    s = str(value).strip()
    if not s:
        return default

    low = s.lower()
    for kw, hhmm in _PERIOD_DEFAULTS:
        if kw in low:
            # 「下午3点」「早上7点半」这类：时段词后面还有具体钟点，以钟点为准，按段换算。
            # ★ 「半」必须单独认 —— 只匹配 \d 的话「7点半」会被当成「7点」，
            #   变成 07:00 而不是 07:30（实测踩到）。
            m = re.search(r"(\d{1,2})\s*(?:[:：]\s*(\d{1,2})|点\s*(半|\d{1,2})?|时)", low)
            if m:
                h = int(m.group(1))
                if m.group(2):
                    mi = int(m.group(2))
                elif m.group(3) == "半":
                    mi = 30
                else:
                    mi = int(m.group(3)) if m.group(3) else 0
                if h < 12 and kw in ("下午", "傍晚", "晚上", "夜里"):
                    h += 12
                # 「中午12点」「凌晨12点」这类跨段修正
                if kw in ("下午", "傍晚", "晚上", "夜里") and h == 12:
                    h = 12
                if 0 <= h <= 23 and 0 <= mi <= 59:
                    return f"{h:02d}:{mi:02d}"
            return hhmm

    for pat, kind in _TIME_PATTERNS:
        m = pat.match(low)
        if m:
            h = int(m.group(1))
            if kind == "half":
                mi = 30
            else:
                mi = int(m.group(2)) if (m.lastindex or 0) >= 2 and m.group(2) else 0
            if 0 <= h <= 23 and 0 <= mi <= 59:
                return f"{h:02d}:{mi:02d}"
    return default


class Travelers(BaseModel):
    """同行人构成：决定行程松紧度与无障碍需求。"""

    adults: int = Field(default=1, ge=0, description="成人人数")
    children: int = Field(default=0, ge=0, description="儿童人数（0 表示无）")
    elderly: int = Field(default=0, ge=0, description="老人人数（0 表示无）")

    @property
    def total(self) -> int:
        """同行总人数。"""
        return self.adults + self.children + self.elderly


class UserPreference(BaseModel):
    """用户画像输入模型。

    覆盖需求文档要求的全部采集维度：
    基础信息 / 画像特征 / 预算偏好 / 禁忌避雷 / 时间约束。
    """

    # ---- 基础信息 ----
    travelers: Travelers = Field(default_factory=Travelers, description="出游人数构成")
    duration_days: int = Field(default=1, ge=1, le=30, description="游玩天数")
    origin: str = Field(default="", description="出发地（如：上海）")
    destination: str = Field(default="杭州", description="目的地城市（规划的目标城市）")
    transportation: Literal["自驾", "高铁", "飞机", "本地"] = Field(
        default="本地", description="往返交通方式"
    )

    # ---- 画像特征 ----
    preferences: List[str] = Field(
        default_factory=list,
        description="兴趣导向：人文历史 / 自然风光 / 美食 / 娱乐",
    )
    must_visit: List[str] = Field(
        default_factory=list,
        description="特别想去的景点（规划中必须包含，如：雷峰塔、西湖）",
    )
    pace: Literal["悠闲", "适中", "特种兵"] = Field(default="适中", description="游玩节奏")
    has_pet: bool = Field(default=False, description="是否携带宠物")

    # ---- 预算与偏好 ----
    budget: float = Field(default=1000, gt=0, description="总预算（元）")
    priority: Literal["吃", "住", "行", "玩"] = Field(
        default="玩", description="吃玩住行中最重视的方面"
    )

    # ---- 禁忌与避雷 ----
    dietary_restrictions: List[str] = Field(
        default_factory=list, description="饮食禁忌：过敏 / 清真 / 素食 / 无海鲜 等"
    )
    avoidances: List[str] = Field(
        default_factory=list, description="极其讨厌的项目：爬山 / 排队 / 网红打卡 等"
    )

    # ---- 时间约束 ----
    start_date: str = Field(default="", description="出行起始日期 YYYY-MM-DD")
    departure_time: str = Field(default="09:00", description="每天期望出发时间 HH:MM")
    return_hotel_time: str = Field(default="21:00", description="每天期望回酒店时间 HH:MM")

    @field_validator("departure_time", mode="before")
    @classmethod
    def _v_departure(cls, v: Any) -> str:
        """统一收敛成 "HH:MM"。见 norm_hhmm 的说明 —— 不收敛会 500。"""
        return norm_hhmm(v, "09:00")

    @field_validator("return_hotel_time", mode="before")
    @classmethod
    def _v_return(cls, v: Any) -> str:
        return norm_hhmm(v, "21:00")
