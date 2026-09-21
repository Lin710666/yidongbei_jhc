// 用户画像输入模型（与后端 app/models/preference.py 对齐）

export type Pace = '悠闲' | '适中' | '特种兵'
export type Transportation = '自驾' | '高铁' | '飞机' | '本地'
export type Priority = '吃' | '住' | '行' | '玩'

export interface Travelers {
  adults: number
  children: number
  elderly: number
}

export interface UserPreference {
  travelers: Travelers
  duration_days: number
  origin: string
  destination: string
  transportation: Transportation
  preferences: string[]
  must_visit: string[]
  pace: Pace
  has_pet: boolean
  budget: number
  priority: Priority
  dietary_restrictions: string[]
  avoidances: string[]
  start_date: string
  departure_time: string
  return_hotel_time: string
}
