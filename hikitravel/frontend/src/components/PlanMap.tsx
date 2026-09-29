import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  collectHotels,
  collectPoints,
  hotelKey,
  loadAmap,
  poiKey,
  type AmapConfig,
  type MapPoint,
} from '../lib/amap'
import { DAY_COLORS, fmt } from '../lib/format'
import type { TravelPlan } from '../types/plan'

interface Props {
  plan: TravelPlan
  day: number
  theme: 'light' | 'dark'
  config: AmapConfig | null
  /** 左侧行程项选中的点：地图飞过去并高亮它 */
  focus: string | null
  /** 用不了交互地图时渲染它（静态图 / 提示），保证不开天窗 */
  fallback: ReactNode
}

/** 高德内置的深色样式，和应用的深色令牌观感一致 */
const STYLE = { light: 'amap://styles/normal', dark: 'amap://styles/dark' }

/** 标记外观：当天实色、其他天淡化，被选中的那个放大并且最上层 */
function pinHtml(index: number, point: MapPoint, active: boolean, focused: boolean): string {
  const size = focused ? 34 : active ? 26 : 22
  const opacity = focused || active ? 1 : 0.45
  return (
    `<div class="amap-pin" style="background:${DAY_COLORS[point.day % 6]};opacity:${opacity};` +
    `width:${size}px;height:${size}px;line-height:${size - 4}px;font-size:${focused ? 15 : 13}px">` +
    `${index + 1}</div>`
  )
}

/** 酒店标记：圆角方块 + 「住」字，和时间轴的编号圆点区分开 */
function hotelHtml(active: boolean, focused = false): string {
  const size = focused ? 32 : active ? 26 : 22
  return (
    `<div class="amap-hotel" style="opacity:${active || focused ? 1 : 0.45};` +
    `width:${size}px;height:${size}px;line-height:${size - 4}px">住</div>`
  )
}

/** 悬停卡片的数据：景点/餐厅/酒店统一成这一种结构 */
interface HoverPayload {
  name: string
  type: string
  rating: number | null
  price: number | null
  photos: string[]
  day: number
  time: string
}

