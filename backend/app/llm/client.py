"""LLM 客户端：**云端优先、本地兜底**，两条通道共用一套接口。

## 为什么要有这一层

原来只有 Ollama 一条路。本机模型没启动时，所有生成直接失败 ——
用户看到的就是"点了没反应"。现在按策略选通道：

    LLM_POLICY=auto    有云端 key 就先用云端；云端超时/连不上 → 自动落到本地
    LLM_POLICY=cloud   只用云端（失败就是失败，不偷偷用本地）
    LLM_POLICY=local   只用本地（数据不出机器）

`auto` 的触发条件写得很实在：连接被拒、DNS 失败、超时、5xx ——
**"网络条件不好"就是这些**，不看什么抽象的健康度。

## 显存：别让模型互相抢占

本地这条路做了三件事（前面 ollama serve 还要配 OLLAMA_MAX_LOADED_MODELS=1）：

  1. `_GPU_LOCK`：全进程一把锁，**检索与生成串行**。
     Ollama 本身能并发跑多个模型，但在单卡上那就是互相挤显存、互相拖慢。
  2. 向量模型用完立刻卸（`keep_alive: 0`）—— 它只在小片段上用一下，
     留着占 5 分钟纯属浪费。
  3. 生成模型用较短的 keep_alive（`OLLAMA_KEEP_ALIVE`，默认 30s），
     比 Ollama 默认的 5 分钟短得多。

三条加起来的效果：同一时刻显存里只有一个大模型。
"""
import json
import socket
import threading
import time
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

import httpx

from ..config import settings

#: 本地推理串行锁。检索和生成不能同时啃显卡 —— 单卡上那不是并发，是互相抢。
_GPU_LOCK = threading.Lock()


def _tcp_open(url: str, timeout: float = 0.15) -> bool:
    """极短的 TCP 端口预检：端口没人监听就立刻返回 False。

    为什么需要它：Ollama 没启动时，httpx.get 到 11434 会**等满超时**才返回 ——
    httpx 先试 IPv4 再试 IPv6，每次连接各等一遍，实测 2 秒。
    而 /api/status 会经过两条路径各探一次，启动时白白卡 4 秒。

    超时取 0.15 秒：本机连接是瞬时的（端口开着就是亚毫秒级，
    端口关着系统会立刻回 RST）。超时只用来兜住"防火墙 DROP"这种极端情况 ——
    那种情况下 0.15 秒和 2 秒的结论一样，但前者不拖慢页面。
    """
    try:
        u = urlparse(url)
        host = u.hostname or "127.0.0.1"
        port = u.port or (443 if u.scheme == "https" else 80)
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


