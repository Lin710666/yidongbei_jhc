"""天气服务：封装高德天气接口，返回结构化逐日天气。

用于「实时动态与备选方案」——规划生成时若某日为雨天，自动替换室内景点。
"""
from typing import Dict

from ..models.plan import Weather
from .amap import AmapClient, AmapError


class WeatherService:
    """天气查询服务。"""

    def __init__(self, client: AmapClient | None = None):
        self.client = client or AmapClient()

    def forecast(self, city: str, days: int = 7) -> Dict[str, Weather]:
        """查询城市未来逐日天气。

        Returns:
            {日期: Weather} 字典，日期格式 YYYY-MM-DD。
        """
        data = self.client.get_weather(city, extensions="all")
        forecasts = data.get("forecasts", [])
        result: Dict[str, Weather] = {}
        if not forecasts:
            return result

        casts = forecasts[0].get("casts", [])
        for item in casts[:days]:
            day_weather = item.get("dayweather", "")
            night_temp = item.get("nighttemp", "")
            day_temp = item.get("daytemp", "")
            result[item["date"]] = Weather(
                condition=day_weather,
                temp=f"{night_temp}-{day_temp}℃" if night_temp and day_temp else "",
            )
        return result
