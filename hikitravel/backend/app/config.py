"""全局配置模块。

所有可变参数都通过环境变量注入，便于「本地部署」：
- Ollama 地址 / 模型名：AI 本地推理的核心配置
- 天气 API Key：可选，缺省时自动使用内置 Mock 天气数据
- 静态目录：生产环境下 FastAPI 托管前端打包产物

使用方式：复制 .env.example 为 .env 后按需修改。
"""
import os
from dataclasses import dataclass

from dotenv import load_dotenv

# 载入 backend/.env（若存在）。必须在 Settings 默认值求值前调用，
# 否则 os.getenv 会拿到空值。进程环境变量优先，不会被 .env 覆盖。
load_dotenv()


@dataclass
class Settings:
    # ---- AI 本地推理（Ollama）----
    ollama_base_url: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    ollama_model: str = os.getenv("OLLAMA_MODEL", "qwen2.5:7b")
    # 需求抽取可以单独指定模型：它是"照着说明填空"，对模型能力的要求低于
    # 规划与体检，换个小模型能省掉每次生成开头的一次长耗时调用。
    ollama_intent_model: str = os.getenv("OLLAMA_INTENT_MODEL", "")
    # 规划体检可以单独指定模型：换个小模型能明显提速（体检是"挑毛病"，
    # 对模型能力的要求低于规划本身）
    ollama_check_model: str = os.getenv("OLLAMA_CHECK_MODEL", "")
    # 本地 7B 模型在 CPU 上生成一份完整规划可能需要 1~3 分钟，
    # 超时设太短会把"模型还在写"误判成失败，因此默认给足 180 秒。
    ollama_timeout: float = float(os.getenv("OLLAMA_TIMEOUT", "180"))
    # 模型常驻时长（Ollama keep_alive）：一次生成要多次调用大模型，
    # 保持常驻可以省掉两次调用之间的模型加载时间（本地 7B 冷启动可达几十秒）
    ollama_keep_alive: str = os.getenv("OLLAMA_KEEP_ALIVE", "30m")
    # 启动预热：在后台把模型加载进内存，并把各 Skill 的系统提示词预填进上下文缓存。
    # Ollama 的缓存按前缀命中，所以预热之后第一次「生成」就能直接进入稳态速度
    # （本机实测：第一次请求约 108s → 约 44s）。设成 0 可关闭。
    ollama_prewarm: bool = os.getenv("OLLAMA_PREWARM", "1").strip().lower() not in (
        "0",
        "false",
        "no",
        "off",
    )

    # ---- 高德开放平台（POI / 天气 / 路线 / 周边酒店餐饮 实时数据）----
    # 三把密钥都**已内置**，clone 下来不配 .env 也能直接跑；
    # 想换成自己的，就复制 .env.example 为 .env 填同名变量覆盖（.env 不入库）。
    amap_api_key: str = os.getenv("AMAP_API_KEY", "e15977855225aaaedebd91c466a3c39e")
    # 浏览器端交互地图（高德 JS API）单独一套凭据：
    # 类型是「Web端(JS API)」，与上面的 Web服务 Key 不通用。
    # 缺失时前端自动退回静态地图，不会开天窗。
    # 安全提醒：JS Key 按设计必然出现在浏览器里，安全密钥同理，藏不住也没必要藏。
    # 真正的防滥用是在高德控制台给该 Key 配「安全域名白名单」。
    amap_js_key: str = os.getenv("AMAP_JS_KEY", "2b8f3210dc65ebae33324896c40150cf")
    amap_security_code: str = os.getenv("AMAP_SECURITY_CODE", "20d4d829c08555735655a2c35707a444")

    # ---- 前端静态目录（生产环境托管 dist/）----
    static_dir: str = os.getenv("STATIC_DIR", "")

    # ---- 实时攻略检索（可选，默认关闭）----
    # 接公开搜索 API 做"搜索 + 阅读"，把攻略摘要作为**偏好提示**喂给选点提示词。
    # 三项都配齐才启用；不配就完全跳过，主流程不受影响。
    # 遵守四条底线，见 services/web_search.py 的模块说明（只发城市名、实体必须能在高德找到等）。
    search_api_mode: str = os.getenv("SEARCH_API_MODE", "")  # serper / bocha（其它值走通用 GET）
    search_api_url: str = os.getenv("SEARCH_API_URL", "")
    search_api_key: str = os.getenv("SEARCH_API_KEY", "")
    search_timeout: float = float(os.getenv("SEARCH_TIMEOUT", "8"))

    # ---- 规划体检：允许带反馈重新生成的最大次数（0 = 只体检不重生成）----
    # 重新生成要多花一次大模型调用（本地 7B 约 1 分钟），因此默认只允许 1 次，
    # 且只在"硬伤"（系统判定的严重问题 / 优化后仍存在的超长路线）时才触发。
    plan_max_regenerate: int = int(os.getenv("PLAN_MAX_REGENERATE", "1"))

    # ---- 成链之后的「跨度 + 配套」校验（见 planner_skill._fix_day_quality）----
    # 一天内部跨度超过这个值就认为"这一天的点集本身不合理"：链可以在这一组点里
    # 排出最优顺序，但排不出紧凑的一天。
    # 口径是**真实驾车距离**（取不到时才用直线 × 绕行系数），不是直线距离——
    # 平潭实测驾车约为直线的 1.6~2 倍，所以 15 公里驾车 ≈ 8 公里直线，
    # 正好对上"一天横跨 8~10 公里直线"这种用户能直接感觉到的离谱排法。
    plan_day_span_limit: float = float(os.getenv("PLAN_DAY_SPAN_LIMIT", "15"))
    # 当天某个景点在这个距离（公里）内没有任何餐厅/酒店候选 → 配套不足，
    # 说明把它排在这天会导致"跑很远去吃饭/住宿"。
    plan_amenity_km: float = float(os.getenv("PLAN_AMENITY_KM", "5"))
    # 定向修补最多做几轮（每轮可能替换一个点；换完要重新串链分天）
    plan_fix_rounds: int = int(os.getenv("PLAN_FIX_ROUNDS", "2"))


settings = Settings()
