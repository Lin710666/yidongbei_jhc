import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  fetchMapConfig,
  fetchStaticMap,
  getPlan,
  health,
  listPlans,
  savePlan,
  streamPlanByChat,
  streamPlanByForm,
  streamPlanRevise,
  type ApiErrorKind,
  type Health,
  type MapConfig,
  type PlanEvent,
  type PlanStep,
  type PlanSummary,
  type StaticMapData,
} from '../api/client'
import type { TravelPlan } from '../types/plan'
import type { UserPreference } from '../types/preference'
import { loadAmap } from '../lib/amap'

/** 最近一次请求：重试与「采纳建议」都基于它重放，用户不用重填 */
type LastRequest =
  | { kind: 'form'; pref: UserPreference }
  | { kind: 'chat'; message: string; base?: Partial<UserPreference> }
  | { kind: 'revise'; message: string; plan: TravelPlan }

export interface PlannerError {
  message: string
  kind: ApiErrorKind
}

export function usePlanner(notify: (text: string) => void) {
  const [plan, setPlan] = useState<TravelPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<PlannerError | null>(null)
  const [env, setEnv] = useState<Health | null>(null)
  const [history, setHistory] = useState<PlanSummary[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [mapData, setMapData] = useState<StaticMapData | null>(null)
  const [mapLoading, setMapLoading] = useState(false)
  const [mapError, setMapError] = useState<string | null>(null)
  const [mapConfig, setMapConfig] = useState<MapConfig | null>(null)
  const [dirty, setDirty] = useState(false)
  /** 生成过程中的实时进度（后端 SSE 推来），用于给用户看到"正在做什么" */
  const [steps, setSteps] = useState<PlanStep[]>([])
  /** 行程已经可以先看了，但体检还在跑：这一行说明当前处于哪个阶段 */
  const [stageNote, setStageNote] = useState<string | null>(null)
  /** 体检是否已经有结论（收到 done 事件，或从历史计划打开）。
      没有结论 + 已不在生成中 = 这次被取消/中断了，界面要如实这么说，
      不能显示成「未发现明显问题」。 */
  const [checksSettled, setChecksSettled] = useState(false)
  /** 「当前这一单」的序号。
      同一单里初稿→终稿会换 plan_id（体检重生成会换新 uuid），
      界面如果盯着 plan_id 判断"换了一单"，终稿一到就会把用户弹回第 1 天。
      所以另外用一个只在"真的换了一单"时才涨的序号。 */
  const [viewKey, setViewKey] = useState(0)

  const lastReqRef = useRef<LastRequest | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const mapAbortRef = useRef<AbortController | null>(null)
  /** 交给 loadMap 判断要不要打静态图：交互地图可用时就不必再请求一次 */
  const mapConfigRef = useRef<MapConfig | null>(null)
  /** 用户点了「重新获取」：强制走静态图（交互地图可能因网络/Key 白名单失败） */
  const mapPreferStaticRef = useRef(false)

  /* 生成中显示已等待时长：本地 7B 生成一整份要 1~2 分钟，用户需要知道没卡死 */
  useEffect(() => {
    if (!loading) {
      setElapsed(0)
      return
    }
    const startedAt = Date.now()
    const id = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    )
    return () => window.clearInterval(id)
  }, [loading])

  /* 连接自检：后端 / 本地大模型 / 高德密钥分别是什么状态 */
  const checkHealth = useCallback(async () => {
    try {
      setEnv(await health())
    } catch {
      setEnv(null)
    }
  }, [])

  useEffect(() => {
    void checkHealth()
  }, [checkHealth])

  /* 预热是后端启动后在后台跑的：还在预热时定时刷新，
     让用户知道"再等一会，第一次生成会快很多" */
  useEffect(() => {
    if (env?.ollama_warm?.state !== 'warming') return
    const id = window.setTimeout(() => void checkHealth(), 4000)
    return () => window.clearTimeout(id)
  }, [env, checkHealth])

  /* 交互地图配置：一次就够，失败不阻断（退回静态图） */
  useEffect(() => {
    fetchMapConfig()
      .then((cfg) => {
        mapConfigRef.current = cfg
        setMapConfig(cfg)
        // 提前把高德 JS API 拉下来（约 1MB，异步加载）。
        // 以前是等 PlanMap 挂载才开始下载，也就是等行程排好之后才开始——
        // 于是右栏总比中栏的行程晚几秒才出现，看起来像"地图不跟着规划走"。
        // 拿到配置就预加载，行程一到就能立刻画出来。
        if (cfg.enabled) void loadAmap(cfg).catch(() => {})
      })
      .catch(() => setMapConfig({ enabled: false, key: '', security_code: '' }))
  }, [])

  /* 静态地图：Key 在后端，前端只拿 data URL 与图例 */
  const loadMap = useCallback(async (target: TravelPlan) => {
    // 已经有交互地图了，就没必要再花一次高德 Web服务 额度画静态图。
    // 例外：用户点了「重新获取」——那是交互地图用不了时的兜底入口，
    // 不能再因为"配置说交互地图可用"就什么都不做。
    if (mapConfigRef.current?.enabled && !mapPreferStaticRef.current) return
    mapAbortRef.current?.abort()
    const controller = new AbortController()
    mapAbortRef.current = controller
    setMapLoading(true)
    setMapError(null)
    try {
      const data = await fetchStaticMap(target, controller.signal)
      if (controller.signal.aborted) return // 已被更新的请求取代，丢弃过期结果
      setMapData(data)
    } catch (e) {
      if (controller.signal.aborted) return // 被取代不算失败，别把新结果清掉
      // 地图只是辅助信息，失败不阻断行程展示；但原因要如实告诉用户：
      // 把「高德限流/网络失败」显示成「没配密钥」会让人往错误方向排查。
      setMapData(null)
      setMapError((e as Error).message || '地图获取失败')
    } finally {
      if (mapAbortRef.current === controller) setMapLoading(false)
    }
  }, [])

  const reloadMap = useCallback(() => {
    mapPreferStaticRef.current = true
    if (plan) void loadMap(plan)
  }, [loadMap, plan])

  const run = useCallback(
    async (req: LastRequest) => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      setLoading(true)
      setError(null)
      setSteps([])
      setStageNote(null)
      setChecksSettled(false) // 新的一单：体检要从头跑，先别拿旧结论说事
      setViewKey((k) => k + 1) // 只有"换了一单"才让界面回到第 1 天
      try {
        // 流式生成：行程初稿一到就先渲染出来（体检还要再跑一分钟左右），
        // 之后每次收到新的行程快照都覆盖一次，最终由 done 事件收尾。
        // 用对象持有终稿：赋值发生在回调里，直接写 let 变量会被 TS 收窄成 never
        const finalized: { plan: TravelPlan | null } = { plan: null }
        const onEvent = (event: PlanEvent) => {
          if (event.type === 'step') {
            setSteps((cur) => {
              // 同一个环节的 done 覆盖它的 start，保持列表顺序 = 执行顺序
              const next = cur.filter((s) => s.skill !== event.skill)
              next.push({
                skill: event.skill,
                label: event.label,
                state: event.state,
                seconds: event.seconds,
              })
              return next
            })
            return
          }
          if (event.type === 'plan') {
            setPlan(event.plan)
            setStageNote(`${event.stage}：${event.note}`)
            setDirty(false)
            // 地图跟着行程走，让用户看到点位与轨迹逐步成形（同一版规划只画一次）
            void loadMap(event.plan)
            return
          }
          if (event.type === 'done') {
            finalized.plan = event.plan
            setPlan(event.plan)
            setStageNote(null)
            setDirty(false)
            // 体检到此为止有结论了（结论也可能是"没能完成"，但那也是结论）
            setChecksSettled(true)
            // 终稿同样要让地图跟上：体检可能重排过路线、也可能整份重生成过。
            // 交互地图会随 plan 变化自己重画，静态图则必须在这里再取一次。
            void loadMap(event.plan)
          }
        }

        if (req.kind === 'form') {
          await streamPlanByForm(req.pref, onEvent, controller.signal)
        } else if (req.kind === 'chat') {
          await streamPlanByChat(req.message, req.base, onEvent, controller.signal)
        } else {
          await streamPlanRevise(req.message, req.plan, onEvent, controller.signal)
        }

        if (finalized.plan) {
          window.history.replaceState(null, '', `?plan=${finalized.plan.plan_id}`)
        }
        lastReqRef.current = req
      } catch (e) {
        const err = e as ApiError
        if (err.kind === 'aborted') {
          notify('已取消本次生成')
          return
        }
        setError({ message: err.message || '生成失败', kind: err.kind ?? 'network' })
      } finally {
        setLoading(false)
        setStageNote(null)
        if (abortRef.current === controller) abortRef.current = null
      }
    },
    [loadMap, notify],
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    setLoading(false)
  }, [])

  const retry = useCallback(() => {
    if (lastReqRef.current) void run(lastReqRef.current)
    else if (plan?.user_preference) {
      // 从历史打开的计划没有「本次请求」，但它自带画像，用画像重放即可
      void run({ kind: 'form', pref: plan.user_preference })
    } else notify('请先填写偏好，或输入一句话')
  }, [notify, plan, run])

  const runForm = useCallback((pref: UserPreference) => run({ kind: 'form', pref }), [run])

  const runChat = useCallback(
    (message: string, base?: Partial<UserPreference>) =>
      run({ kind: 'chat', message, base }),
    [run],
  )

  const runRevise = useCallback(
    (message: string) => {
      if (!plan) return
      void run({ kind: 'revise', message, plan })
    },
    [plan, run],
  )

  /** 把某一版规划换成备选池里的另一家（走真实的对话式修改） */
  const swapOption = useCallback(
    (from: string, to: string) => {
      if (!plan) return
      // 用行程里的**具体名称**指代，不说「第 N 天的餐厅」这种笼统说法——
      // 一天可能有好几家餐厅，大模型只能猜，替换就会落到错的那家。
      void run({ kind: 'revise', message: `把「${from}」换成「${to}」，其余保持不变`, plan })
    },
    [plan, run],
  )

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true)
    try {
      setHistory(await listPlans())
    } catch (e) {
      notify((e as Error).message || '获取历史计划失败')
    } finally {
      setHistoryLoading(false)
    }
  }, [notify])

  /** 打开一版规划：兼容旧数据（可能缺新增字段），兜底避免渲染崩溃 */
  const openPlan = useCallback(
    async (id: string, silent = false) => {
      try {
        const p = await getPlan(id)
        const normalized: TravelPlan = {
          ...p,
          dining_options: p.dining_options || [],
          hotel_options: p.hotel_options || [],
          attraction_options: p.attraction_options || [],
          travelers: p.travelers || 1,
          daily_plans: (p.daily_plans || []).map((d) => ({
            ...d,
            hotel: d.hotel || null,
            tips: d.tips || [],
          })),
        }
        setPlan(normalized)
        setDirty(false)
        setError(null)
        // 历史计划里的体检结论是存下来的，直接算「已有结论」
        setChecksSettled(true)
        // 打开了另一份规划：界面回到第 1 天
        setViewKey((k) => k + 1)
        window.history.replaceState(null, '', `?plan=${normalized.plan_id}`)
        void loadMap(normalized)
        if (!silent) notify('已打开历史计划')
      } catch (e) {
        if (!silent) setError({ message: (e as Error).message || '读取计划失败', kind: 'http' })
      }
    },
    [loadMap, notify],
  )

  /* 深链：?plan=<id> 可直接打开某一版规划（便于分享与核对） */
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('plan')
    if (id) void openPlan(id, true)
  }, [openPlan])

  const save = useCallback(async () => {
    if (!plan) return
    try {
      await savePlan(plan)
      setDirty(false)
      notify('已保存')
    } catch (e) {
      notify((e as Error).message || '保存失败')
    }
  }, [notify, plan])

  const exportJson = useCallback(() => {
    if (!plan) return
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `travelplan-${plan.plan_id}.json`
    a.click()
    URL.revokeObjectURL(url)
    notify('已导出 JSON')
  }, [notify, plan])

  /** 本地编辑（移除某个安排）：改完置为待保存，由用户决定是否持久化 */
  const updatePlan = useCallback((updater: (p: TravelPlan) => TravelPlan) => {
    setPlan((cur) => (cur ? updater(cur) : cur))
    setDirty(true)
  }, [])

  return {
    plan,
    loading,
    elapsed,
    error,
    env,
    history,
    historyLoading,
    mapData,
    mapLoading,
    mapError,
    reloadMap,
    mapConfig,
    dirty,
    steps,
    stageNote,
    checksSettled,
    viewKey,
    runForm,
    runChat,
    runRevise,
    swapOption,
    cancel,
    retry,
    refreshHistory,
    openPlan,
    save,
    exportJson,
    updatePlan,
    checkHealth,
    clearError: () => setError(null),
  }
}

export type Planner = ReturnType<typeof usePlanner>
