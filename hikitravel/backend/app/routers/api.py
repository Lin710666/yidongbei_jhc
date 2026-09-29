"""API 路由：对话/表单生成规划、健康检查、历史计划。

异常处理原则（与用户对齐）：不静默降级、不伪造数据，
把"哪里出了问题、用户该怎么处理"如实返回给前端。
- 信息缺失 / 目的地认不出来 → 400，提示用户补充或确认
- 未接入大模型 API → 503，提示用户启动模型服务
- 大模型输出不可解析 → 502，提示用户重试
- 未配置高德密钥 / 网络异常 → 503
"""
import json
import logging
import queue
import threading
from typing import Any, Callable, Dict, Iterator, List, Literal, Optional

import base64

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import store
from ..config import settings
from ..llm.warmup import warmer
from ..models.plan import TravelPlan
from ..models.preference import UserPreference
from ..orchestrator import Orchestrator
from ..services.amap import AmapDestinationError, AmapError
from ..services.static_map import build_legend, build_static_map_params
from ..skills.errors import (
    LLMOutputError,
    LLMUnavailableError,
    MissingRequiredInfoError,
    SkillError,
)
from ..skills.photo_backfill import backfill_plan_photos, enrich_missing_photos
from ..skills.retrieve_skill import ATTRACTION_TYPES

router = APIRouter(prefix="/api")
orchestrator = Orchestrator()
logger = logging.getLogger("travelplanner.api")


class ChatRequest(BaseModel):
    """对话模式请求。"""

    message: str
    preference: Optional[Dict[str, Any]] = None  # 表单已填的部分画像（作为底，覆盖对话模糊解析）


class PlanRequest(BaseModel):
    """表单模式请求。"""

    preference: UserPreference


class ReviseRequest(BaseModel):
    """对话式修改规划请求：带上要修改的那版规划即可（画像就存在规划里）。"""

    message: str
    plan: TravelPlan


class MapRequest(BaseModel):
    """地图请求：把当前规划发过来，后端代理取高德静态地图。"""

    plan: TravelPlan


class PlaceTip(BaseModel):
    """目的地输入提示的一个候选。"""

    name: str
    district: str  # 省市区全路径，如「福建省福州市平潭县」
    adcode: str
    kind: Literal["行政区", "地点"]  # 行政区（省/市/区县）还是区内某个地点
    lat: Optional[float] = None
    lng: Optional[float] = None


class MapConfig(BaseModel):
    """前端交互地图（高德 JS API）的运行时配置。"""

    enabled: bool
    key: str = ""
    security_code: str = ""


def _execute(call) -> TravelPlan:
    """统一把 Skill 层异常翻译成带清晰提示的 HTTP 错误。"""
    try:
        return call()
    except MissingRequiredInfoError as exc:
        # 用户没填关键信息 / 目的地为空：直接告诉他补什么，不用默认值糊过去
        raise HTTPException(status_code=400, detail=str(exc))
    except AmapDestinationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except LLMUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except LLMOutputError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except AmapError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except SkillError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


def _run_plan(raw_text=None, preference=None, base=None) -> TravelPlan:
    return _execute(
        lambda: orchestrator.run(
            raw_text=raw_text,
            preference=preference,
            base=base,
        )
    )


# ---------------- 流式生成（SSE） ----------------
#
# 为什么需要它：整单生成要 100 秒上下，其中"规划体检"就占 59~75 秒。
# 非流式接口下用户只能对着一个转动的小圈等两分钟，而且体检一旦最后一步失败，
# 前面 100 秒的成果（一份已经完整可用的行程）会连带着被丢掉。
# 流式把过程摊开：
#   step 事件 → 前端显示"正在做什么、已经花了多久"
#   plan 事件 → 行程初稿/优化稿一到就先渲染出来，用户不用等体检
#   done 事件 → 最终规划 + 体检结论
#   error 事件 → 失败原因（HTTP 状态码在流开始时就已定为 200，无法再改）


def _sse(payload: Dict[str, Any]) -> str:
    """一条 SSE 消息。事件类型放在 JSON 里，前端只需解析 data。"""
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


