import { useMemo, useState } from 'react'
import { Alert, Button, Card, Space, Tag, theme } from 'antd'
import type { Location, POI, TravelPlan } from '../types/plan'
import { useAppJump, type AppTarget } from '../hooks/useAppJump'

const W = 640
const H = 400
const PAD = 36

// 收集规划中所有含有效坐标的 POI
function collectPoints(plan: TravelPlan): POI[] {
  const out: POI[] = []
  const seen = new Set<string>()
  const push = (p: POI) => {
    if (p.location.lat === 0 && p.location.lng === 0) return
    const key = `${p.name}@${p.location.lat},${p.location.lng}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(p)
  }
  // 先排行程 POI（保持首点为起点），再排每晚酒店
  for (const d of plan.daily_plans) for (const item of d.timeline) push(item.poi)
  for (const d of plan.daily_plans) if (d.hotel) push(d.hotel)
  return out
}

// 经纬度 -> SVG 画布坐标（简单等距投影，足够展示相对位置与轨迹）
function buildProjector(pts: Location[]) {
  const lats = pts.map((p) => p.lat)
  const lngs = pts.map((p) => p.lng)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  const latSpan = maxLat - minLat || 0.01
  const lngSpan = maxLng - minLng || 0.01
  return (p: Location) => ({
    x: ((p.lng - minLng) / lngSpan) * (W - 2 * PAD) + PAD,
    y: (1 - (p.lat - minLat) / latSpan) * (H - 2 * PAD) + PAD,
  })
}

const JUMP_ACTIONS: { target: AppTarget; label: string }[] = [
  { target: 'navigation', label: '导航' },
  { target: 'dianping', label: '大众点评' },
  { target: 'booking', label: '携程' },
]

export default function MapView({ plan }: { plan: TravelPlan }) {
  // 这张图是本地画出来的示意图（不是真瓦片），所以配色得自己跟主题走：
  // 原来背景写死 #eef3f7、标注文字写死 #333，深色外壳里就是一块白板加一片看不见的黑字。
  const { token } = theme.useToken()
  const { jump, copyKeyword } = useAppJump()
  const [selected, setSelected] = useState<POI | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [manual, setManual] = useState<{ copyText: string; label: string } | null>(null)

  const points = useMemo(() => collectPoints(plan), [plan])
  const coords = useMemo(() => {
    if (!points.length) return []
    const projector = buildProjector(points.map((p) => p.location))
    return points.map((p) => projector(p.location))
  }, [points])

  const handleJump = async (target: AppTarget, poi: POI, label: string) => {
    setNotice(null)
    setManual(null)
    const res = await jump(target, { name: poi.name, lat: poi.location.lat, lng: poi.location.lng })
    if (res.needManual && res.copyText) {
      setManual({ copyText: res.copyText, label })
      setNotice(res.message)
    } else {
      setNotice(res.message)
    }
  }

  const handleCopy = async () => {
    if (!manual) return
    await copyKeyword(JUMP_ACTIONS.find((a) => a.label === manual.label)!.target, {
      name: manual.copyText,
      lat: 0,
      lng: 0,
    })
    setNotice('口令已复制，请打开对应 App 搜索')
  }

  const polylinePoints = coords.map((c) => `${c.x},${c.y}`).join(' ')

  return (
    <Card title="地图打点与轨迹" size="small">
      {!points.length ? (
        <Alert type="warning" message="暂无带坐标的打卡点" />
      ) : (
        <svg
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          style={{
            background: token.colorFillQuaternary,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 8,
          }}
        >
          <polyline
            points={polylinePoints}
            fill="none"
            stroke={token.colorPrimary}
            strokeWidth="2"
            strokeDasharray="6 4"
          />
          {coords.map((c, i) => {
            // 点位颜色是"语义色"：起点绿、住宿橙、其余用主色。
            // 不用 token.colorPrimary 之外的东西，是为了在深底上也能看清。
            const fill =
              points[i].type === '住宿'
                ? token.colorWarning
                : i === 0
                  ? token.colorSuccess
                  : token.colorPrimary
            return (
              <g key={i} onClick={() => setSelected(points[i])} style={{ cursor: 'pointer' }}>
                <circle cx={c.x} cy={c.y} r={i === 0 ? 9 : 7} fill={fill} />
                <text x={c.x + 11} y={c.y + 4} fontSize="11" fill={token.colorText}>
                  {i + 1}. {points[i].name}
                </text>
              </g>
            )
          })}
        </svg>
      )}

      {selected && (
        <div style={{ marginTop: 12 }}>
          <Space>
            <Tag color="blue">{selected.name}</Tag>
            {JUMP_ACTIONS.map((a) => (
              <Button
                key={a.target}
                size="small"
                onClick={() => handleJump(a.target, selected, a.label)}
              >
                {a.label}
              </Button>
            ))}
          </Space>
        </div>
      )}

      {notice && (
        <Alert
          style={{ marginTop: 12 }}
          type="info"
          showIcon
          message={notice}
          action={
            manual ? (
              <Button size="small" onClick={handleCopy}>
                复制口令
              </Button>
            ) : undefined
          }
        />
      )}
    </Card>
  )
}
