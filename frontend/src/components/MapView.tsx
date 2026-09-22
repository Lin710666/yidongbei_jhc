import { useMemo, useState } from 'react'
import { Alert, Button, Card, Space, Tag, theme } from 'antd'
import type { Location, POI, TravelPlan } from '../types/plan'
import { useAppJump, type AppTarget } from '../hooks/useAppJump'

const W = 640
const H = 400
const PAD = 36
const FS = 11 // 标签字号
const LH = 15 // 标签行高
const CH_W = 11 // 中文字宽（≈字号）
const EN_W = 6.4 // 半角字符宽
const NAME_MAX = 12 // 名字最多显示几个字，超出截断（全名在下面选中后能看到）

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

/**
 * 经纬度 -> SVG 画布坐标。
 *
 * ★ 改成**等比投影**：横纵用同一个缩放系数（取较小的那个），再把整体居中。
 * 原来横纵各自拉满（x 用 lngSpan、y 用 latSpan 各算各的），
 * 结果是一张**形状失真**的图 —— 东西向会被拉长或压扁，
 * 轨迹看起来跟实际方向对不上。
 */
function buildProjector(pts: Location[]) {
  const lats = pts.map((p) => p.lat)
  const lngs = pts.map((p) => p.lng)
  const minLat = Math.min(...lats)
  const maxLat = Math.max(...lats)
  const minLng = Math.min(...lngs)
  const maxLng = Math.max(...lngs)
  // 1 度纬度 ≈ 111km；1 度经度 ≈ 111km × cos(纬度)。高纬度地方东西向要按 cos 缩一下，
  // 不然北边的行程会被拉宽。这里只做展示，用中心纬度近似即可。
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180) || 1
  const latSpan = maxLat - minLat || 0.01
  const lngSpan = (maxLng - minLng || 0.01) * kx
  const usableW = W - 2 * PAD
  const usableH = H - 2 * PAD
  const scale = Math.min(usableW / lngSpan, usableH / latSpan)
  const offsetX = PAD + (usableW - lngSpan * scale) / 2
  const offsetY = PAD + (usableH - latSpan * scale) / 2
  return (p: Location) => ({
    x: offsetX + (p.lng - minLng) * kx * scale,
    y: offsetY + (maxLat - p.lat) * scale,
  })
}

/** 截断过长的名字 —— 原图里整串「POSHPACKER拖板鞋青年旅舍旅行民宿(成都太古里春熙路地铁站店)」全画出来， 一个字就把半个画布占了 */
function shortName(name: string, max = NAME_MAX) {
  return name.length > max ? name.slice(0, max) + '…' : name
}

/** 粗算标签像素宽（中日韩按 1 个字宽、其余按 0.58 个） */
function textWidth(s: string) {
  let w = 0
  for (const ch of s) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? CH_W : EN_W
  return w
}

type Box = { x1: number; y1: number; x2: number; y2: number }
const hit = (a: Box, b: Box) => !(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1)

/**
 * 把距离过近的点合并成一个标记。
 *
 * ★ 这是"字全叠在一起"的根本解法，不是把标签挪开就行。
 * 实测（成都 4 天 19 个点）：市区那 8 个餐厅**地理上就在同一个商场**
 * （环球中心 / 大魔方 / SKP 一带），投影后落在不到 10px 的范围内 ——
 * 它们的标签有 43 对互相压住。给 8 个挤在 10px 里的点找 8 个互不重叠的位置
 * 是不可能的，而且**画 8 个点本身就不对**：那是同一个地方。
 * 合并之后标签数从 19 降到个位数，既看得清也更如实。
 */
