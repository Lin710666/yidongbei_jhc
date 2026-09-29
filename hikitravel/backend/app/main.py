"""FastAPI 应用入口。

本地部署两种模式：
- 开发：uvicorn app.main:app --reload（前端由 Vite 单独启动，走代理）
- 生产：前端构建到 frontend/dist，配置 STATIC_DIR 后由 FastAPI 静态托管
"""
from pathlib import Path

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from .config import settings
from .llm.warmup import warmer
from .routers.api import router

# 让 Skill 耗时日志能在控制台看到（定位"生成慢在哪一步"）
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
# httpx 的 INFO 日志会把完整请求 URL（含高德 Key）打出来，这里压掉，避免刷屏与泄露
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期：启动时在后台预热模型与提示词缓存。

    不阻塞服务启动——预热跑在守护线程里，Ollama 不可用时只记日志。
    目的是把「第一次生成要额外等 60 秒预填充」这笔开销挪到用户点击之前，
    详见 app/llm/warmup.py。
    """
    warmer.start()
    yield


app = FastAPI(
    title="文旅智能辅助 - 个性化可交互旅游规划系统",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS（本地开发前后端分离；生产可收紧来源）
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


class CacheControlledStaticFiles(StaticFiles):
    """静态托管：index.html 不缓存、带 hash 的资源长缓存。

    否则会出现"前端明明重新构建了，用户刷新还是旧页面"的经典坑：
    浏览器把旧 index.html 缓存住，里面指向的还是旧 JS。
    """

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        normalized = path.replace("\\", "/")
        if normalized.endswith(".html") or normalized in (".", ""):
            response.headers["Cache-Control"] = "no-cache, must-revalidate"
        elif normalized.startswith("assets/"):
            # Vite 产物文件名带内容 hash，内容变了文件名就变，可以放心长缓存
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


# 生产环境：托管前端构建产物；开发环境：返回引导信息
if settings.static_dir and Path(settings.static_dir).is_dir():
    app.mount(
        "/",
        CacheControlledStaticFiles(directory=settings.static_dir, html=True),
        name="static",
    )
else:

    @app.get("/")
    def root():
        return {
            "name": "文旅智能辅助 - 个性化可交互旅游规划系统",
            "docs": "/docs",
            "health": "/api/health",
        }
