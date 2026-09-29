"""实时攻略检索：接公开搜索 API，把「攻略摘要」喂给选点提示词。

参考的是 DeepSeek 联网搜索那种 **"搜索 + 阅读"** 的做法：
把问题变成搜索查询 → 调搜索 API → 取摘要片段 → 连同引用一起塞进模型上下文。
它用的是**搜索引擎的公开结果**，不是去爬某个 App（需要登录/反爬的站点拿不到，
而且合规上也不该这么做）。

四条底线（与用户对齐，缺一不可）：

1. **默认关闭**：没配 `SEARCH_API_MODE / SEARCH_API_URL / SEARCH_API_KEY` 就返回空列表，
   主流程照常跑——绝不让一个外部服务变成生成规划的硬依赖。
2. **只发城市名**：查询里只有目的地（如「平潭 必去 攻略」），
   **不带人数、预算、偏好这些画像信息**，这样不破坏"隐私数据不出机"的定位。
3. **实体必须能在高德找到**：摘要只作为"偏好提示"进提示词；模型据此挑出来的名字
   仍要映射回高德候选池，映射不上的一律丢掉（planner 已经这么做了）。
   这样"攻略写错"和"模型幻觉"都不会变成行程里一个不存在的地方。
4. **失败不影响生成**：超时、限流、返回格式不对，只记日志、返回空列表。
"""
import logging
from typing import Any, Dict, List, Optional

import httpx

from ..config import settings

logger = logging.getLogger("travelplanner.search")


class WebSearchClient:
    """公开搜索 API 的薄封装。支持两种常见的响应结构，换服务商只是加一个分支。"""

    def __init__(
        self,
        mode: Optional[str] = None,
        url: Optional[str] = None,
        key: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> None:
        self.mode = (mode if mode is not None else settings.search_api_mode).strip().lower()
        self.url = url if url is not None else settings.search_api_url
        self.key = key if key is not None else settings.search_api_key
        self.timeout = timeout if timeout is not None else settings.search_timeout

    @property
    def enabled(self) -> bool:
        """三项都配齐才启用。"""
        return bool(self.mode and self.url and self.key)

    def search(self, query: str, limit: int = 8) -> List[str]:
        """返回若干条攻略摘要（标题 + 摘要）。任何失败都返回空列表。"""
        text = (query or "").strip()
        if not self.enabled or not text:
            return []
        try:
            payload = self._request(text, limit)
            return self._extract(payload, limit)
        except Exception as exc:  # 网络、超时、JSON 结构不对——一律不阻断生成
            logger.warning("攻略检索失败（不影响生成）：%s", exc)
            return []

    def _request(self, query: str, limit: int) -> Dict[str, Any]:
        if self.mode == "serper":
            resp = httpx.post(
                self.url,
                json={"q": query, "num": limit},
                headers={"X-API-KEY": self.key, "Content-Type": "application/json"},
                timeout=self.timeout,
            )
        elif self.mode == "bocha":
            resp = httpx.post(
                self.url,
                json={"query": query, "count": limit, "summary": True},
                headers={
                    "Authorization": f"Bearer {self.key}",
                    "Content-Type": "application/json",
                },
                timeout=self.timeout,
            )
        else:
            resp = httpx.get(
                self.url,
                params={"q": query, "count": limit},
                headers={"Authorization": f"Bearer {self.key}"},
                timeout=self.timeout,
            )
        resp.raise_for_status()
        return resp.json()

    @staticmethod
    def _extract(payload: Dict[str, Any], limit: int) -> List[str]:
        """从两种常见结构里取出「标题：摘要」。取不到就返回空。"""
        items: List[Dict[str, Any]] = []
        if isinstance(payload.get("organic"), list):          # serper 风格
            items = payload["organic"]
        elif isinstance(payload.get("data"), dict):            # 博查风格
            pages = payload["data"].get("webPages")
            if isinstance(pages, dict) and isinstance(pages.get("value"), list):
                items = pages["value"]
        out: List[str] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title") or item.get("name") or "").strip()
            snippet = str(item.get("snippet") or item.get("summary") or "").strip()
            text = f"{title}：{snippet}" if title and snippet else (title or snippet)
            if text:
                out.append(text[:200])
            if len(out) >= limit:
                break
        return out
