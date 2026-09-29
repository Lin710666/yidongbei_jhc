"""LLM 客户端：Ollama 本地推理。

需求文档要求「支持本地部署」，因此默认用 Ollama 运行本地开源模型，数据不出机器。

失败处理（与用户对齐）：不再静默降级到规则引擎——chat_json 返回 None，
并把失败原因记录在 last_error 里，由上层抛出带原因的明确提示（超时 / 非 JSON / 网络错误）。
"""
import json
from typing import Any, Dict, Optional

import httpx

from ..config import settings
from ..http_local import trust_env_for


class LLMClient:
    """Ollama 本地大模型客户端。"""

    def __init__(self) -> None:
        self.base_url = settings.ollama_base_url
        self.model = settings.ollama_model
        self.timeout = settings.ollama_timeout
        # Ollama 默认在本机：本机请求必须绕过系统代理（见 http_local 的说明）
        self._trust_env = trust_env_for(self.base_url)
        #: 最近一次调用的失败原因，供上层拼进用户提示
        self.last_error: str = ""

    def available(self) -> bool:
        """探测 Ollama 服务是否可用。"""
        try:
            resp = httpx.get(
                f"{self.base_url}/api/tags", timeout=2.0, trust_env=self._trust_env
            )
            return resp.status_code == 200
        except httpx.HTTPError:
            return False

    def prefill(
        self, system: str, user: str = "预热。", model: Optional[str] = None
    ) -> bool:
        """把一段系统提示词预先填进模型上下文缓存（不取值、不解析 JSON）。

        供启动预热使用（见 llm/warmup.py）。Ollama 的上下文缓存按前缀命中，
        因此只要系统提示词与真实调用逐字一致，后续请求就能跳过这段预填充——
        实测 788 token 的系统提示词由此从 19.0s 降到 0.7s。

        所以这里只要请求成功就达到目的；num_predict=1 把生成开销压到可忽略，
        也刻意不带 format="json"（不需要约束输出，省掉语法开销）。
        注意 num_ctx 必须与真实调用一致，否则上下文缓存对不上。
        """
        self.last_error = ""
        payload = {
            "model": model or self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "keep_alive": settings.ollama_keep_alive,
            "options": {"num_predict": 1, "num_ctx": 4096},
        }
        try:
            resp = httpx.post(
                f"{self.base_url}/api/chat",
                json=payload,
                timeout=self.timeout,
                trust_env=self._trust_env,
            )
            resp.raise_for_status()
            return True
        except httpx.HTTPError as exc:
            self.last_error = f"预热请求失败（{exc}）"
            return False

    def chat_json(
        self,
        system: str,
        user: str,
        options: Optional[Dict[str, Any]] = None,
        timeout: Optional[float] = None,
        model: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        """调用 Ollama 生成结构化 JSON。

        Args:
            system: 系统提示词（约束输出结构）。
            user: 用户输入。
            options: Ollama 采样参数（如温度、最大生成长度）。
            timeout: 本次调用的超时秒数，缺省用配置里的 OLLAMA_TIMEOUT。
            model: 本次使用的模型名，缺省用配置里的 OLLAMA_MODEL
                   （规划体检可以换个更小的模型来提速）。
        Returns:
            解析后的 JSON 字典；失败返回 None 并写入 last_error（由上层提示用户）。
        """
        self.last_error = ""
        wait = timeout or self.timeout
        payload: Dict[str, Any] = {
            "model": model or self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "format": "json",  # 强制 Ollama 输出合法 JSON
            "stream": False,
            # 让模型在一段时间内常驻内存：一次生成要调 2~3 次大模型，
            # 不保持常驻的话两次调用之间模型会被卸载，又要重新加载（几十秒冷启动）
            "keep_alive": settings.ollama_keep_alive,
        }
        if options:
            payload["options"] = options
        try:
            resp = httpx.post(
                f"{self.base_url}/api/chat",
                json=payload,
                timeout=wait,
                trust_env=self._trust_env,
            )
            resp.raise_for_status()
            content = resp.json()["message"]["content"]
            return json.loads(content)
        except httpx.TimeoutException:
            self.last_error = f"调用大模型超时（超过 {wait:.0f} 秒）"
            return None
        except httpx.HTTPError as exc:
            self.last_error = f"调用大模型失败（{exc}）"
            return None
        except (KeyError, json.JSONDecodeError, ValueError) as exc:
            self.last_error = f"大模型返回的内容不是合法 JSON（{exc}）"
            return None
