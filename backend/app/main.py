"""FastAPI 应用入口。

融合版说明：本服务同时提供两套前端所需的接口。

  · HikiTravel 原生的 React 前端（frontend/，走 /api/plan、/api/chat、/api/plans…）
  · 5.0 的 AIRI 风格网页界面（public/，走 /api/wenlv/generate 与一堆目录类接口）

后者由下面的 ui_compat 路由做兼容层，详见 app/routers/ui_compat.py 的头注释。

本地部署两种模式：
- 开发：uvicorn app.main:app --reload（前端由 Vite 单独启动，走代理）
- 生产：前端构建到 frontend/dist，配置 STATIC_DIR 后由 FastAPI 静态托管
"""
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import settings
from .routers.api import router
from .routers.ui_compat import router as ui_router

app = FastAPI(
    title="文旅智能辅助 - 个性化可交互旅游规划系统",
    version="0.1.0",
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
# 5.0 界面的兼容层。两边路径不重叠：原生是 /api/chat、/api/plan，
# 兼容层是 /api/wenlv/*、/api/chat/stream、/api/agent 与一堆目录类接口。
# 所以注册顺序无所谓；放在后面更保险 —— 万一将来重名，以原生的实现为准。
app.include_router(ui_router)


@app.middleware("http")
async def _no_cache_for_frontend(request, call_next):
    """前端静态资源一律要求浏览器回源校验。

    为什么要加：StaticFiles 只发 Last-Modified / ETag，**不发 Cache-Control**，
    浏览器于是按"启发式缓存"自己算一个新鲜期（通常是文件年龄的 10%），
    在那段时间里直接吃本地副本、连问都不问服务器。

    这在改前端的时候会踩得很惨：`index.html` 已经是新版（所以界面上出现了新按钮），
    而同一次改动里的 `app.js` 还命中旧缓存——页面就成了「按钮在、点了没反应、
    面板空白」。改的人只会以为代码写错了，其实服务器上的文件是对的。

    只对非 /api 路径生效：/api/tile 自己带了 max-age=86400 的瓦片缓存，
    那是要留着的。
    """
    resp = await call_next(request)
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


def _pick_static_dir() -> str:
    """决定用哪份前端。

    融合版里 5.0 的 public/ 是主界面，优先托管它；只有它不在时才退回
    HikiTravel 原生的 frontend/dist。这样两种前端共存，拷走哪个都能跑。
    """
    project_root = Path(__file__).resolve().parents[2]
    airi = project_root / "public"
    if (airi / "index.html").is_file():
        return str(airi)
    return settings.static_dir


_static = _pick_static_dir()

# ---------------------------------------------------------------------------
# index.html 的资源版本号
#
# 为什么需要：浏览器对静态资源的缓存策略五花八门，实测遇到过
# 「index.html 已经是新版（界面上出现了新按钮）、而 app.js 还在吃旧缓存」
# 的组合 —— 页面就成了「按钮在、点了没反应、面板空白」，
# 改的人会以为代码写错了，其实服务器上的文件完全是对的。
# 光靠 Cache-Control: no-cache 不够稳（旧缓存条目还没有这个头的时候，
# 浏览器可能直接按旧的启发式新鲜期吃本地副本）。
#
# 所以这里改成：index.html 里的资源 URL 带一个 __ASSET_V__ 占位，
# 每次请求首页时用 public/ 下最新的文件修改时间替换它。
# 任何前端文件一改，所有资源 URL 就变了 → 缓存必然命中不了 → 一定是新文件。
# 不需要任何人手动清缓存，也不需要手动改版本号。
# ---------------------------------------------------------------------------
_asset_v_cache: dict = {"v": "", "t": 0.0}


def _asset_version(static_dir: Path) -> str:
    """拿 public/ 下最新的 mtime 当资源版本号（缓存 2 秒，别每次请求都遍历）。"""
    now = time.time()
    if _asset_v_cache["v"] and now - _asset_v_cache["t"] < 2.0:
        return str(_asset_v_cache["v"])
    newest = 0.0
    try:
        for p in static_dir.rglob("*"):
            if p.is_file():
                m = p.stat().st_mtime
                if m > newest:
                    newest = m
    except OSError:
        newest = 0.0
    v = str(int(newest)) or "0"
    _asset_v_cache.update(v=v, t=now)
    return v


if _static and (Path(_static) / "index.html").is_file():

    @app.get("/")
    @app.get("/index.html")
    def index_html():
        """首页：把资源版本号填进去再发。

        这两条路由必须注册在下面的 StaticFiles 挂载**之前** —— 挂载在 "/"，
        注册在前的路由先匹配。
        """
        from fastapi.responses import HTMLResponse

        html = (Path(_static) / "index.html").read_text(encoding="utf-8")
        return HTMLResponse(html.replace("__ASSET_V__", _asset_version(Path(_static))),
                            headers={"Cache-Control": "no-cache, must-revalidate"})


if _static and Path(_static).is_dir():
    app.mount("/", StaticFiles(directory=_static, html=True), name="static")
else:

    @app.get("/")
    def root():
        return {
            "name": "文旅智能辅助 - 个性化可交互旅游规划系统",
            "docs": "/docs",
            "health": "/api/health",
            "hint": "没有找到前端。融合版需要 public/index.html，或配置 STATIC_DIR。",
        }
