"""旅游规划输出模型（对应需求文档「模块3：智能规划生成」的输出结构）。

包含时间轴、交通接驳、实时天气、备选方案（Plan B）、预算明细等字段。
"""
from typing import List, Literal, Optional

from pydantic import BaseModel, Field

from .preference import UserPreference


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
    rating: Optional[float] = Field(default=None, description="高德评分（0-5，用于口碑/热度排序）")
    check_in: str = Field(default="", description="入住时间（住宿类，如 14:00，行业通行惯例，以酒店实际为准）")
    check_out: str = Field(default="", description="退房时间（住宿类，如 12:00，行业通行惯例，以酒店实际为准）")
    # 高德 POI 检索会带图片（store.is.autonavi.com/showpic/...），
    # 供地图悬停卡片展示。旧数据没有这个字段，默认空列表。
    photos: List[str] = Field(default_factory=list, description="POI 图片 URL（已统一为 https）")
    # 下面两个字段以前没存，白白浪费了高德已经给我们的信息：
    #   open_time：营业时间（如 10:00-22:00）。实测 25/25 家餐厅都有，
    #              而我们曾把晚餐排在 17:30，那家店的营业时间是 10:30-17:30——
    #              正好在关门那一刻开始吃。存下来才能校验。
    #   tags：招牌菜与标签（高德 keytag + atag）。实测 19/20 家餐厅都有，
    #         例如"辣炒螃蟹、海肠捞饭、老平潭洋烧排、大排档"。
    #         它既能给用户看，也能用来**统计出这座城市的本地特色**（零人工）。
    open_time: str = Field(default="", description="营业时间，如 10:00-22:00（可空）")
    tags: List[str] = Field(default_factory=list, description="招牌菜/标签（来自高德 keytag + atag）")
    cuisine: str = Field(default="", description="菜系（高德 type 的第三级，如 海鲜酒楼）")


class TransportToNext(BaseModel):
    """相邻两个 POI 之间的交通接驳建议。"""

    mode: str = Field(description="交通方式：步行 / 地铁 / 公交 / 打车")
    duration: str = Field(description="预计耗时，如 15分钟")
    cost: float = Field(default=0, description="预计费用（元）")
    # 高德驾车路线返回的真实里程（公里）。步行段用直线距离。
    #
    # 为什么单独存它：体检原先只用直线距离（haversine）算当天总里程，
    # 在平潭这种海湾半岛地形会严重低估——实测直线上报 30.3 公里、
    # 实际驾车 48.8 公里，有 18.5 公里被藏起来了。
    # 而这个字段的路线请求本来就发了，只是之前只取耗时和费用、把里程丢掉。
    distance_km: float = Field(default=0, description="该段真实里程（公里）")


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


class CheckIssue(BaseModel):
    """规划体检（CheckSkill）发现的一条问题。

    设计原则：只报告、不返工。系统发现问题后明确告诉用户，
    而不是在后台悄悄重排——用户有权知道系统改了什么、为什么改。
    """

    category: str = Field(
        description="问题类型：地点真实性 / 地点 / 路径 / 重复 / 覆盖 / 时间 / 预算 / 其他"
    )
    severity: Literal["high", "medium", "low"] = Field(default="medium", description="严重程度")
    message: str = Field(description="问题描述")
    suggestion: str = Field(default="", description="给用户的修改建议")


class PlanCheck(BaseModel):
    """规划体检结果（由大模型二次审查 + 系统规则校验汇总）。"""

    passed: bool = Field(description="是否未发现明显问题")
    summary: str = Field(default="", description="体检结论一句话")
    issues: List[CheckIssue] = Field(default_factory=list, description="发现的问题清单")


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
    checks: Optional[PlanCheck] = Field(default=None, description="规划体检结果（CheckSkill）")
    # 生成这份规划时用的画像：随规划一起返回并入库，用户不满意时可以直接在此基础上
    # 用对话提新要求（"把第二天换成室内""预算压到 2500"），不用重新填表
    user_preference: Optional[UserPreference] = Field(
        default=None, description="生成该规划时的用户画像（用于对话式修改）"
    )
    # 往返大交通的估算口径说明：把"机票/高铁票未计入真实票价"这件事显示在预算栏
    transport_note: str = Field(default="", description="往返大交通估算口径说明")
