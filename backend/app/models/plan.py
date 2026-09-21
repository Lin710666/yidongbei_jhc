"""旅游规划输出模型（对应需求文档「模块3：智能规划生成」的输出结构）。

包含时间轴、交通接驳、实时天气、备选方案（Plan B）、预算明细等字段。
"""
from typing import Any, List, Literal, Optional

from pydantic import BaseModel, Field


class Location(BaseModel):
    """经纬度坐标，供前端地图打点使用。"""

    lat: float = Field(description="纬度")
    lng: float = Field(description="经度")


class POI(BaseModel):
    """兴趣点：景点 / 餐厅 / 住宿 / 交通节点等。"""

    name: str = Field(description="名称")
    type: Literal["景点", "餐厅", "住宿", "交通", "购物"] = Field(
        default="景点", description="POI 类型"
    )
    location: Location = Field(description="坐标")
    city: str = Field(default="", description="所在城市（用于点评/美团精准跳转）")
    tier: str = Field(default="", description="价位档：经济/中档/高档（餐饮/酒店推荐用）")
    description: str = Field(default="", description="简介")
    tips: str = Field(default="", description="游玩贴士 / 避坑提醒")
    price: Optional[float] = Field(default=None, description="参考消费/票价（元，来自 API 动态获取）")
    check_in: str = Field(default="", description="入住时间（住宿类，如 14:00，行业通行惯例，以酒店实际为准）")
    check_out: str = Field(default="", description="退房时间（住宿类，如 12:00，行业通行惯例，以酒店实际为准）")


class TransportToNext(BaseModel):
    """相邻两个 POI 之间的交通接驳建议。"""

    mode: str = Field(description="交通方式：步行 / 地铁 / 公交 / 打车")
    duration: str = Field(description="预计耗时，如 15分钟")
    cost: float = Field(default=0, description="预计费用（元）")


class Weather(BaseModel):
    """当日天气（用于实时调整与 Plan B）。"""

    condition: str = Field(description="天气状况：晴 / 阴 / 雨 等")
    temp: str = Field(description="温度区间，如 22-28℃")


class TimelineItem(BaseModel):
    """时间轴上的单个节点。"""

    time: str = Field(description="时间区间，如 09:00-11:30")
    poi: POI = Field(description="该时段前往的 POI")
    tips: str = Field(default="", description="该节点的游玩贴士")
    transport_to_next: Optional[TransportToNext] = Field(
        default=None, description="前往下一个节点的交通建议（末节点为空）"
    )


class DailyPlan(BaseModel):
    """单日计划。"""

    date: str = Field(description="日期 YYYY-MM-DD")
    weather: Weather = Field(description="当日天气")
    timeline: List[TimelineItem] = Field(description="当日时间轴")
    plan_b: str = Field(default="", description="备选方案（下雨/排队时的室内替代）")
    tips: List[str] = Field(default_factory=list, description="当日游玩贴士与避坑指南（来自本地 RAG）")
    hotel: Optional[POI] = Field(default=None, description="当日住宿酒店（末天为退房/返程，仍显示当晚酒店）")


class BudgetBreakdown(BaseModel):
    """预算明细，将总预算拆解到各支出项。"""

    transport: float = Field(default=0, description="交通")
    tickets: float = Field(default=0, description="门票")
    dining: float = Field(default=0, description="餐饮")
    hotel: float = Field(default=0, description="住宿")


class Conflict(BaseModel):
    """需求矛盾检测结果（供前端给用户选择是否采纳建议）。

    设计原则：系统只「检测 + 建议」，不擅自替用户修改画像。
    例如「老人 + 特种兵」会给出建议，但用户仍可坚持特种兵。
    """

    id: str = Field(description="冲突类型标识")
    message: str = Field(description="冲突提示语")
    suggestion: str = Field(description="调整建议")
    field: Optional[str] = Field(default=None, description="可自动调整的字段名（None 表示仅提示）")
    suggested_value: Optional[Any] = Field(default=None, description="建议值")


class TravelPlan(BaseModel):
    """旅游规划输出模型（顶层）。"""

    plan_id: str = Field(description="规划唯一 ID")
    summary: str = Field(description="规划摘要，如：杭州3日悠闲人文游")
    total_budget_estimate: float = Field(description="总预算估算（元）")
    budget_breakdown: BudgetBreakdown = Field(description="预算明细")
    daily_plans: List[DailyPlan] = Field(description="逐日计划")
    dining_options: List[POI] = Field(default_factory=list, description="餐饮推荐（按价位分档）")
    hotel_options: List[POI] = Field(default_factory=list, description="酒店推荐（按评分分档）")
    attraction_options: List[POI] = Field(default_factory=list, description="景点备选池（供用户编辑时换景点）")
    travelers: int = Field(default=1, description="出行人数（供前端预算实时重算）")
    user_budget: Optional[float] = Field(default=None, description="用户输入的总预算（用于结余/超出对比）")
    warnings: List[str] = Field(default_factory=list, description="异常拦截提示（加分项）")
    conflicts: List[Conflict] = Field(default_factory=list, description="需求矛盾检测结果（用户可选择是否采纳建议）")
