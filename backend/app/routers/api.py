"""API 路由：对话/表单生成规划、健康检查、历史计划。

异常处理（比赛加分项）：
- 未配置高德密钥 / 网络异常时，返回 503 与清晰提示，而非伪造数据。
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import store
from ..models.plan import TravelPlan
from ..models.preference import UserPreference
from ..orchestrator import get_orchestrator
from ..services.amap import AmapError

router = APIRouter(prefix="/api")
# 与 ui_compat 共用同一个编排器（省一次知识索引构建，见 orchestrator.get_orchestrator）
orchestrator = get_orchestrator()


class ChatRequest(BaseModel):
    """对话模式请求。"""

    message: str
    apply_suggestions: bool = False  # 用户是否已同意采纳异常拦截建议
    preference: Optional[Dict[str, Any]] = None  # 表单已填的部分画像（作为底，覆盖对话模糊解析）


class PlanRequest(BaseModel):
    """表单模式请求。"""

    preference: UserPreference
    apply_suggestions: bool = False


def _run_plan(raw_text=None, preference=None, apply_suggestions=False, base=None) -> TravelPlan:
    try:
        return orchestrator.run(
            raw_text=raw_text,
            preference=preference,
            apply_suggestions_flag=apply_suggestions,
            base=base,
        )
    except AmapError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.post("/chat", response_model=TravelPlan)
def chat(req: ChatRequest) -> TravelPlan:
    """对话式生成规划（可携带表单已填画像作为底，弥补对话解析的模糊性）。

    这是一次性返回完整 TravelPlan 的 JSON 接口，供组员的 React 界面调用。
    5.0 的 AIRI 界面同样需要「对话」，但它用的是 SSE 流式响应，
    两者协议不同、无法共用一个路径——那条挂在 `/api/chat/stream`
    （见 routers/ui_compat.py）。
    """
    plan = _run_plan(
        raw_text=req.message,
        apply_suggestions=req.apply_suggestions,
        base=req.preference,
    )
    store.save_plan(plan.model_dump())
    return plan


@router.post("/plan", response_model=TravelPlan)
def make_plan(req: PlanRequest) -> TravelPlan:
    """表单式生成规划。"""
    plan = _run_plan(preference=req.preference, apply_suggestions=req.apply_suggestions)
    store.save_plan(plan.model_dump())
    return plan


@router.get("/health")
def health() -> Dict[str, Any]:
    """健康检查：返回 Ollama / 高德密钥配置状态。"""
    return {
        "status": "ok",
        "ollama_available": orchestrator.planner.llm.available(),
        "amap_configured": bool(orchestrator.retrieve.amap.key),
    }


@router.get("/plans")
def plans() -> List[Dict[str, Any]]:
    """历史规划列表。"""
    return store.list_plans()


@router.get("/plans/{plan_id}")
def get_plan(plan_id: str) -> Dict[str, Any]:
    """按 ID 读取规划（供导出/分享）。"""
    plan = store.get_plan(plan_id)
    if not plan:
        raise HTTPException(status_code=404, detail="计划不存在")
    return plan


@router.post("/plans/save", response_model=Dict[str, Any])
def save_edited_plan(payload: Dict[str, Any]) -> Dict[str, Any]:
    """保存（覆盖）一条规划：供用户编辑后持久化，下次可从历史计划打开。"""
    store.save_plan(payload)
    return {"ok": True, "plan_id": payload.get("plan_id")}
