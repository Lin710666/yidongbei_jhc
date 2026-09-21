"""高德开放平台客户端（真实 API 调用）。

提供能力：
- search_poi   ：关键词搜索 POI（景点/餐厅/商场等）
- get_weather  ：天气查询（逐日预报）
- get_route    ：路线规划（步行 / 驾车 / 公交），含距离、耗时、打车费用

使用前需在 .env 配置 AMAP_API_KEY（高德开放平台免费申请：https://console.amap.com/）。
"""
from typing import Any, Dict, List, Optional

import threading
import time

import httpx

from ..config import settings

BASE_URL = "https://restapi.amap.com/v3"

# ---- 简单限流：个人开发者免费额度 QPS 较低，避免触发 CUQPS_HAS_EXCEEDED_THE_LIMIT ----
_MIN_INTERVAL = 0.4  # 秒；约 2.5 QPS，低于免费额度常见 3 QPS
_throttle_lock = threading.Lock()
_last_call_at = 0.0


def _throttle() -> None:
    """确保相邻两次高德请求至少间隔 _MIN_INTERVAL 秒。"""
    global _last_call_at
    with _throttle_lock:
        now = time.monotonic()
        wait = _MIN_INTERVAL - (now - _last_call_at)
        if wait > 0:
            time.sleep(wait)
        _last_call_at = time.monotonic()


class AmapError(Exception):
    """高德接口调用异常（未配 key / 网络异常 / 业务错误）。"""


class AmapClient:
    """高德开放平台 REST API 客户端。"""

    def __init__(self, key: Optional[str] = None, timeout: float = 10.0):
        self.key = key or settings.amap_api_key
        self.timeout = timeout

    def _get(self, path: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """发起 GET 请求并统一处理错误，返回业务数据。"""
        if not self.key:
            raise AmapError("未配置 AMAP_API_KEY，请在 .env 中填写高德开放平台密钥")
        params = {**params, "key": self.key}
        _throttle()
        try:
            resp = httpx.get(f"{BASE_URL}{path}", params=params, timeout=self.timeout)
            resp.raise_for_status()
        except httpx.HTTPError as exc:  # 网络异常兜底
            raise AmapError(f"高德接口网络异常：{exc}") from exc

        data = resp.json()
        if data.get("status") != "1":
            raise AmapError(f"高德接口返回错误：{data.get('info', '未知错误')}")
        return data

    def search_poi(
        self, keywords: str, city: str, types: Optional[str] = None, offset: int = 20
    ) -> List[Dict[str, Any]]:
        """关键词搜索 POI。"""
        params: Dict[str, Any] = {"keywords": keywords, "city": city, "offset": offset}
        if types:
            params["types"] = types
        data = self._get("/place/text", params)
        return data.get("pois", [])

    def get_weather(self, city: str, extensions: str = "all") -> Dict[str, Any]:
        """逐日天气查询。extensions="all" 返回多日预报。"""
        return self._get("/weather/weatherInfo", {"city": city, "extensions": extensions})

    def get_route(
        self, origin: str, destination: str, mode: str = "walking"
    ) -> Dict[str, Any]:
        """路线规划。origin/destination 形如 "lng,lat"。

        mode: walking(步行) / driving(驾车) / transit(公交)。
        驾车结果含 taxi_cost（打车费用，元）。
        """
        path_map = {
            "walking": "/direction/walking",
            "driving": "/direction/driving",
            "transit": "/direction/transit/integrated",
        }
        if mode not in path_map:
            raise AmapError(f"不支持的出行方式：{mode}")
        return self._get(
            path_map[mode], {"origin": origin, "destination": destination}
        )


#: 模块级默认客户端（便于各 Skill 复用）
default_client = AmapClient()
