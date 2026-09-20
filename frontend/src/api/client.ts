// 后端 API 封装
import type { UserPreference } from '../types/preference'
import type { TravelPlan } from '../types/plan'

const BASE = '/api'

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error((data as { detail?: string }).detail || `请求失败 (${res.status})`)
  }
  return res.json()
}

// 表单模式：提交结构化画像（允许不完整，后端用默认值补齐，零解析歧义）
export function planByForm(pref: Partial<UserPreference>, applySuggestions = false): Promise<TravelPlan> {
  return post<TravelPlan>('/plan', { preference: pref, apply_suggestions: applySuggestions })
}

// 对话模式：自然语言尽力而为解析（辅助路径）
// base 为表单已填的部分画像，作为「底」提交：表单精确字段优先，对话只补缺
export function planByChat(
  message: string,
  applySuggestions = false,
  base?: Partial<UserPreference>,
): Promise<TravelPlan> {
  return post<TravelPlan>('/chat', {
    message,
    apply_suggestions: applySuggestions,
    preference: base && Object.keys(base).length > 0 ? base : undefined,
  })
}

export interface Health {
  status: string
  ollama_available: boolean
  amap_configured: boolean
}

export async function health(): Promise<Health> {
  const res = await fetch(`${BASE}/health`)
  return res.json()
}

export interface PlanSummary {
  plan_id: string
  summary: string
  created_at: string
}

// 历史计划列表
export async function listPlans(): Promise<PlanSummary[]> {
  const res = await fetch(`${BASE}/plans`)
  if (!res.ok) throw new Error('获取历史计划失败')
  return res.json()
}

// 按 ID 读取一条历史计划
export async function getPlan(id: string): Promise<TravelPlan> {
  const res = await fetch(`${BASE}/plans/${id}`)
  if (!res.ok) throw new Error('读取计划失败')
  return res.json()
}

// 保存（覆盖）编辑后的规划，供下次从历史计划打开
export function savePlan(plan: TravelPlan): Promise<{ ok: boolean; plan_id?: string }> {
  return post('/plans/save', plan)
}
