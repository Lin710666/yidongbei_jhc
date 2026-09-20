"""数据模型包：UserPreference（输入画像）与 TravelPlan（输出规划）。"""
from .preference import UserPreference, Travelers
from .plan import (
    TravelPlan,
    DailyPlan,
    TimelineItem,
    POI,
    Location,
    Weather,
    TransportToNext,
    BudgetBreakdown,
)

__all__ = [
    "UserPreference",
    "Travelers",
    "TravelPlan",
    "DailyPlan",
    "TimelineItem",
    "POI",
    "Location",
    "Weather",
    "TransportToNext",
    "BudgetBreakdown",
]
