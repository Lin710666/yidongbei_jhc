"""用户画像输入模型（对应需求文档「模块1：用户意图识别与信息采集」）。

这是整个系统的输入层数据结构，由意图识别 Skill 从对话/表单中提取。
前端有同名 TypeScript 接口与之对齐，保证前后端字段一致。
"""
from typing import List, Literal, Optional

from pydantic import BaseModel, Field


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