def _error_event(exc: Exception) -> Dict[str, Any]:
    """把 Skill 层异常翻译成前端能识别的错误事件（口径与 _execute 一致）。"""
    if isinstance(exc, LLMUnavailableError):
        return {"type": "error", "kind": "network", "message": str(exc)}
    if isinstance(exc, (MissingRequiredInfoError, SkillError, AmapDestinationError, AmapError)):
        return {"type": "error", "kind": "http", "message": str(exc)}
    logger.exception("流式生成出现未预期异常")
    return {"type": "error", "kind": "network", "message": f"生成过程中出现异常：{exc}"}


def _stream(work: Callable[[Callable[[Dict[str, Any]], None]], None]) -> Iterator[str]:
    """把一次生成过程转成 SSE 事件流。

    为什么要多开一个线程：orchestrator 是同步的，如果在生成器里直接跑，
    事件只能等它整个跑完才吐得出来，就失去了"实时"的意义。
    所以生成跑在工作线程、事件经队列流回生成器，两者通过队列解耦。
    """
    events: "queue.Queue[Optional[Dict[str, Any]]]" = queue.Queue()
    outcome: Dict[str, Any] = {}

    def emit(event: Dict[str, Any]) -> None:
        events.put(event)

    def run() -> None:
        try:
            work(emit)
        except Exception as exc:  # 兜底：任何异常都要变成一条 error 事件，不能让流挂住
            outcome.update(_error_event(exc))
        finally:
            events.put(None)  # 哨兵：通知生成器结束

    threading.Thread(target=run, name="plan-stream", daemon=True).start()

    while True:
        event = events.get()
        if event is None:
            break
        yield _sse(event)
    if outcome:
        yield _sse(outcome)


def _stream_headers() -> Dict[str, str]:
    # X-Accel-Buffering: no 是给反向代理看的：不缓冲，逐条转发（否则要等流结束）
    return {"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"}


@router.post("/chat", response_model=TravelPlan)
def chat(req: ChatRequest) -> TravelPlan:
    """对话式生成规划（可携带表单已填画像作为底，弥补对话解析的模糊性）。"""
    plan = _run_plan(
        raw_text=req.message,
        base=req.preference,
    )
    store.save_plan(plan.model_dump())
    return plan


@router.post("/plan", response_model=TravelPlan)
def make_plan(req: PlanRequest) -> TravelPlan:
    """表单式生成规划。"""
    plan = _run_plan(preference=req.preference)
    store.save_plan(plan.model_dump())
    return plan


@router.post("/plan/revise", response_model=TravelPlan)
def revise_plan(req: ReviseRequest) -> TravelPlan:
    """对话式修改规划：在已有画像上应用新要求（"预算压到 2500""第二天换成室内"）。

    画像随规划一起保存（plan.user_preference），所以可以直接改，不需要用户重填表单。
    """
    plan = _execute(
        lambda: orchestrator.revise(
            message=req.message,
            plan=req.plan,
        )
    )
    store.save_plan(plan.model_dump())
    return plan


@router.post("/chat/stream")
def chat_stream(req: ChatRequest) -> StreamingResponse:
    """对话式生成规划（SSE 流式）：边生成边推送进度与行程快照。

    事件格式见 _stream 上方的说明；前端用 fetch + ReadableStream 读取，
    因为 EventSource 不支持 POST 请求体。
    """

    def work(emit) -> None:
        plan = orchestrator.run(
            raw_text=req.message,
            base=req.preference,
            on_event=emit,
        )
        store.save_plan(plan.model_dump())

    return StreamingResponse(
        _stream(work), media_type="text/event-stream", headers=_stream_headers()
    )


@router.post("/plan/stream")
def plan_stream(req: PlanRequest) -> StreamingResponse:
    """表单式生成规划（SSE 流式）。"""

    def work(emit) -> None:
        plan = orchestrator.run(
            preference=req.preference,
            on_event=emit,
        )
        store.save_plan(plan.model_dump())

    return StreamingResponse(
        _stream(work), media_type="text/event-stream", headers=_stream_headers()
    )


@router.post("/plan/revise/stream")
def revise_plan_stream(req: ReviseRequest) -> StreamingResponse:
    """对话式修改规划（SSE 流式）。"""

    def work(emit) -> None:
        plan = orchestrator.revise(
            message=req.message,
            plan=req.plan,
            on_event=emit,
        )
        store.save_plan(plan.model_dump())

    return StreamingResponse(
        _stream(work), media_type="text/event-stream", headers=_stream_headers()
    )


