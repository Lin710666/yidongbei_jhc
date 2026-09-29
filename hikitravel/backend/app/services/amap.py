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

#: 输入提示缓存：用户边打边查会反复请求同一前缀，短 TTL 缓存既省额度又更快。
#: key = "city|关键词"，value = (写入时刻, 候选列表)
_TIPS_TTL = 120.0
_TIPS_CACHE_MAX = 500
_tips_cache: Dict[str, Any] = {}

#: 路线缓存：同一条路线在一次生成里会被查好几遍
#: （选餐厅时评估一次、建时间轴时再查一次、体检时又可能用上），
#: 缓存下来既省钱又省时间，也直接降低了"真实路程精排"那一步的成本。
_ROUTE_TTL = 600.0
_ROUTE_CACHE_MAX = 800
_route_cache: Dict[str, Any] = {}


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


class AmapDestinationError(AmapError):
    """目的地无法被高德识别（属于用户输入问题，不是服务故障）。"""


#: 高德常见错误码 -> 给用户看的处理建议（原样抛 code 用户看不懂）
_AMAP_ERROR_HINTS = {
    "CUQPS_HAS_EXCEEDED_THE_LIMIT": "请求过于频繁，稍等一会儿再试（免费额度 QPS 较低）",
    "DAILY_QUERY_OVER_LIMIT": "今日调用量已达上限，请明天再试，或更换高德 Key",
    "INVALID_USER_KEY": "Key 无效，请检查 backend/.env 里的 AMAP_API_KEY",
    "USER_KEY_RECYCLED": "Key 已被回收，请到高德控制台重新申请",
    "SERVICE_NOT_AVAILABLE": "高德该服务暂时不可用，请稍后重试",
    "INVALID_PARAMS": "请求参数有误，请确认目的地等填写正确",
}


