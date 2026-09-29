"""数据模型包。

- preference : UserPreference / Travelers（输入画像）
- plan       : TravelPlan / DailyPlan / TimelineItem / POI 等（输出规划）

各模块按需直接 `from .models.preference import UserPreference` 导入即可，
这里不做再导出，避免出现"多个入口"的隐式依赖。
"""