function clusterPoints(pts: POI[], coords: { x: number; y: number }[], radius = 24) {
  const used = new Array(pts.length).fill(false)
  const groups: number[][] = []
  for (let i = 0; i < pts.length; i++) {
    if (used[i]) continue
    const g = [i]
    used[i] = true
    for (let j = i + 1; j < pts.length; j++) {
      if (used[j]) continue
      const d = Math.hypot(coords[i].x - coords[j].x, coords[i].y - coords[j].y)
      if (d <= radius) {
        g.push(j)
        used[j] = true
      }
    }
    groups.push(g)
  }
  return groups.map((idx) => {
    const cx = idx.reduce((s, i) => s + coords[i].x, 0) / idx.length
    const cy = idx.reduce((s, i) => s + coords[i].y, 0) / idx.length
    return { idx, x: cx, y: cy }
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

  // 合并近点 -> 给每个标记算一个**互不重叠**的标签位置
  const marks = useMemo(() => {
    if (!coords.length) return []
    const groups = clusterPoints(points, coords)
    // ★ 先把**所有标记圆圈**占位，再放标签。
    //   只登记标签框是不够的：候选位置里有"点在正上方/正下方居中"这类，
    //   标签会正好压住标记里的那个数字（实测剩的最后 1 对重叠就是"8 ⟷ 它自己的标签"）。
    const placed: Box[] = groups.map((g, gi) => {
      const r = gi === 0 ? 9 : g.idx.length > 1 ? 8.5 : 7
      const pad = g.idx.length > 1 ? r + 6 : r + 2
      return { x1: g.x - pad, y1: g.y - pad, x2: g.x + pad, y2: g.y + pad }
    })
    return groups.map((g, gi) => {
      const first = g.idx[0]
      const label = g.idx.length > 1
        ? `${gi + 1}. ${shortName(points[first].name, 8)} 等 ${g.idx.length} 个点`
        : `${gi + 1}. ${shortName(points[first].name)}`
      const w = textWidth(label) + 8
      const h = LH
      // 候选位置：右、左、上、下、右下、左下；都不行就按 15px 往下叠（兜底）
      const cands: { x: number; y: number }[] = [
        { x: g.x + 11, y: g.y + 4 },
        { x: g.x - 11 - w, y: g.y + 4 },
        { x: g.x - w / 2, y: g.y - 11 },
        { x: g.x - w / 2, y: g.y + 17 },
      ]
      for (let k = 1; k <= 12; k++) {
        cands.push({ x: g.x + 11, y: g.y + 4 + k * (LH + 1) })
        cands.push({ x: g.x - 11 - w, y: g.y + 4 + k * (LH + 1) })
      }
      let bx = cands[0].x
      let by = cands[0].y
      for (const c of cands) {
        const x = Math.max(2, Math.min(W - w - 2, c.x))
        const y = Math.max(LH, Math.min(H - 3, c.y))
        const box = { x1: x, y1: y - LH + 3, x2: x + w, y2: y + 3 }
        if (!placed.some((p) => hit(p, box))) {
          placed.push(box)
          bx = x
          by = y
          break
        }
      }
      return { ...g, label, w, lx: bx, ly: by, anchor: 'start' as const }
    })
  }, [points, coords])

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
        <>
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
              opacity="0.8"
            />
            {marks.map((m, i) => {
              const p0 = points[m.idx[0]]
              // 点位颜色是"语义色"：起点绿、住宿橙、其余用主色。
              // 不用 token.colorPrimary 之外的东西，是为了在深底上也能看清。
              const fill =
                p0.type === '住宿'
                  ? token.colorWarning
                  : m.idx[0] === 0
                    ? token.colorSuccess
                    : token.colorPrimary
              const r = m.idx[0] === 0 ? 9 : m.idx.length > 1 ? 8.5 : 7
              // 标签离点太远时补一根细引线，不然看不出这个标签说的是哪个点
              const far = Math.hypot(m.lx - m.x, m.ly - 4 - m.y) > 26
              return (
                <g key={i} onClick={() => setSelected(p0)} style={{ cursor: 'pointer' }}>
                  {m.idx.length > 1 && (
                    <circle cx={m.x} cy={m.y} r={r + 5} fill={fill} opacity="0.18" />
                  )}
                  <circle cx={m.x} cy={m.y} r={r} fill={fill} />
                  {m.idx.length > 1 && (
                    <text
                      x={m.x}
                      y={m.y + 3.5}
                      fontSize="9"
                      fontWeight="700"
                      textAnchor="middle"
                      fill="#fff"
                    >
                      {m.idx.length}
                    </text>
                  )}
                  {far && (
                    <line
                      x1={m.x}
                      y1={m.y}
                      x2={m.anchor === 'start' ? m.lx : m.lx + m.w}
                      y2={m.ly - 3}
                      stroke={token.colorTextQuaternary}
                      strokeWidth="1"
                    />
                  )}
                  {/* 标签底：原图标签直接压在人物/背景上，深底时读不出来 */}
                  <rect
                    x={m.lx - 3}
                    y={m.ly - LH + 3}
                    width={m.w}
                    height={LH}
                    rx="3"
                    fill={token.colorBgElevated}
                    opacity="0.86"
                  />
                  <text
                    x={m.lx}
                    y={m.ly}
                    fontSize={FS}
                    fill={token.colorText}
                    style={{ pointerEvents: 'none' }}
                  >
                    {m.label}
                  </text>
                </g>
              )
            })}
          </svg>
          <div style={{ marginTop: 6, fontSize: 12, color: token.colorTextTertiary }}>
            共 {points.length} 个打卡点，图上按位置合并成 {marks.length} 个标记
            {marks.some((m) => m.idx.length > 1) ? '（数字 = 该位置有几个点）' : ''}；点标记看详情与跳转
          </div>
        </>
      )}

      {selected && (
        <div style={{ marginTop: 12 }}>
          <Space wrap>
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
