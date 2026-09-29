// 后端 API 封装
import type { UserPreference } from '../types/preference'
import type { PlanCheck, TravelPlan } from '../types/plan'

const BASE = '/api'

// 本地 7B 大模型生成一份规划要 1~3 分钟，超时给足；超时后前端会提示重试
const PLAN_TIMEOUT_MS = 300_000
const SHORT_TIMEOUT_MS = 10_000

export type ApiErrorKind = 'network' | 'timeout' | 'http' | 'aborted'

/** 生成过程中的一步（后端每完成一个 Skill 推一条） */
export interface PlanStep {
  skill: string
  label: string
  state: 'start' | 'done'
  seconds?: number
}

/**
 * 生成过程中的进度事件（后端以 SSE 推送）。
 *
 * - step：某个环节开始/结束（带耗时）
 * - plan：一份可以立刻渲染的行程快照。体检很慢，所以先发初稿、再发路线优化稿，
 *   用户不用等体检跑完才看到行程
 * - done：最终规划 + 体检结论
 * - error：失败原因（流式响应一开始就返回 200，所以错误只能走事件）
 */
export type PlanEvent =
  | ({ type: 'step' } & PlanStep)
  | { type: 'plan'; stage: string; note: string; plan: TravelPlan }
  | { type: 'done'; plan: TravelPlan; checks: PlanCheck | null }
  | { type: 'error'; kind: ApiErrorKind; message: string }

/** 带类型的请求错误：前端据此决定提示文案与是否显示「重试 / 检查连接」 */
export class ApiError extends Error {
  kind: ApiErrorKind
  status?: number

  constructor(message: string, kind: ApiErrorKind, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
  }
}

interface RequestOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

async function post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? PLAN_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false

  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forwardAbort = () => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort)

  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new ApiError(
        (data as { detail?: string }).detail || `请求失败 (${res.status})`,
        'http',
        res.status,
      )
    }
    return (await res.json()) as T
  } catch (e) {
    if (e instanceof ApiError) throw e
    if (timedOut) {
      throw new ApiError(
        `等待超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回，可能是本地大模型正在加载或已经断开。` +
          '请确认后端服务与 Ollama 仍在运行，然后重试。',
        'timeout',
      )
    }
    if (options.signal?.aborted) {
      throw new ApiError('已取消本次生成。', 'aborted')
    }
    throw new ApiError(
      '网络异常或后端已断开：请确认后端服务与本地大模型（Ollama）正在运行，然后重试。',
      'network',
    )
  } finally {
    window.clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}

/**
 * 读取后端的 SSE 事件流并逐条回调。
 *
 * 为什么不用浏览器原生的 EventSource：EventSource 只能发 GET、不能带请求体，
 * 而生成规划必须提交完整画像/规划。所以用 fetch + ReadableStream 自己拆 SSE 帧
 * （帧格式就是 `data: {json}` + 空行）。
 */