class LLMClient:
    """云端 / 本地双通道大模型客户端。"""

    def __init__(self) -> None:
        self.base_url = settings.ollama_base_url
        self.model = settings.ollama_model
        self.timeout = settings.ollama_timeout
        #: 云端（OpenAI 兼容）配置。key 为空表示用户没配外部服务。
        self.cloud_base = (settings.cloud_base_url or "").rstrip("/")
        self.cloud_key = settings.cloud_api_key or ""
        self.cloud_model = settings.cloud_model or ""
        self.policy = (settings.llm_policy or "auto").strip().lower()
        #: Ollama 探测结果缓存 (ok, 时间戳)。见 local_ready() 的说明。
        self._probe_cache: Optional[Tuple[bool, float]] = None

    # ------------------------------------------------------------------ 状态

    @property
    def cloud_ready(self) -> bool:
        """云端通道是否可用：三样都得有（地址 / key / 模型名）。"""
        return bool(self.cloud_base and self.cloud_key and self.cloud_model)

    def local_ready(self) -> bool:
        """探测 Ollama 服务是否可用。

        ★ 实测：Ollama 没运行时，原来这一步要等满 2 秒超时；而 /api/status
          会探两次，于是**启动时白卡 4 秒**。现在先做 0.35 秒的端口预检，
          没监听就直接返回，并加 3 秒缓存避免同一轮里重复探。
          Ollama 真在跑时行为完全不变。
        """
        cached = self._probe_cache
        if cached is not None and (time.time() - cached[1]) < 10.0:
            return cached[0]

        ok = False
        if _tcp_open(self.base_url, timeout=0.15):
            try:
                resp = httpx.get(f"{self.base_url}/api/tags", timeout=2.0)
                ok = resp.status_code == 200
            except httpx.HTTPError:
                ok = False

        self._probe_cache = (ok, time.time())
        return ok

    # 兼容旧调用点
    available = local_ready

    def status(self) -> Dict[str, Any]:
        """给 /api/status 用：说清楚现在走哪条、为什么。"""
        cloud = self.cloud_ready
        local = self.local_ready() if self.policy != "cloud" else False
        if self.policy == "cloud":
            active = "cloud" if cloud else "none"
        elif self.policy == "local":
            active = "local" if local else "none"
        else:  # auto
            active = "cloud" if cloud else ("local" if local else "none")
        return {
            "policy": self.policy,
            "active": active,
            "cloud": {"configured": cloud, "base": self.cloud_base, "model": self.cloud_model},
            "local": {"configured": local, "base": self.base_url, "model": self.model},
        }

    # ------------------------------------------------------ 云端（OpenAI 兼容）

    def _cloud(self, system: str, user: str, *, temperature: float,
               num_predict: int, timeout: float, as_json: bool) -> Optional[str]:
        body: Dict[str, Any] = {
            "model": self.cloud_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "max_tokens": num_predict,
        }
        if as_json:
            body["response_format"] = {"type": "json_object"}
        resp = httpx.post(
            f"{self.cloud_base}/chat/completions",
            headers={"Authorization": f"Bearer {self.cloud_key}"},
            json=body,
            timeout=timeout,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    # ------------------------------------------------------ 本地（Ollama）

    def _local(self, system: str, user: str, *, temperature: float,
               num_predict: int, timeout: float, as_json: bool,
               keep_alive: str) -> Optional[str]:
        body: Dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "stream": False,
            "keep_alive": keep_alive,   # ★ 用完就卸，别白占显存
            "options": {"temperature": temperature, "num_predict": num_predict},
        }
        if as_json:
            body["format"] = "json"     # 强制 Ollama 输出合法 JSON
        resp = httpx.post(f"{self.base_url}/api/chat", json=body, timeout=timeout)
        resp.raise_for_status()
        return resp.json()["message"]["content"]

    # ------------------------------------------------------------------ 调度

    def _run(self, system: str, user: str, *, temperature: float, num_predict: int,
             timeout: float, as_json: bool, keep_alive: str) -> Tuple[Optional[str], str]:
        """按策略选通道；auto 模式下云端失败**立刻**回落本地。

        返回 (内容, 实际用的通道)。内容为 None 表示两条都不通。
        """
        order = []
        if self.policy == "cloud":
            order = ["cloud"]
        elif self.policy == "local":
            order = ["local"]
        else:  # auto：云端优先，本地兜底
            order = ["cloud", "local"]

        # 显存串行：同一时刻只让一个推理在跑
        with _GPU_LOCK:
            for ch in order:
                if ch == "cloud":
                    if not self.cloud_ready:
                        continue
                    try:
                        return self._cloud(system, user, temperature=temperature,
                                           num_predict=num_predict, timeout=timeout,
                                           as_json=as_json), "cloud"
                    except (httpx.HTTPError, KeyError, ValueError, IndexError):
                        # 连不上 / 超时 / 5xx / 返回体不合预期 —— 都算"网络不好"，落到本地
                        continue
                else:
                    try:
                        return self._local(system, user, temperature=temperature,
                                           num_predict=num_predict, timeout=timeout,
                                           as_json=as_json, keep_alive=keep_alive), "local"
                    except (httpx.HTTPError, KeyError, ValueError):
                        continue
        return None, "none"

    # ------------------------------------------------------------ 对外接口

    def chat_text(self, system: str, user: str, temperature: float = 0.7,
                  num_predict: int = 2560, timeout: float = 0.0) -> Optional[str]:
        """生成自由文本（Markdown）。

        超时单独放宽：OLLAMA_TIMEOUT 默认 30 秒是给「结构化短输出」定的，
        而营销文案要一次生成 A/B 两版、系统提示词又有 20 KB 上下，
        本机 7B 模型实测会超过 30 秒 —— 沿用同一个值会稳定失败。
        """
        eff_timeout = timeout or max(float(self.timeout), 180.0)
        content, _ch = self._run(system, user, temperature=temperature,
                                 num_predict=num_predict, timeout=eff_timeout,
                                 as_json=False,
                                 keep_alive=settings.ollama_keep_alive)
        return content

    def chat_json(self, system: str, user: str) -> Optional[Dict[str, Any]]:
        """生成结构化 JSON。失败返回 None（触发上层降级到规则引擎）。"""
        content, _ch = self._run(system, user, temperature=0.2, num_predict=1024,
                                 timeout=self.timeout, as_json=True,
                                 keep_alive=settings.ollama_keep_alive)
        if not content:
            return None
        try:
            return json.loads(content)
        except (json.JSONDecodeError, ValueError):
            # 云端偶尔会包一层 ```json，兜一下
            try:
                s = content[content.find("{"): content.rfind("}") + 1]
                return json.loads(s)
            except (json.JSONDecodeError, ValueError):
                return None

    def embed(self, texts: list) -> Optional[list]:
        """向量化。用完**立刻卸载**向量模型（keep_alive=0）。

        它只在小片段上用一下，留着占 5 分钟显存纯属浪费 ——
        而这段时间正好是生成模型要显存的时候。
        """
        if not texts:
            return []
        with _GPU_LOCK:
            try:
                resp = httpx.post(
                    f"{self.base_url}/api/embed",
                    json={"model": settings.ollama_embed_model,
                          "input": texts, "keep_alive": 0},
                    timeout=self.timeout,
                )
                resp.raise_for_status()
                return resp.json().get("embeddings")
            except (httpx.HTTPError, KeyError, ValueError):
                return None
