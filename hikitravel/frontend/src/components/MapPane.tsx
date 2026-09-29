import { useState } from 'react'
import type { Planner } from '../hooks/usePlanner'
import { collectHotels, collectPoints } from '../lib/amap'
import { DAY_COLORS } from '../lib/format'
import PlanMap from './PlanMap'

/** 后端图例颜色是「0x1677FF」格式（高德静态图接口用），转成 CSS 写法 */
const toCss = (c: string) => (c?.startsWith('0x') ? '#' + c.slice(2) : c || 'var(--text-3)')

interface Props {
  planner: Planner
  day: number
  theme: 'light' | 'dark'
  focus: string | null
}

/**
 * 右栏：地图铺满整栏、常驻不动（仿 Wanderlog 的右侧地图）。
 *
 * 备选与体检已经移到中栏——右栏只留给地图，
 * 否则地图会被挤成一小块，失去"边看行程边看路线"的意义。
 * 图例改成浮在地图左下角，可收起。
 */
export default function MapPane({ planner, day, theme, focus }: Props) {
  const { plan, mapData, mapLoading, mapError, mapConfig, env, loading } = planner
  // 默认收起：展开的图例会盖住地图一大片，把下面的标记全挡死
  // （高德按坐标命中检测，被 DOM 盖住就收不到鼠标事件）。
  const [legendOpen, setLegendOpen] = useState(false)

  // 还没有规划（生成中，或首次进入还没生成）：以前这里返回一个空的 aside，
  // 右栏就是一整块空白——边上的行程在动、地图一动不动，观感就是"地图坏了"。
  // 现在给一个明确的等待态，说明地图什么时候会出现。
  if (!plan) {
    return (
      <aside className="pane pane--right">
        <div className="map-canvas map-canvas--fill">
          <div className="map-placeholder">
            <div>
              <p style={{ margin: 0 }}>
                {loading ? '正在生成行程，地图会在行程排好后自动出现' : '还没有行程，生成后会在这里显示地图'}
              </p>
            </div>
          </div>
        </div>
      </aside>
    )
  }

  const interactive = Boolean(mapConfig?.enabled)
  const points = collectPoints(plan)
  const hotels = collectHotels(plan)
  const legendItems = interactive
    ? [
        ...points.map((p, i) => ({
          key: `poi-${p.name}-${i}`,
          label: String(i + 1),
          name: p.name,
          day: p.day,
          color: DAY_COLORS[p.day % 6],
          dim: p.day !== day,
          hotel: false,
        })),
        // 酒店不在时间轴里，但地图上有标记，图例也得有，否则编号对不上
        ...hotels.map((h, i) => ({
          key: `hotel-${h.name}-${i}`,
          label: '住',
          name: h.name,
          day: h.day,
          color: '#5856d6',
          dim: h.day !== day,
          hotel: true,
        })),
      ]
    : (mapData?.legend ?? []).map((item, i) => ({
        key: `${item.label}-${i}`,
        label: item.label,
        name: item.name,
        day: item.day_index ?? 0,
        color: toCss(item.color),
        dim: false,
        hotel: item.type === '住宿',
      }))

  return (
    <aside className="pane pane--right">
      <PlanMap
        plan={plan}
        day={day}
        theme={theme}
        config={mapConfig}
        focus={focus}
        fallback={
          <div className="map-canvas map-canvas--fill">
            {mapData ? (
              <img src={mapData.image} alt="路线地图" />
            ) : (
              <div className="map-placeholder">
                <div>
                  <p style={{ margin: 0 }}>
                    {mapLoading
                      ? '地图生成中…'
                      : env && !env.amap_configured
                        ? '未配置高德密钥，无法生成地图'
                        : mapError || '未获取到地图'}
                  </p>
                  {!mapLoading && (
                    <button
                      className="btn btn--link"
                      style={{ marginTop: 8 }}
                      onClick={planner.reloadMap}
                    >
                      重新获取
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        }
      />

      {legendItems.length > 0 && (
        <div className={`map-legend ${legendOpen ? '' : 'map-legend--collapsed'}`}>
          <div className="map-legend__head" onClick={() => setLegendOpen((o) => !o)}>
            <span>图例 · {legendItems.length} 个地点</span>
            <span className="faint">{legendOpen ? '收起' : '展开'}</span>
          </div>
          {legendOpen && (
            <div className="map-legend__body">
              {legendItems.map((it) => (
                <div className="legend__item" key={it.key}>
                  <span
                    className={`legend__idx ${it.hotel ? 'legend__idx--hotel' : ''}`}
                    style={{ background: it.color, opacity: it.dim ? 0.45 : 1 }}
                  >
                    {it.label}
                  </span>
                  <span className="legend__name">{it.name}</span>
                  <span className="legend__day">{it.hotel ? '住宿' : `第 ${it.day + 1} 天`}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
