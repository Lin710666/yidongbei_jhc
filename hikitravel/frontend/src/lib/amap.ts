/**
 * 高德 JS API 加载器。
 *
 * 为什么要自己加载而不是在 index.html 里写死 script：
 * 没配置 Key 的环境不该白白下载一个用不上的 1MB 脚本，
 * 而且换 Key 不用重新构建前端（配置由后端 /api/map/config 下发）。
 */

export interface AmapConfig {
  enabled: boolean
  key: string
  security_code: string
}

/** 全局只加载一次：并发调用共享同一个 Promise，避免重复注入 script */
let pending: Promise<any> | null = null

export function amapAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).AMap)
}

export function loadAmap(config: AmapConfig): Promise<any> {
  if (amapAvailable()) return Promise.resolve((window as any).AMap)
  if (pending) return pending

  pending = new Promise((resolve, reject) => {
    // 安全密钥必须在 JSAPI 脚本加载之前挂到 window，否则鉴权会失败
    ;(window as any)._AMapSecurityConfig = { securityJsCode: config.security_code }

    const script = document.createElement('script')
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(config.key)}`
    script.async = true
    script.onload = () => {
      const amap = (window as any).AMap
      if (amap) resolve(amap)
      else reject(new Error('高德地图脚本已加载，但没有挂载 AMap 对象'))
    }
    script.onerror = () => {
      reject(new Error('高德地图脚本加载失败（检查网络或 Key 的平台类型）'))
    }
    document.head.appendChild(script)
  }).catch((e: Error) => {
    /* 失败一律清掉缓存。
       原来只在 onerror 里清 —— 而「脚本加载成功了、但没挂上 AMap 对象」那条分支
       （比如安全域名不在白名单里）会把 rejected 的 Promise 永久缓存住：
       之后每次 loadAmap 都立刻拿到同一个失败，地图这一轮会话彻底起不来，
       连界面上的「重新获取」都救不回。统一在这里清，两条失败路径就都能重试了。 */
    pending = null
    throw e
  })
  return pending
}

/** 每个点的经纬度，直接取自规划里的 POI（后端已经带坐标，无需再调接口） */
export interface MapPoint {
  lng: number
  lat: number
  name: string
  day: number
  /** 在当天 timeline 里的下标：用来把左侧行程项和地图标记对上 */
  itemIndex: number
  time: string
  type: string
  rating: number | null
  price: number | null
  photos: string[]
}

export function collectPoints(plan: {
  daily_plans: Array<{
    timeline: Array<{
      time: string
      poi: {
        name: string
        type?: string
        rating?: number | null
        price?: number | null
        photos?: string[]
        location: { lat: number; lng: number }
      }
    }>
  }>
}): MapPoint[] {
  const out: MapPoint[] = []
  plan.daily_plans.forEach((d, di) => {
    d.timeline.forEach((item, ii) => {
      const loc = item.poi?.location
      if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return
      out.push({
        lng: loc.lng,
        lat: loc.lat,
        name: item.poi.name,
        day: di,
        itemIndex: ii,
        time: item.time,
        type: item.poi.type ?? '景点',
        rating: item.poi.rating ?? null,
        price: item.poi.price ?? null,
        photos: item.poi.photos ?? [],
      })
    })
  })
  return out
}

/**
 * 地图元素的唯一键。
 *
 * 早先这里用的是「数组下标」，但酒店不在时间轴里、不占行程点序号，
 * 加进来之后下标就对不上了——所以改成显式键，行程点和酒店各有一套命名，
 * 以后再加别的图层（比如备选点）也只需补一个前缀。
 *
 * 行程点后来又踩了一次：用「第几天:下标」当身份，两种情况都会指错人——
 *   ① 本地删掉一项，后面所有项的下标整体前移，界面里存着的旧键就落到了邻居身上；
 *   ② 后台体检会就地优化路线顺序（重排 timeline），行程内容没变但下标变了。
 * 现在改成「位置即身份」：同一个经纬度在任何一次重排里都还是同一个点，
 * 删除、重排、甚至被挪到另一天都不会认错（真被挪走时只会失焦，不会跳错地方）。
 */
export const poiKey = (lng: number, lat: number) => `poi:${lng},${lat}`
export const hotelKey = (day: number) => `hotel:${day}`

/** 每晚酒店：独立于时间轴（酒店不在 timeline 里），单独打点和展示 */
export interface MapHotel {
  day: number
  name: string
  lng: number
  lat: number
  rating: number | null
  price: number | null
  photos: string[]
  checkIn: string
  checkOut: string
}

export function collectHotels(plan: {
  daily_plans: Array<{
    hotel?: {
      name: string
      rating?: number | null
      price?: number | null
      photos?: string[]
      check_in?: string
      check_out?: string
      location?: { lat: number; lng: number }
    } | null
  }>
}): MapHotel[] {
  const out: MapHotel[] = []
  plan.daily_plans.forEach((d, di) => {
    const h = d.hotel
    const loc = h?.location
    if (!h || !loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return
    out.push({
      day: di,
      name: h.name,
      lng: loc.lng,
      lat: loc.lat,
      rating: h.rating ?? null,
      price: h.price ?? null,
      photos: h.photos ?? [],
      checkIn: h.check_in ?? '',
      checkOut: h.check_out ?? '',
    })
  })
  return out
}