class AmapClient:
    """高德开放平台 REST API 客户端。"""

    def __init__(self, key: Optional[str] = None, timeout: float = 10.0):
        self.key = key or settings.amap_api_key
        self.timeout = timeout
        # 同一个进程内缓存接口结果：一次规划会反复算同一段路线（例如超时压缩后重算），
        # 命中缓存可以省掉限流等待与网络往返。POI / 路线在同一次演示里变化极小，
        # 上限 500 条、超出按最早写入淘汰。
        self._cache: Dict[tuple, Dict[str, Any]] = {}
        self._cache_lock = threading.Lock()

    def _get(self, path: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """发起 GET 请求并统一处理错误，返回业务数据。"""
        if not self.key:
            raise AmapError("未配置 AMAP_API_KEY，请在 .env 中填写高德开放平台密钥")
        cache_key = (
            path,
            tuple(sorted((k, str(v)) for k, v in params.items() if k != "key")),
        )
        with self._cache_lock:
            cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        params = {**params, "key": self.key}
        _throttle()
        try:
            resp = httpx.get(f"{BASE_URL}{path}", params=params, timeout=self.timeout)
            resp.raise_for_status()
        except httpx.HTTPError as exc:  # 网络异常兜底
            raise AmapError(f"高德接口网络异常：{exc}") from exc

        data = resp.json()
        if data.get("status") != "1":
            info = data.get("info", "未知错误")
            hint = _AMAP_ERROR_HINTS.get(info)
            raise AmapError(
                f"高德接口返回错误：{info}" + (f"（{hint}）" if hint else "")
            )
        with self._cache_lock:
            if len(self._cache) >= 500:
                self._cache.pop(next(iter(self._cache)))
            self._cache[cache_key] = data
        return data

    def search_poi(
        self,
        keywords: Optional[str] = None,
        city: Optional[str] = None,
        types: Optional[str] = None,
        offset: int = 20,
        page: int = 1,
    ) -> List[Dict[str, Any]]:
        """关键词 / 分类码搜索 POI。

        keywords 与 types 二选一（高德规定至少传其一）：
        - 传 keywords：按关键词搜索（可搭配 city 限定城市）。
        - 传 types：按 POI 分类码搜索（如 "110200" 风景名胜，多个用 | 分割）。
        offset 单页最多 25 条；需要更多结果时用 page 翻页（1 起）。
        """
        params: Dict[str, Any] = {"offset": offset, "page": page}
        if keywords:
            params["keywords"] = keywords
        if city:
            params["city"] = city
        if types:
            params["types"] = types
        data = self._get("/place/text", params)
        return data.get("pois", [])

    def resolve_region(self, destination: str, adcode: str = "") -> tuple[str, str]:
        """把目的地解析为 (区县名 adname, 城市名 cityname)。

        **不做静默兜底**：解析不出就抛 AmapError，让用户确认目的地，
        而不是拿一个猜出来的名字继续搜（那样会搜出全国结果，
        例如把「不存在的地名」当 city 传进去，高德会静默忽略该参数）。

        策略：
        0. 前端从下拉里选过地点时会带 adcode——那是高德的主键，
           直接按它解析，不做任何字符串猜测（连「平潭县 / 平潭镇」这类
           同名歧义都不存在了，用户选的是哪一个就是哪一个）；
        1. 先用行政区查询接口（/config/district）做规范化解析——
           命中「省 / 市」级保留城市粒度，避免「杭州」被缩到某个区；
           命中「区县 / 街道」级用区县名做 POI 搜索范围（更聚焦）；
        2. 都拿不到就**明确拒绝**，让用户改用下拉候选，绝不猜。

        这里曾经加过一层「POI 检索兜底」：行政区查不到时用 /place/text
        的结果反推 adname/cityname，想救回「福建平潭」这类写法。
        用固定用例实测后撤掉了——它把正确率从 68% 抬到 86%，
        代价是引入了**静默给出错误城市**：`福建福州` 被解析成南京市鼓楼区，
        用户会拿到一份完全无关城市的行程，而且全程没有任何异常提示。
        对一个「整份行程都建立在目的地之上」的产品，
        给错城比拒绝严重得多：拒绝用户能立刻改，给错城要等行程生成完才发现。
        而且它连「省 + 市」这类本该帮忙的情况都没救回来（福州/杭州/深圳全错）。

        「写法不标准」的正解放在输入端：前端下拉直接给出高德侧的实时候选
        （含 adcode），用户点一下即确认，比后端猜字符串可靠。
        回归用例见 scripts/check_destination.py。
        """
        target = (destination or "").strip()
        code = (adcode or "").strip()
        if not target and not code:
            raise AmapDestinationError("目的地为空，无法检索。")

        # 0. 用户在下拉里选定了具体地点：adcode 优先，绕开一切字符串歧义
        if code:
            matched_by_code = self._lookup_district(code)
            if matched_by_code:
                name = (matched_by_code.get("name") or "").strip()
                if name:
                    if matched_by_code.get("level") in ("province", "city"):
                        return name, name
                    parent = self._city_of(name) or name
                    # 用户填的就是父级城市（「杭州」/「杭州市」），而下拉那条候选的 adcode
                    # 恰好是某个区时，不能把整趟行程缩进那个区。
                    # 实测踩过：目的地「杭州市 + 330102（上城区）」→ 检索范围被缩成上城区，
                    # 池子里全是上城区的点，而必去景点「青山湖景区」（临安区）在区县范围内
                    # 搜不到 → 退化成没有图、没有评分的占位点。
                    # 反过来，用户明确选的是区（「上城区」）时照旧保留区级范围。
                    if parent and (parent == target or (target and target in parent)):
                        return parent, parent
                    return name, parent
            # adcode 失效（例如行政区划调整过）就继续按名字走，不让用户卡住

        if not target:
            raise AmapDestinationError("目的地为空，无法检索。")

        matched = self._lookup_district(target)
        if matched:
            name = (matched.get("name") or "").strip()
            if name:
                # 省级 / 市级：直接保留，城市名即检索范围
                if matched.get("level") in ("province", "city"):
                    return name, name
                # 区县 / 街道级：区县名用于 POI 搜索，城市名用于天气与知识库
                return name, self._city_of(name) or name

        raise AmapDestinationError(
            f"无法识别目的地「{target}」。请确认名称，"
            "建议填写城市名（例如「杭州」「厦门」）；"
            "也可以只输入「平潭」这样的关键词，再从输入框的下拉候选里选中具体的地方。"
        )

    def input_tips(self, keywords: str, city: str = "") -> List[Dict[str, Any]]:
        """输入提示（自动补全）：候选含 name / district / adcode / location。

        供前端的「目的地」下拉使用。由后端代理而不是前端直连高德，
        是因为 Key 一旦落到浏览器就等于公开，任何人都能拿去刷我们的额度。
        """
        q = (keywords or "").strip()
        if not q:
            return []

        cache_key = f"{city}|{q}"
        cached = _tips_cache.get(cache_key)
        if cached and (time.monotonic() - cached[0]) < _TIPS_TTL:
            return cached[1]

        params: Dict[str, Any] = {"keywords": q, "datatype": "all"}
        if city:
            params["city"] = city
        tips = self._get("/assistant/inputtips", params).get("tips") or []

        if len(_tips_cache) >= _TIPS_CACHE_MAX:
            _tips_cache.clear()
        _tips_cache[cache_key] = (time.monotonic(), tips)
        return tips

    def _lookup_district(self, keywords: str) -> Optional[Dict[str, Any]]:
        """行政区查询：返回命中的第一条，没有则 None。

        keywords 既可以是名称，也可以是 citycode / adcode（高德支持）。
        """
        data = self._get(
            "/config/district", {"keywords": keywords, "subdistrict": "0"}
        )
        districts = data.get("districts") or []
        return districts[0] if districts else None

    def _city_of(self, adname: str) -> str:
        """用行政区名反查所属城市（天气与本地知识库需要城市名）。"""
        try:
            hits = self._get(
                "/place/text", {"keywords": adname, "city": adname, "offset": "1"}
            ).get("pois", [])
            return (hits[0].get("cityname") or "") if hits else ""
        except AmapError:
            return ""

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
        # 同一段路线在一次生成里会被查好几遍（选餐厅评估一次、建时间轴再查一次），
        # 缓存下来省时省钱，也顺带压低了「真实路程精排」那一步的成本。
        cache_key = f"{mode}|{origin}|{destination}"
        hit = _route_cache.get(cache_key)
        if hit and (time.monotonic() - hit[0]) < _ROUTE_TTL:
            return hit[1]
        data = self._get(
            path_map[mode], {"origin": origin, "destination": destination}
        )
        if len(_route_cache) >= _ROUTE_CACHE_MAX:
            _route_cache.clear()
        _route_cache[cache_key] = (time.monotonic(), data)
        return data

    def static_map(
        self,
        markers: str = "",
        paths: str = "",
        center: str = "",
        zoom: int = 12,
        size: str = "800*520",
        scale: int = 1,
    ) -> bytes:
        """高德静态地图：服务端渲染好的**真实地图图片**（带底图、路网、标记与轨迹）。

        用的是 Web 服务 Key —— 不需要另申请「Web端(JS API)」Key，也不会把 Key 暴露到浏览器
        （浏览器只请求我们后端，由后端带 Key 去取图）。

        参数格式（高德规范）：
        - markers: "mid,0xFF0000,A:lng,lat;lng,lat|mid,0x1677FF,B:lng,lat"
        - paths:   "5,0x1677FF,0.9,0x000000,0:lng,lat;lng,lat|..."
        """
        if not self.key:
            raise AmapError("未配置 AMAP_API_KEY，无法获取地图。")
        params: Dict[str, Any] = {"size": size, "scale": str(scale), "key": self.key}
        if center:
            params["location"] = center
        if zoom:
            params["zoom"] = str(zoom)
        if markers:
            params["markers"] = markers
        if paths:
            params["paths"] = paths
        _throttle()
        try:
            resp = httpx.get(f"{BASE_URL}/staticmap", params=params, timeout=self.timeout)
            resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise AmapError(f"获取静态地图失败：{exc}") from exc
        content_type = resp.headers.get("content-type", "")
        if not content_type.startswith("image"):
            # 出错时高德返回 JSON（status=0 + info），翻译成中文提示
            info = "未知错误"
            try:
                info = resp.json().get("info", info)
            except ValueError:
                info = resp.text[:100]
            hint = _AMAP_ERROR_HINTS.get(info)
            raise AmapError(
                f"获取静态地图失败：{info}" + (f"（{hint}）" if hint else "")
            )
        return resp.content
