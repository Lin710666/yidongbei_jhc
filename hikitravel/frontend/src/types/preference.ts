// 用户画像输入模型（与后端 app/models/preference.py 对齐）

export type Pace = '悠闲' | '适中' | '特种兵'
export type Transportation = '自驾' | '高铁' | '飞机' | '本地'

export interface Travelers {
  adults: number
  children: number
  elderly: number
}

/**
 * 特别想去的景点。
 *
 * 从下拉里选定具体地点时会带上 adcode 与坐标——坐标是权威，后端直接用，
 * 不再拿名字去高德猜（同名景区会搜到别处）。手输的只有 name，坐标留空。
 */
export interface MustVisit {
  name: string
  adcode: string
  lat: number | null
  lng: number | null
}

export interface UserPreference {
  travelers: Travelers
  duration_days: number
  destination: string
  // 从下拉里选定具体地点时带上高德 adcode：它是高德的主键，
  // 后端按它解析，不受「省+地名」写法影响，也没有同名歧义
  destination_adcode: string
  transportation: Transportation
  // 空数组 = 用户没表达兴趣，后端按「全部类别」检索（不再由大模型推断）
  preferences: string[]
  must_visit: MustVisit[]
  pace: Pace
  budget: number
  dietary_restrictions: string[]
  start_date: string
  departure_time: string
  return_hotel_time: string
}