@router.post("/map/static")
def static_map(req: MapRequest) -> Dict[str, Any]:
    """返回高德静态地图（真实底图 + 编号标记 + 每日彩色轨迹）与对应图例。

    为什么走后端：静态地图接口需要 Key，浏览器直接调会把 Key 暴露出去。
    这里由后端带 Key 取图，转成 data URL 返回，前端只拿到图片本身。
    """
    try:
        params = build_static_map_params(req.plan)
        # 复用检索 Skill 的高德客户端：共享限流，避免并发触发额度限制
        image = orchestrator.retrieve.amap.static_map(**params)
    except AmapError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {
        "image": "data:image/png;base64," + base64.b64encode(image).decode("ascii"),
        "legend": build_legend(req.plan),
        "zoom": params["zoom"],
        "center": params["center"],
    }


@router.get("/map/config", response_model=MapConfig)
def map_config() -> MapConfig:
    """交互地图的前端配置。

    为什么由接口下发、而不是打进前端产物：
    1. 换 Key 或安全密钥不用重新构建前端；
    2. 没配置时前端立刻知道，直接退回静态地图，不会开天窗。

    安全说明（重要）：JS API 的 Key 按设计**必然出现在浏览器里**，
    安全密钥同理，藏不住也没必要藏。真正的防滥用手段是在高德控制台
    给该 Key 配「安全域名白名单」——只允许我们自己的域名调用。
    不配白名单的话，任何人抄走 Key 都能刷额度，这是藏密钥挡不住的。
    """
    enabled = bool(settings.amap_js_key and settings.amap_security_code)
    return MapConfig(
        enabled=enabled,
        key=settings.amap_js_key if enabled else "",
        security_code=settings.amap_security_code if enabled else "",
    )


@router.get("/places/autocomplete", response_model=List[PlaceTip])
def autocomplete_places(q: str, city: str = "", limit: int = 8) -> List[PlaceTip]:
    """目的地输入提示（下拉候选）。

    为什么走后端代理：高德 Key 一旦落到浏览器就等于公开，谁都能拿去刷额度。

    为什么用实时候选而不是「固定下拉列表」：行政区划本身会调整，
    硬编码的列表迟早过期；而且用户的目的地粒度常常不是行政区
    （平潭岛 / 洱海 / 中山陵景区），固定城市列表覆盖不到。

    每条候选都带 adcode——用户点选后前端会把 adcode 一起提交，
    后端直接按主键解析，连「平潭县 / 平潭镇」这种同名歧义都不存在了。
    """
    try:
        tips = orchestrator.retrieve.amap.input_tips(q, city)
    except AmapError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    capped = max(1, min(limit, 20))
    result: List[PlaceTip] = []
    for tip in tips[:capped]:
        name = tip.get("name") if isinstance(tip.get("name"), str) else ""
        if not name:
            continue

        district = tip.get("district") if isinstance(tip.get("district"), str) else ""
        adcode = tip.get("adcode") if isinstance(tip.get("adcode"), str) else ""

        lat: Optional[float] = None
        lng: Optional[float] = None
        location = tip.get("location") if isinstance(tip.get("location"), str) else ""
        if "," in location:
            lng_text, _, lat_text = location.partition(",")
            try:
                lng, lat = float(lng_text), float(lat_text)
            except ValueError:
                lat = lng = None

        result.append(
            PlaceTip(
                name=name,
                district=district or name,
                adcode=adcode,
                # 判定「这条候选本身是行政区，还是辖区内的某个地点」：
                # 行政区一定有 adcode，且区划路径以它自己的名字结尾
                # （平潭县 → 福建省福州市平潭县）；地点则不是（平潭站）。
                # 只判结尾不够：景区类候选有时 district 就等于名字但没有 adcode，
                # 例如「鼓浪屿」，那样会被误标成行政区。
                kind="行政区" if adcode and district.endswith(name) else "地点",
                lat=lat,
                lng=lng,
            )
        )
    return result