async function streamPlan(
  path: string,
  body: unknown,
  onEvent: (event: PlanEvent) => void,
  signal?: AbortSignal,
  timeoutMs = PLAN_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forwardAbort = () => controller.abort()
  signal?.addEventListener('abort', forwardAbort)

  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}))
      throw new ApiError(
        (data as { detail?: string }).detail || `请求失败 (${res.status})`,
        'http',
        res.status,
      )
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let sep = buffer.indexOf('\n\n')
      while (sep >= 0) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          let event: PlanEvent
          try {
            event = JSON.parse(line.slice(5).trim()) as PlanEvent
          } catch {
            continue // 半包/坏帧：跳过，等下一帧
          }
          if (event.type === 'error') {
            // 流式响应一开始就是 200，业务失败只能靠事件传达；
            // 这里转成 ApiError，让调用方的错误处理与非流式接口完全一致。
            await reader.cancel().catch(() => {})
            throw new ApiError(event.message, event.kind)
          }
          onEvent(event)
        }
        sep = buffer.indexOf('\n\n')
      }
    }
  } catch (e) {
    if (e instanceof ApiError) throw e
    if (timedOut) {
      throw new ApiError(
        `等待超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回，可能是本地大模型正在加载或已经断开。` +
          '请确认后端服务与 Ollama 仍在运行，然后重试。',
        'timeout',
      )
    }
    if (signal?.aborted) throw new ApiError('已取消本次生成。', 'aborted')
    throw new ApiError(
      '网络异常或后端已断开：请确认后端服务与本地大模型（Ollama）正在运行，然后重试。',
      'network',
    )
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

/** 表单模式（流式）：边生成边回调进度与行程快照 */
export function streamPlanByForm(
  pref: Partial<UserPreference>,
  onEvent: (event: PlanEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamPlan('/plan/stream', { preference: pref }, onEvent, signal)
}

/** 对话模式（流式） */
export function streamPlanByChat(
  message: string,
  base: Partial<UserPreference> | undefined,
  onEvent: (event: PlanEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamPlan(
    '/chat/stream',
    { message, preference: base && Object.keys(base).length > 0 ? base : undefined },
    onEvent,
    signal,
  )
}

/** 对话式修改（流式） */
export function streamPlanRevise(
  message: string,
  plan: TravelPlan,
  onEvent: (event: PlanEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamPlan('/plan/revise/stream', { message, plan }, onEvent, signal)
}

// 说明：生成规划一律走上面的 streaming 版本（后端 SSE）。
// 后端仍保留非流式的 /api/plan、/api/chat、/api/plan/revise 三个接口，
// 供 backend/scripts/live_smoke.py 这类不走浏览器的场景使用。
/** 启动预热里的一步（在某个模型上预填一段提示词） */
export interface WarmTask {
  label: string
  model: string
  ok: boolean
  seconds: number
  error: string
}

/**
 * 启动预热进度。
 *
 * 后端在启动时后台加载模型并把各 Skill 的系统提示词预填进 Ollama 的上下文缓存，
 * 这样用户第一次点「生成」就是稳态速度（实测 108s → 44s）。
 * state=warming 时可以提示用户「再等一会更快」。
 */
export interface WarmStatus {
  state: 'idle' | 'warming' | 'ready' | 'partial' | 'failed' | 'off'
  done: number
  total: number
  detail: string
  seconds: number
  tasks: WarmTask[]
}

export interface Health {
  status: string
  ollama_available: boolean
  amap_configured: boolean
  ollama_warm: WarmStatus
}

// 地图图例：与高德静态地图上的编号标记一一对应
export interface MapLegendItem {
  label: string
  name: string
  type: string
  date: string
  time: string
  day_index: number
  color: string
}

export interface StaticMapData {
  /** 高德静态地图（真实底图 + 标记 + 每日轨迹），data URL 形式 */
  image: string
  legend: MapLegendItem[]
  zoom: number
  center: string
}

/** 取高德静态地图：后端代理请求（Key 不出现在浏览器），返回图片与图例 */
export function fetchStaticMap(
  plan: TravelPlan,
  signal?: AbortSignal,
): Promise<StaticMapData> {
  return post<StaticMapData>('/map/static', { plan }, { signal, timeoutMs: 30_000 })
}

/** 连接自检：后端在不在、Ollama 在不在、高德配没配 */
export async function health(): Promise<Health> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), SHORT_TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}/health`, { signal: controller.signal })
    if (!res.ok) throw new ApiError(`健康检查失败 (${res.status})`, 'http', res.status)
    return (await res.json()) as Health
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError('连不上后端服务（/api/health 无响应），请确认后端已启动。', 'network')
  } finally {
    window.clearTimeout(timer)
  }
}

export interface PlanSummary {
  plan_id: string
  summary: string
  created_at: string
}

/** 目的地输入提示的一个候选 */
export interface PlaceTip {
  name: string
  district: string
  adcode: string
  kind: '行政区' | '地点'
  lat: number | null
  lng: number | null
}

/** 目的地输入提示：由后端代理高德，Key 不出现在浏览器 */
export async function autocompletePlaces(
  q: string,
  signal?: AbortSignal,
  city = '',
): Promise<PlaceTip[]> {
  // city 用于把候选限制在目的地城市内（必去景点的选择器需要，
  // 否则「平潭」这种同名地点会跨省混进来）
  const cityParam = city ? `&city=${encodeURIComponent(city)}` : ''
  const res = await fetch(
    `${BASE}/places/autocomplete?q=${encodeURIComponent(q)}${cityParam}`,
    { signal },
  )
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(
      (data as { detail?: string }).detail || `候选获取失败 (${res.status})`,
      'http',
      res.status,
    )
  }
  return res.json()
}

/**
 * 「必去景点」的下拉候选：只包含真正的景点。
 *
 * 与上面的 autocompletePlaces（高德 inputtips）的区别：那个接口不认类型，
 * 同一个词「长江澳」会返回「自然地名·海湾海峡」（坐标是海湾中心，标在地图上
 * 落在海里）和好几个停车场。这个接口由后端按「景点分类码」过滤，
 * 返回的都是风景名胜/公园/场馆，并且自带评分与实拍图。
 */
export interface AttractionTip {
  name: string
  district: string
  adcode: string
  lat: number | null
  lng: number | null
  rating: number | null
  address: string
  photos: string[]
}

export async function searchAttractions(
  q: string,
  city: string,
  signal?: AbortSignal,
): Promise<AttractionTip[]> {
  const cityParam = city ? `&city=${encodeURIComponent(city)}` : ''
  const res = await fetch(
    `${BASE}/places/attractions?q=${encodeURIComponent(q)}${cityParam}`,
    { signal },
  )
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(
      (data as { detail?: string }).detail || `候选获取失败 (${res.status})`,
      'http',
      res.status,
    )
  }
  return res.json()
}

/** 交互地图（高德 JS API）的运行时配置。未配置时 enabled=false，前端退回静态地图 */
export interface MapConfig {
  enabled: boolean
  key: string
  security_code: string
}

export async function fetchMapConfig(signal?: AbortSignal): Promise<MapConfig> {
  const res = await fetch(`${BASE}/map/config`, { signal })
  if (!res.ok) throw new ApiError('获取地图配置失败', 'http', res.status)
  return res.json()
}

// 历史计划列表
export async function listPlans(): Promise<PlanSummary[]> {
  const res = await fetch(`${BASE}/plans`)
  if (!res.ok) throw new ApiError('获取历史计划失败', 'http', res.status)
  return res.json()
}

// 按 ID 读取一条历史计划
export async function getPlan(id: string): Promise<TravelPlan> {
  const res = await fetch(`${BASE}/plans/${id}`)
  if (!res.ok) throw new ApiError('读取计划失败', 'http', res.status)
  return res.json()
}

// 保存（覆盖）编辑后的规划，供下次从历史计划打开
export function savePlan(plan: TravelPlan): Promise<{ ok: boolean; plan_id?: string }> {
  return post('/plans/save', plan, { timeoutMs: SHORT_TIMEOUT_MS })
}
