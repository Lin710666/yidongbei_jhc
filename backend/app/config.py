"""全局配置模块。

所有可变参数都通过环境变量注入，便于「本地部署」：
- Ollama 地址 / 模型名：AI 本地推理的核心配置
- 天气 API Key：可选，缺省时自动使用内置 Mock 天气数据
- 静态目录：生产环境下 FastAPI 托管前端打包产物

使用方式：复制 .env.example 为 .env 后按需修改。
"""
import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# 载入 backend/.env（若存在）。必须在 Settings 默认值求值前调用，
# 否则 os.getenv 会拿到空值。进程环境变量优先，不会被 .env 覆盖。
load_dotenv()


@dataclass
class Settings:
    # ---- AI 本地推理（Ollama）----
    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "qwen2.5:7b")
    ollama_embed_model: str = os.getenv("OLLAMA_EMBED_MODEL", "nomic-embed-text")
    ollama_timeout: float = float(os.getenv("OLLAMA_TIMEOUT", "30"))
    #: 生成模型用完多久卸载。Ollama 默认留 5 分钟，单卡上那段时间会挡着
    #: 别的模型加载 —— 默认收到 30 秒。
    ollama_keep_alive: str = os.getenv("OLLAMA_KEEP_ALIVE", "30s")

    # ---- 模型路由：云端优先，本地兜底 ----
    #: auto = 配了云端就先用云端，超时/连不上自动落到本地
    #: cloud = 只用云端   local = 只用本地（数据不出机器）
    llm_policy: str = os.getenv("LLM_POLICY", "auto")
    #: OpenAI 兼容的云端服务。三个都填了才算"配好"；留空就是没配。
    cloud_base_url: str = os.getenv("CLOUD_BASE_URL", "")
    cloud_api_key: str = os.getenv("CLOUD_API_KEY", "")
    cloud_model: str = os.getenv("CLOUD_MODEL", "")

    # ---- 热点来源（气泡问题里的"去哪儿"跟着热点变）----
    #: auto = 按 A → C → B → D 依次试   A/C = 外部接口   B = 高德估算   D = 本地词表
    hot_source: str = os.getenv("HOT_SOURCE", "auto")
    #: A / C 通道的接口地址与密钥（任何返回 JSON 的接口都行，字段约定见 hot_topics.py）
    hot_api_url: str = os.getenv("HOT_API_URL", "")
    hot_api_key: str = os.getenv("HOT_API_KEY", "")

    # ---- 高德开放平台（POI / 天气 / 路线 / 周边酒店餐饮 实时数据）----
    amap_api_key: str = os.getenv("AMAP_API_KEY", "")

    # ---- 前端静态目录（生产环境托管 dist/）----
    static_dir: str = os.getenv("STATIC_DIR", "")

    # ---- 运行期数据目录（角色卡、SQLite 等可变文件）----
    # 默认 backend/data；不写死绝对路径，目录整体拷走也能跑。
    data_dir: str = os.getenv("DATA_DIR", "")


settings = Settings()

# 数据目录留空时落到 backend/data。放在实例化之后补，是为了能用相对 __file__
# 推导——写成 dataclass 默认值会在 import 期求值，路径容易算错。
if not settings.data_dir:
    _backend_root = Path(__file__).resolve().parents[1]
    settings.data_dir = str(_backend_root / "data")