class AttractionTip(BaseModel):
    """「必去景点」下拉候选项：只包含真正的景点（已按分类码过滤）。"""

    name: str
    district: str
    adcode: str
    lat: Optional[float] = None
    lng: Optional[float] = None
    rating: Optional[float] = None
    address: str = ""
    photos: List[str] = []


@router.get("/places/attractions", response_model=List[AttractionTip])
def search_attractions(q: str, city: str = "", limit: int = 10) -> List[AttractionTip]:
    """「必去景点」的下拉候选：只搜真正的景点。

    为什么不能复用上面的 /places/autocomplete（高德 inputtips）：
    那个接口不认类型。实测同一个词「长江澳」返回的 6 条里，
    有一条是「自然地名 · 海湾海峡」——它的坐标是海湾的几何中心，
    标在地图上会落在海里；还有 3 条是停车场。

    这里改用 /place/text 并限定「景点类」分类码，返回的都是风景名胜/公园/场馆，
    而且自带评分与实拍图（下拉候选本身是没有图的）。
    """
    keyword = (q or "").strip()
    if not keyword:
        return []
    capped = max(1, min(limit, 20))
    try:
        hits = orchestrator.retrieve.amap.search_poi(
            keyword, city, types=ATTRACTION_TYPES, offset=capped
        )
    except AmapError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    result: List[AttractionTip] = []
    for item in hits[:capped]:
        name = item.get("name") if isinstance(item.get("name"), str) else ""
        location = item.get("location") if isinstance(item.get("location"), str) else ""
        if not name or "," not in location:
            continue
        lng_text, _, lat_text = location.partition(",")
        try:
            lng, lat = float(lng_text), float(lat_text)
        except ValueError:
            continue
        biz = item.get("biz_ext") or {}
        try:
            rating = float(biz.get("rating"))
        except (TypeError, ValueError):
            rating = None
        photos: List[str] = []
        for photo in item.get("photos") or []:
            url = photo.get("url") if isinstance(photo, dict) else None
            if isinstance(url, str) and url.startswith("http"):
                photos.append(url.replace("http://", "https://", 1))
            if len(photos) >= 3:
                break
        result.append(
            AttractionTip(
                name=name,
                district=_text_field(item.get("adname")) or _text_field(item.get("cityname")) or name,
                adcode=_text_field(item.get("adcode")),
                lat=lat,
                lng=lng,
                rating=rating if rating and rating > 0 else None,
                address=_text_field(item.get("address")),
                photos=photos,
            )
        )
    return result


def _text_field(value: Any) -> str:
    """高德偶尔把字符串字段返回成空 list，统一转成安全字符串。"""
    return value if isinstance(value, str) else ""


@router.get("/health")
def health() -> Dict[str, Any]:
    """健康检查：返回 Ollama / 高德密钥配置状态，以及启动预热进度。"""
    return {
        "status": "ok",
        "ollama_available": orchestrator.planner.llm.available(),
        "amap_configured": bool(orchestrator.retrieve.amap.key),
        # 启动预热（模型加载 + 提示词缓存）的进度：预热跑完前，第一次生成会明显更慢
        "ollama_warm": warmer.status(),
    }


@router.get("/plans")
def plans() -> List[Dict[str, Any]]:
    """历史规划列表。"""
    return store.list_plans()


@router.get("/plans/{plan_id}")
def get_plan(plan_id: str) -> Dict[str, Any]:
    """按 ID 读取规划（供历史打开 / 导出 / 分享）。

    旧规划里可能存着"没有图的占位点"（必去景点当年匹配不到高德记录时会退化成
    只有坐标的条目，见 skills/photo_backfill.py 的说明）。读的时候用同一份规划
    自带的候选池补一次图：零网络、不改坐标与行程，只补图片。
    """
    plan = store.get_plan(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="计划不存在")
    # 两步：先零网络（用规划自带的候选池补），还缺的再按坐标护栏查一次高德
    return enrich_missing_photos(backfill_plan_photos(plan), amap=orchestrator.retrieve.amap)


@router.post("/plans/save", response_model=Dict[str, Any])
def save_edited_plan(payload: Dict[str, Any]) -> Dict[str, Any]:
    """保存（覆盖）一条规划：供用户编辑后持久化，下次可从历史计划打开。"""
    store.save_plan(payload)
    return {"ok": True, "plan_id": payload.get("plan_id")}
