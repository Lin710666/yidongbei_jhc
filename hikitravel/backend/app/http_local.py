"""本机服务（Ollama）的 HTTP 调用约定。

为什么需要这个模块：httpx 默认读取 HTTP_PROXY / HTTPS_PROXY 环境变量。
开发机上常开着系统代理（Clash / v2ray 等），只要代理没有把 localhost 排除，
发往 127.0.0.1 的请求就会被送进代理并超时——表现成
「Ollama 明明在跑，后端却报连不上」，而且换任何网络诊断工具都查不出原因。

本机地址本来就不需要代理，这里统一判断，只对本机地址关掉环境代理读取；
外部服务（高德）保持原样，用户如果确实要走代理仍然有效。
"""
from urllib.parse import urlparse

_LOOPBACK = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}


def trust_env_for(url: str) -> bool:
    """本机地址返回 False（不走代理），其余返回 True。"""
    host = (urlparse(url).hostname or "").lower()
    return host not in _LOOPBACK
