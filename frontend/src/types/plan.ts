// 旅游规划输出模型（与后端 app/models/plan.py 对齐）

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
  check_in: string
  check_out: string
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

export interface Conflict {
  id: string
  message: string
  suggestion: string
  field: string | null
  suggested_value: unknown
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
  warnings: string[]
  conflicts: Conflict[]
}
