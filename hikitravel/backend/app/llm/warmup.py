"""启动预热：把模型加载进内存，并把各 Skill 的系统提示词预先填进上下文缓存。

为什么需要它（本机实测：qwen2.5:7b / Ryzen 7 8845H / Ollama 100% CPU 推理）：

Ollama 的上下文缓存按**前缀**命中——同一段系统提示词（788 token），
把用户输入换成完全不同的内容，实测预填充仍从 19.0s 掉到 0.7s。
但要注意命中的只是系统提示词那一段：每次请求独有的 payload 仍然要重新预填充，
所以预热省下来的就是这四个系统提示词（合计约 2200 token），冷启动约 62 秒。

真实整单实测（3 天行程，含真实高德检索）：

- 模型已卸载、且未预热：首次请求 141.0s
- 预热之后：98.5s / 108.7s（两次）

即预热把首次请求省下约 30~45 秒；模型加载（数秒）也一并做掉。
因为缓存受 OLLAMA_KEEP_ALIVE 保护，这份开销在每个模型上只需付一次。

刻意不做的事：

- 不阻塞服务启动：预热跑在后台守护线程里，服务立刻可用；
- Ollama 不可用时不报错、不重试，只记一条日志，由 /api/health 如实反映状态；
- 可用 OLLAMA_PREWARM=0 整体关闭。
"""
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from ..config import settings
from .client import LLMClient

logger = logging.getLogger("travelplanner.warmup")

#: 预热用的用户消息。内容不重要——缓存匹配的是它前面的系统提示词前缀，
#: 只要尽量短、并且和真实请求一样走 chat 模板即可。
_WARM_USER = "预热。"


@dataclass(frozen=True)
class WarmTask:
    """一条预热任务：在指定模型上预填充某段系统提示词。"""

    label: str
    model: str
    system: str


def default_tasks() -> List[WarmTask]:
    """按流水线顺序列出要预热的提示词。

    顺序有讲究：需求抽取 → 景点挑选 → 规划体检 → 需求修订。
    如果用户在预热还没跑完时就点了「生成」，越靠前的提示词越可能已经备好。
    """
    from ..skills.check_skill import _SYSTEM_PROMPT as CHECK_PROMPT
    from ..skills.intent_skill import _REVISION_PROMPT, _SYSTEM_PROMPT as INTENT_PROMPT
    from ..skills.planner_skill import _SYSTEM_PROMPT as PLANNER_PROMPT

    main_model = settings.ollama_model
    intent_model = settings.ollama_intent_model or main_model
    check_model = settings.ollama_check_model or main_model

    candidates = [
        WarmTask("需求抽取", intent_model, INTENT_PROMPT),
        WarmTask("景点挑选", main_model, PLANNER_PROMPT),
        WarmTask("规划体检", check_model, CHECK_PROMPT),
        WarmTask("需求修订", intent_model, _REVISION_PROMPT),
    ]
    # 同一个模型上的同一段提示词只预热一次（配置留空时多项会指向同一个模型）
    seen: set = set()
    tasks: List[WarmTask] = []
    for task in candidates:
        key = (task.model, task.system)
        if key in seen:
            continue
        seen.add(key)
        tasks.append(task)
    return tasks


class ModelWarmer:
    """后台预热器：加载模型 + 预填提示词缓存，并对外汇报状态。"""

    def __init__(
        self,
        client: Optional[LLMClient] = None,
        tasks: Optional[List[WarmTask]] = None,
    ) -> None:
        self.client = client or LLMClient()
        self.tasks = tasks if tasks is not None else default_tasks()
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._state = "idle"  # idle | warming | ready | partial | failed | off
        self._detail = ""
        self._results: List[Dict[str, Any]] = []
        self._seconds = 0.0

    # ---------------- 对外接口 ----------------
    def start(self) -> bool:
        """启动后台预热。返回 True 表示本次真的启动了。"""
        if not settings.ollama_prewarm:
            with self._lock:
                self._state = "off"
                self._detail = "已关闭（OLLAMA_PREWARM=0）"
            return False
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return False
            self._state = "warming"
            self._detail = ""
            self._results = []
            self._seconds = 0.0
            self._thread = threading.Thread(
                target=self._run, name="ollama-prewarm", daemon=True
            )
            self._thread.start()
        return True

    def status(self) -> Dict[str, Any]:
        """给 /api/health 用的状态快照。"""
        with self._lock:
            return {
                "state": self._state,
                "done": len(self._results),
                "total": len(self.tasks),
                "detail": self._detail,
                "seconds": round(self._seconds, 1),
                "tasks": [dict(item) for item in self._results],
            }

    # ---------------- 后台执行 ----------------
    def _run(self) -> None:
        total = len(self.tasks)
        if total == 0:
            with self._lock:
                self._state, self._detail = "ready", "没有需要预热的提示词"
            return
        logger.info("开始预热（模型 + 提示词缓存）：共 %d 项；可用 OLLAMA_PREWARM=0 关闭", total)
        started_all = time.perf_counter()
        for index, task in enumerate(self.tasks, start=1):
            started = time.perf_counter()
            try:
                ok = self.client.prefill(task.system, _WARM_USER, model=task.model)
                error = "" if ok else (self.client.last_error or "未知原因")
            except Exception as exc:  # 预热是尽力而为，绝不能让线程带着异常退出
                ok, error = False, str(exc)
            seconds = round(time.perf_counter() - started, 1)
            with self._lock:
                self._results.append(
                    {
                        "label": task.label,
                        "model": task.model,
                        "ok": ok,
                        "seconds": seconds,
                        "error": error,
                    }
                )
            logger.info(
                "预热 %d/%d %s（%s）%s，用时 %.1fs",
                index,
                total,
                task.label,
                task.model,
                "完成" if ok else f"失败：{error}",
                seconds,
            )

        elapsed = round(time.perf_counter() - started_all, 1)
        with self._lock:
            oks = sum(1 for item in self._results if item["ok"])
            self._seconds = elapsed
            if oks == total:
                self._state = "ready"
                self._detail = "模型与提示词缓存已就绪，首次生成即为稳态速度"
            elif oks == 0:
                self._state = "failed"
                self._detail = "预热全部失败，首次生成会明显更慢（请检查 Ollama 是否在运行）"
            else:
                self._state = "partial"
                self._detail = f"{oks}/{total} 项预热成功，未成功的部分首次生成会明显更慢"
        logger.info("预热结束：%d/%d 成功，总用时 %.1fs", oks, total, elapsed)


#: 进程内单例：main.py 启动时调用 start()，routers/api.py 读 status()
warmer = ModelWarmer()
