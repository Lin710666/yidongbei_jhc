// 旅游规划输出模型（与后端 app/models/plan.py 对齐）
import type { UserPreference } from './preference'

export interface Location {
  lat: number
  lng: number
}

export type PoiType = '景点' | '餐厅' | '住宿' | '交通' | '购物'

export interface POI {
  name: string
  type: PoiType
  location: Location
  city: string
  tier: string
  description: string
  tips: string
  price: number | null
  rating: number | null
  check_in: string
  check_out: string
  // 高德 POI 的图片（已统一为 https），供地图悬停卡片使用
  photos?: string[]
  // 下面三项来自高德本来就返回、以前我们没存的字段
  open_time?: string   // 营业时间，如 10:00-22:00
  tags?: string[]      // 招牌菜/标签（来自高德 keytag + atag）
  cuisine?: string     // 菜系，如 海鲜酒楼
}

export interface TransportToNext {
  mode: string
  duration: string
  cost: number
}

export interface Weather {
  condition: string
  temp: string
}

export interface TimelineItem {
  time: string
  poi: POI
  tips: string
  transport_to_next: TransportToNext | null
}

export interface DailyPlan {
  date: string
  weather: Weather
  timeline: TimelineItem[]
  plan_b: string
  tips: string[]
  hotel: POI | null
}

export interface BudgetBreakdown {
  transport: number
  tickets: number
  dining: number
  hotel: number
}

export type CheckCategory = '路径' | '地点' | '重复' | '覆盖' | '时间' | '预算' | '其他'
export type CheckSeverity = 'high' | 'medium' | 'low'

// 规划体检（CheckSkill）发现的一条问题
export interface CheckIssue {
  category: CheckCategory
  severity: CheckSeverity
  message: string
  suggestion: string
}

export interface PlanCheck {
  passed: boolean
  summary: string
  issues: CheckIssue[]
}

export interface TravelPlan {
  plan_id: string
  summary: string
  total_budget_estimate: number
  budget_breakdown: BudgetBreakdown
  daily_plans: DailyPlan[]
  dining_options: POI[]
  hotel_options: POI[]
  attraction_options: POI[]
  travelers: number
  user_budget: number | null
  checks: PlanCheck | null
  // 生成这份规划时用的画像：用于「对话式修改」，改完的画像会跟着新规划一起返回
  user_preference: UserPreference | null
  // 往返大交通的估算口径说明（显示在预算栏）
  transport_note: string
}