export default function PlanMap({ plan, day, theme, config, focus, fallback }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const amapRef = useRef<any>(null)
  /** 标记与它对应的点：飞行定位与高亮都要靠它 */
  const markersRef = useRef<Array<{ marker: any; point: MapPoint; index: number; key: string }>>([])
  const hotelsRef = useRef<Array<{ marker: any; hotel: ReturnType<typeof collectHotels>[number]; key: string }>>([])
  const linesRef = useRef<any[]>([])
  /** 覆盖物 effect 不该因为 focus 变化而重建，用 ref 取当前值 */
  const focusRef = useRef<string | null>(focus)
  focusRef.current = focus
  const [failed, setFailed] = useState<string | null>(null)
  /** 地图实例是否已就绪。JSAPI 是异步加载的，画覆盖物的 effect 必须等它。 */
  const [ready, setReady] = useState(false)
  const [hover, setHover] = useState<{ payload: HoverPayload; x: number; y: number } | null>(null)

  /* 初始化地图：只在配置可用时执行一次 */
  useEffect(() => {
    if (!config?.enabled) {
      setReady(false)
      return
    }
    if (!boxRef.current) return
    // 地图已经建好了（例如换了日期、改了规划）：直接标记就绪。
    // 这里曾经写成 `|| mapRef.current` 就 return，而 cleanup 又把 ready 置回 false，
    // 结果每次 revise 之后 ready 永远停在 false，画覆盖物的 effect 再也不执行——
    // 表现就是「替换一次之后地图上的路线再也不更新」。
    if (mapRef.current) {
      setReady(true)
      return
    }
    let cancelled = false
    const points = collectPoints(plan)

    loadAmap(config)
      .then((AMap) => {
        if (cancelled || !boxRef.current) return
        amapRef.current = AMap
        const first = points[0]
        mapRef.current = new AMap.Map(boxRef.current, {
          zoom: 11,
          center: first ? [first.lng, first.lat] : [116.397428, 39.90923],
          viewMode: '2D',
          mapStyle: STYLE[theme],
        })
        setReady(true) // 触发下面的覆盖物绘制
        setFailed(null)
      })
      .catch((e) => {
        if (!cancelled) setFailed(e?.message || '地图初始化失败')
      })

    return () => {
      cancelled = true
    }
    // theme 只在下面单独更新，避免重建地图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, plan.plan_id])

  /* 主题切换：高德换样式比重建地图便宜得多 */
  useEffect(() => {
    mapRef.current?.setMapStyle(STYLE[theme])
  }, [theme])

  /* 重画标记与路线：跟随当天选择 */
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    let cancelled = false

    loadAmap(config as AmapConfig).then((AMap) => {
      if (cancelled || !mapRef.current) return
      if (markersRef.current.length) map.remove(markersRef.current.map((m) => m.marker))
      if (hotelsRef.current.length) map.remove(hotelsRef.current.map((h) => h.marker))
      if (linesRef.current.length) map.remove(linesRef.current)
      markersRef.current = []
      hotelsRef.current = []
      linesRef.current = []

      const points = collectPoints(plan)
      const hotels = collectHotels(plan)
      const shown = points.filter((p) => p.day === day)

      /** 标记在自己容器里的像素坐标 -> 屏幕坐标，卡片靠它定位 */
      const pixelOf = (e: any) => {
        const rect = boxRef.current?.getBoundingClientRect()
        if (!rect) return null
        const px = typeof e?.pixel?.getX === 'function' ? e.pixel.getX() : 0
        const py = typeof e?.pixel?.getY === 'function' ? e.pixel.getY() : 0
        return { x: rect.left + px, y: rect.top + py }
      }

      points.forEach((p, i) => {
        const active = p.day === day
        const key = poiKey(p.lng, p.lat)
        const focused = focusRef.current === key
        const size = focused ? 34 : active ? 26 : 22
        const marker = new AMap.Marker({
          position: [p.lng, p.lat],
          zIndex: focused ? 200 : active ? 120 : 100,
          opacity: active ? 1 : 0.4,
          offset: new AMap.Pixel(-size / 2, -size / 2),
          content: pinHtml(i, p, active, focused),
        })

        // 悬停弹卡片：位置取自标记在自己容器里的像素坐标
        marker.on('mouseover', (e: any) => {
          const at = pixelOf(e)
          if (at)
            setHover({
              payload: {
                name: p.name,
                type: p.type,
                rating: p.rating,
                price: p.price,
                photos: p.photos,
                day: p.day,
                time: p.time,
              },
              ...at,
            })
        })
        marker.on('mouseout', () => setHover(null))

        markersRef.current.push({ marker, point: p, index: i, key })
      })

      // 每晚酒店单独打点：它不在 timeline 里，但同样要能看能点
      hotels.forEach((h) => {
        const active = h.day === day
        const key = hotelKey(h.day)
        const focused = focusRef.current === key
        const size = focused ? 32 : active ? 26 : 22
        const marker = new AMap.Marker({
          position: [h.lng, h.lat],
          zIndex: focused ? 200 : active ? 115 : 95,
          opacity: active ? 1 : 0.4,
          offset: new AMap.Pixel(-size / 2, -size / 2),
          content: hotelHtml(active, focused),
        })
        marker.on('mouseover', (e: any) => {
          const at = pixelOf(e)
          if (at)
            setHover({
              payload: {
                name: h.name,
                type: '住宿',
                rating: h.rating,
                price: h.price,
                photos: h.photos,
                day: h.day,
                time: h.checkIn ? `${h.checkIn} 入住` : '当晚住宿',
              },
              ...at,
            })
        })
        marker.on('mouseout', () => setHover(null))
        hotelsRef.current.push({ marker, hotel: h, key })
      })

      // 按天连成轨迹：当天用实色，其余天淡化，一眼能看出"今天走哪条线"
      PLAN_DAYS(plan).forEach((pts, di) => {
        if (pts.length < 2) return
        linesRef.current.push(
          new AMap.Polyline({
            path: pts.map((p) => [p.lng, p.lat]),
            strokeColor: DAY_COLORS[di % 6],
            strokeWeight: di === day ? 5 : 3,
            strokeOpacity: di === day ? 1 : 0.35,
            lineJoin: 'round',
            zIndex: di === day ? 110 : 90,
          }),
        )
      })

      markersRef.current.forEach((m) => m.marker.setMap(map))
      hotelsRef.current.forEach((h) => h.marker.setMap(map))
      linesRef.current.forEach((l) => l.setMap(map))

      // 预热图片：悬停卡片是临时元素，等它出现再下载就来不及了
      // （卡片本身也去掉了 loading="lazy"，两者配合才能一悬停就有图）。
      ;[...points, ...hotels].forEach((p) =>
        (p.photos ?? []).slice(0, 3).forEach((src) => {
          if (!src) return
          const img = new Image()
          img.src = src
        }),
      )

      // 视野要把当天的酒店一起框进来。
      // 之前只框景点，酒店常常落在视野外（实测有酒店被甩到画布左上角外 900+ 像素），
      // 用户要么找不到、要么得拖很远才看见，直观印象就是「酒店离得特别远」。
      const fitTargets = markersRef.current
        .filter((m) => m.point.day === day)
        .map((m) => m.marker)
      const dayHotel = hotelsRef.current.find((h) => h.hotel.day === day)
      if (dayHotel) fitTargets.push(dayHotel.marker)
      if (fitTargets.length) map.setFitView(fitTargets, false, [70, 70, 70, 70])
    }).catch((e: Error) => {
      /* 上面初始化那次是带 catch 的，这里原来漏了。
         高德脚本加载失败（Key 平台类型不对、安全域名不在白名单、内网被墙）时，
         漏掉 catch 会变成 unhandled rejection：failed 不置位、fallback 也就不渲染，
         用户只看到一块**空白**地图，连「重新获取」按钮都不出现。
         补上 catch，失败就走静态图 / 占位那条正常的降级路径。 */
      if (!cancelled) setFailed(e?.message || '地图加载失败')
    })

    return () => {
      cancelled = true
    }
  }, [plan, day, config, ready])

  /* 左侧选中卡片（行程项或酒店）→ 地图飞过去并高亮那一个标记 */
  useEffect(() => {
    const map = mapRef.current
    const AMap = amapRef.current
    if (!map || !AMap || !ready) return

    markersRef.current.forEach(({ marker, point, index, key }) => {
      const active = point.day === day
      const focused = focus === key
      const size = focused ? 34 : active ? 26 : 22
      marker.setContent(pinHtml(index, point, active, focused))
      marker.setOffset(new AMap.Pixel(-size / 2, -size / 2))
      marker.setzIndex(focused ? 200 : active ? 120 : 100)
    })

    hotelsRef.current.forEach(({ marker, hotel, key }) => {
      const active = hotel.day === day
      const focused = focus === key
      const size = focused ? 32 : active ? 26 : 22
      marker.setContent(hotelHtml(active, focused))
      marker.setOffset(new AMap.Pixel(-size / 2, -size / 2))
      marker.setzIndex(focused ? 200 : active ? 115 : 95)
    })

    if (focus == null) return
    const target =
      markersRef.current.find((m) => m.key === focus)?.point ??
      hotelsRef.current.find((h) => h.key === focus)?.hotel
    if (!target) return
    map.setZoomAndCenter(Math.max(map.getZoom(), 14), [target.lng, target.lat], false, 420)
  }, [focus, day, ready])

  /* 卸载时销毁，避免切页面后地图实例泄漏 */
  useEffect(
    () => () => {
      mapRef.current?.destroy?.()
      mapRef.current = null
      setReady(false)
    },
    [],
  )

  if (!config?.enabled || failed) return <>{fallback}</>

  // 卡片贴着标记上方弹出；靠近屏幕边缘时往内收，别被裁掉
  const cardX = hover ? Math.min(Math.max(hover.x, 150), window.innerWidth - 150) : 0

  return (
    <>
      <div className="map-canvas map-canvas--fill" ref={boxRef} />
      {hover &&
        createPortal(
          <div className="poi-card" style={{ left: cardX, top: hover.y - 16 }}>
            {hover.payload.photos.length > 0 && (
              <div className="poi-card__photos">
                {hover.payload.photos.slice(0, 3).map((src, k) => (
                  <img
                    key={k}
                    src={src}
                    alt=""
                    decoding="async"
                    // 单张图挂了就藏起来，别在卡片里留个破图标
                    onError={(e) => {
                      e.currentTarget.style.display = 'none'
                    }}
                  />
                ))}
              </div>
            )}
            <div className="poi-card__body">
              <b>{hover.payload.name}</b>
              <span className="meta">
                {hover.payload.type}
                {hover.payload.rating ? ` · ★${hover.payload.rating}` : ''}
                {hover.payload.price ? ` · ${fmt(hover.payload.price)}` : ''}
                {` · 第 ${hover.payload.day + 1} 天 ${hover.payload.time}`}
              </span>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

function PLAN_DAYS(plan: TravelPlan) {
  return plan.daily_plans.map((d) =>
    d.timeline
      .map((t) => t.poi?.location)
      .filter((l) => l && typeof l.lat === 'number' && typeof l.lng === 'number'),
  )
}
