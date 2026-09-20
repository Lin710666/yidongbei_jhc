import { useState } from 'react'
import { Alert, Button, Card, Descriptions, Divider, Statistic, Tag, Timeline, theme } from 'antd'
import type { DailyPlan, POI, TimelineItem, TravelPlan } from '../types/plan'
import JumpButtons from './JumpButtons'

/* ==========================================================================
 * 关于下面那些原先是写死的颜色
 *
 * 这份组件原本在几处内联样式里直接写了浅色：#fafafa（换景点/换餐厅/换酒店的
 * 展开面板）、#f5f5f5（实时天气预报的每一天）、#f6ffed + #b7eb8f（当晚住宿那块
 * 浅绿底）、以及一堆 #888 / #555 的次要文字。
 *
 * 自己是浅色主题时没问题，但嵌进深色外壳之后：白框在一片深色里非常刺眼，
 * 灰字在深底上对比度也不够。而且内联样式的优先级高于任何样式表，
 * 从外面用 CSS 去覆盖只能靠 !important 硬压，那太脆。
 *
 * 所以统一换成 antd 的主题 token（theme.useToken()）。token 会跟着
 * ConfigProvider 的 algorithm 走：他自己的浅色界面上取到的基本就是原来的色
 * （colorFillQuaternary 在浅色下 ≈ #fafafa），我们的 darkAlgorithm 下自动变暗。
 * 两边都不需要为对方做特例。
 * ========================================================================== */

const TYPE_COLOR: Record<string, string> = {
  景点: 'blue',
  餐厅: 'orange',
  住宿: 'green',
  交通: 'default',
  购物: 'gold',
}

const TIER_COLOR: Record<string, string> = { 经济: 'default', 中档: 'blue', 高档: 'gold' }

// 室内景点关键词（雨天 Plan B「一键换成室内」判断，与后端 _is_indoor 保持一致）
const INDOOR_KEYWORDS = ['博物馆', '美术馆', '科技馆', '展览馆', '陈列馆', '图书馆', '商场', '购物中心', '剧院', '室内']
const isIndoorPoi = (p: POI) => INDOOR_KEYWORDS.some((k) => p.name.includes(k))

// 编辑后重算预算：与后端 _budget 同口径，保证换景点/餐厅/酒店后总预算实时更新
function recomputeBudget(plan: TravelPlan): TravelPlan {
  const people = plan.travelers || 1
  const nights = Math.max(plan.daily_plans.length - 1, 0)
  const rooms = Math.max(1, Math.ceil(people / 2))

  let tickets = 0
  const meals: POI[] = []
  for (const d of plan.daily_plans)
    for (const it of d.timeline) {
      if (it.poi.type === '景点' && it.poi.price != null) tickets += it.poi.price
      if (it.poi.type === '餐厅') meals.push(it.poi)
    }

  const dining = Math.round(meals.reduce((s, m) => s + (m.price || 60), 0) * people)
  const hotel = Math.round(
    plan.daily_plans.slice(0, nights).reduce((s, d) => s + (d.hotel?.price || 350), 0) * rooms,
  )

  const b = plan.budget_breakdown
  const total = tickets + dining + hotel + b.transport
  return {
    ...plan,
    total_budget_estimate: Math.round(total),
    budget_breakdown: { ...b, tickets: Math.round(tickets), dining, hotel },
  }
}

// 分档推荐列表（经济/中档/高档）。
// onPick 提供时显示选择按钮（pickLabel）；keepJump 为 true 时同时保留跳转按钮（用于换酒店）
function TieredList({
  options,
  onPick,
  pickLabel = '换这家',
  keepJump = false,
}: {
  options: POI[]
  onPick?: (poi: POI) => void
  pickLabel?: string
  keepJump?: boolean
}) {
  const { token } = theme.useToken()
  return (
    <>
      {['经济', '中档', '高档'].map((tier) => {
        const items = options.filter((o) => o.tier === tier)
        if (items.length === 0) return null
        return (
          <div key={tier} style={{ marginBottom: 6 }}>
            <Tag color={TIER_COLOR[tier]} style={{ marginRight: 4 }}>
              {tier}
            </Tag>
            {items.map((o) => (
              <div
                key={o.name}
                style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}
              >
                <span style={{ fontWeight: 600 }}>{o.name}</span>
                <span style={{ color: token.colorTextTertiary, fontSize: 12 }}>{o.tips}</span>
                {onPick && (
                  <Button size="small" type="primary" ghost onClick={() => onPick(o)}>
                    {pickLabel}
                  </Button>
                )}
                {(!onPick || keepJump) && <JumpButtons poi={o} />}
              </div>
            ))}
          </div>
        )
      })}
    </>
  )
}

// 景点备选列表（供「换一个」选择，排除当前景点自身）
function AttractionPickList({
  options,
  current,
  onPick,
}: {
  options: POI[]
  current: string
  onPick: (poi: POI) => void
}) {
  const { token } = theme.useToken()
  const others = options.filter((o) => o.name !== current)
  if (others.length === 0) {
    return (
      <span style={{ color: token.colorTextTertiary, fontSize: 12 }}>
        暂无其他景点备选，可先移除或换个目的地
      </span>
    )
  }
  return (
    <>
      {others.map((o) => (
        <div
          key={o.name}
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}
        >
          <span style={{ fontWeight: 600 }}>{o.name}</span>
          <span style={{ color: token.colorTextTertiary, fontSize: 12 }}>{o.tips}</span>
          <Button size="small" type="primary" ghost onClick={() => onPick(o)}>
            换这个
          </Button>
        </div>
      ))}
    </>
  )
}

function TimelineNode({
  item,
  diningOptions,
  attractionOptions,
  onRemove,
  onSwapMeal,
  onSwapAttraction,
}: {
  item: TimelineItem
  diningOptions: POI[]
  attractionOptions: POI[]
  onRemove?: () => void
  onSwapMeal?: (poi: POI) => void
  onSwapAttraction?: (poi: POI) => void
}) {
  const { poi } = item
  const { token } = theme.useToken()
  const isMeal = poi.type === '餐厅'
  const isAttraction = poi.type === '景点'
  const [showDining, setShowDining] = useState(false)
  const [showAttr, setShowAttr] = useState(false)

  // 展开面板的底色：浅色主题下取到的 ≈ 原来的 #fafafa，深色主题下自动变暗
  const panelStyle = {
    marginTop: 4,
    padding: 8,
    background: token.colorFillQuaternary,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: 6,
  }

  return (
    <div>
      <b>{item.time}</b>
      <Tag color={TYPE_COLOR[poi.type]} style={{ marginLeft: 8 }}>
        {poi.type}
      </Tag>
      <span style={{ fontWeight: 600 }}>{poi.name}</span>
      {poi.price != null && <span style={{ color: '#fa541c', marginLeft: 8 }}>约 ¥{poi.price}</span>}
      <JumpButtons poi={poi} />
      {isAttraction && (onRemove || onSwapAttraction) && (
        <span style={{ marginLeft: 4 }}>
          {onSwapAttraction && (
            <Button
              type="dashed"
              size="small"
              style={{ color: token.colorPrimary, borderColor: token.colorPrimary, fontWeight: 600, padding: '0 8px' }}
              onClick={() => setShowAttr((v) => !v)}
            >
              {showAttr ? '收起' : '换一个'}
            </Button>
          )}
          {onRemove && (
            <Button type="link" size="small" danger style={{ padding: '0 4px' }} onClick={onRemove}>
              移除
            </Button>
          )}
        </span>
      )}

      {isAttraction && showAttr && (
        <div style={{ ...panelStyle, maxHeight: 220, overflow: 'auto' }}>
          <AttractionPickList options={attractionOptions} current={poi.name} onPick={onSwapAttraction!} />
        </div>
      )}

      {isMeal && diningOptions.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <Button
            type="dashed"
            size="small"
            style={{ color: '#fa8c16', borderColor: '#fa8c16', fontWeight: 600 }}
            onClick={() => setShowDining((v) => !v)}
          >
            {showDining ? '收起餐厅推荐' : '🍽 换一家餐厅（按价位）'}
          </Button>
        </div>
      )}
      {isMeal && showDining && (
        <div style={panelStyle}>
          <TieredList options={diningOptions} onPick={onSwapMeal} />
        </div>
      )}

      {item.tips && <div style={{ color: token.colorTextTertiary, fontSize: 12 }}>{item.tips}</div>}
      {item.transport_to_next && (
        <div style={{ color: token.colorPrimary, fontSize: 12 }}>
          → {item.transport_to_next.mode} {item.transport_to_next.duration}
          {item.transport_to_next.cost > 0 && ` 约 ¥${item.transport_to_next.cost}`}
        </div>
      )}
    </div>
  )
}

function DayCard({
  day,
  diningOptions,
  hotelOptions,
  attractionOptions,
  isLastDay,
  onRemove,
  onSwapMeal,
  onSwapAttraction,
  onSelectHotel,
  onApplyPlanB,
}: {
  day: DailyPlan
  diningOptions: POI[]
  hotelOptions: POI[]
  attractionOptions: POI[]
  isLastDay?: boolean
  onRemove?: (itemIndex: number) => void
  onSwapMeal?: (itemIndex: number, poi: POI) => void
  onSwapAttraction?: (itemIndex: number, poi: POI) => void
  onSelectHotel?: (poi: POI) => void
  onApplyPlanB?: () => void
}) {
  const [showHotel, setShowHotel] = useState(false)
  const { token } = theme.useToken()

  return (
    <Card
      size="small"
      title={
        <span>
          {day.date} · {day.weather.condition || '—'} {day.weather.temp || ''}
        </span>
      }
      style={{ marginBottom: 12 }}
    >
      {day.plan_b && (
        <Alert
          type="info"
          showIcon
          message={day.plan_b}
          style={{ marginBottom: 12 }}
          action={
            onApplyPlanB ? (
              <Button size="small" type="primary" ghost onClick={onApplyPlanB}>
                🏠 一键换成室内
              </Button>
            ) : undefined
          }
        />
      )}
      <Timeline
        items={day.timeline.map((item, idx) => ({
          children: (
            <TimelineNode
              item={item}
              diningOptions={diningOptions}
              attractionOptions={attractionOptions}
              onRemove={onRemove ? () => onRemove(idx) : undefined}
              onSwapMeal={onSwapMeal ? (poi) => onSwapMeal(idx, poi) : undefined}
              onSwapAttraction={onSwapAttraction ? (poi) => onSwapAttraction(idx, poi) : undefined}
            />
          ),
        }))}
      />

      {/* 当晚住宿：独立展示当天酒店（含入住/退房时间），可更换；末天为退房返程 */}
      {day.hotel ? (
        <div
          style={{
            marginTop: 12,
            padding: '8px 10px',
            // 原来是 #f6ffed + #b7eb8f 的浅绿底；浅色主题下 token 取到的就是这个色系
            background: token.colorSuccessBg,
            border: `1px solid ${token.colorSuccessBorder}`,
            borderRadius: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600 }}>🏨 {day.hotel.name}</span>
            {day.hotel.tier && <Tag color={TIER_COLOR[day.hotel.tier]}>{day.hotel.tier}</Tag>}
            {day.hotel.price != null && (
              <span style={{ color: '#fa541c' }}>约 ¥{day.hotel.price}/晚</span>
            )}
            {onSelectHotel && hotelOptions.length > 0 && (
              <Button
                type="link"
                size="small"
                style={{ padding: '0 4px' }}
                onClick={() => setShowHotel((v) => !v)}
              >
                {showHotel ? '收起' : '更换酒店'}
              </Button>
            )}
          </div>
          {(day.hotel.check_in || day.hotel.check_out) && (
            <div style={{ color: token.colorTextSecondary, fontSize: 12 }}>
              🕒 入住 {day.hotel.check_in || '—'} · 退房 {day.hotel.check_out || '—'}
              <span style={{ color: token.colorTextTertiary }}>（行业惯例，以酒店实际为准）</span>
            </div>
          )}
          {day.hotel.tips && (
            <div style={{ color: token.colorTextTertiary, fontSize: 12 }}>{day.hotel.tips}</div>
          )}
          <JumpButtons poi={day.hotel} />
        </div>
      ) : isLastDay ? (
        <div style={{ marginTop: 12, fontSize: 12, color: token.colorTextTertiary }}>
          🏨 退房返程 · 当晚无需住宿
        </div>
      ) : (
        hotelOptions.length > 0 &&
        onSelectHotel && (
          <div style={{ marginTop: 8 }}>
            <Button
              type="dashed"
              size="small"
              style={{ color: '#13c2c2', borderColor: '#13c2c2', fontWeight: 600 }}
              onClick={() => setShowHotel((v) => !v)}
            >
              {showHotel ? '收起' : '🏨 选择酒店'}
            </Button>
          </div>
        )
      )}

      {showHotel && hotelOptions.length > 0 && (
        <div
          style={{
            marginTop: 4,
            padding: 8,
            background: token.colorFillQuaternary,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 6,
          }}
        >
          <TieredList options={hotelOptions} onPick={onSelectHotel} pickLabel="选这家" keepJump />
        </div>
      )}

      {day.tips.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: token.colorTextSecondary }}>
          💡 游玩贴士：{day.tips.join('；')}
        </div>
      )}
    </Card>
  )
}

// 天气状况 -> 图标（用于实时天气预报面板）
function weatherIcon(condition: string): string {
  if (/雪/.test(condition)) return '❄️'
  if (/雨/.test(condition)) return '🌧️'
  if (/阴/.test(condition)) return '☁️'
  if (/云/.test(condition)) return '⛅'
  if (/晴/.test(condition)) return '☀️'
  if (/雾|霾|沙尘/.test(condition)) return '🌫️'
  return '🌤️'
}

// YYYY-MM-DD -> 周几
function dayOfWeek(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  return ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
}

// 实时天气预报（出行日逐日预报，来自高德天气 API，非硬编码）。无卡片外壳，内嵌在概览卡中，与预算紧邻
function WeatherStrip({ days }: { days: DailyPlan[] }) {
  const { token } = theme.useToken()
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {days.map((d) => (
        <div
          key={d.date}
          style={{
            minWidth: 88,
            textAlign: 'center',
            padding: '6px 10px',
            // 原来是写死的 #f5f5f5 浅灰块，深色主题下会变成一块块白的
            background: token.colorFillTertiary,
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: 8,
          }}
        >
          <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
            {d.date.slice(5)} 周{dayOfWeek(d.date)}
          </div>
          <div style={{ fontSize: 24, lineHeight: 1.3 }}>{weatherIcon(d.weather.condition)}</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{d.weather.condition || '暂无预报'}</div>
          <div style={{ fontSize: 11, color: token.colorTextTertiary }}>{d.weather.temp}</div>
        </div>
      ))}
    </div>
  )
}

interface Props {
  plan: TravelPlan
  onApplySuggestions?: () => void
  applying?: boolean
  // 编辑（换景点 / 移除景点 / 换餐厅 / 换酒店）后回调新的 plan，用于实时更新预算与地图
  onUpdate?: (plan: TravelPlan) => void
}

export default function PlanView({ plan, onApplySuggestions, applying, onUpdate }: Props) {
  const { token } = theme.useToken()
  const actionable = plan.conflicts.some((c) => c.field != null)

  const people = plan.travelers || 1
  const nights = Math.max(plan.daily_plans.length - 1, 0)
  const rooms = Math.max(1, Math.ceil(people / 2))
  const stayHotelNames = plan.daily_plans
    .slice(0, nights)
    .map((d) => d.hotel?.name ?? '')
    .filter((n) => n !== '')
  const stayHotels = [...new Set(stayHotelNames)]
  const surplus = plan.user_budget != null ? plan.user_budget - plan.total_budget_estimate : null

  const clone = () => JSON.parse(JSON.stringify(plan)) as TravelPlan

  const replacePoi = (dayIndex: number, itemIndex: number, poi: POI) => {
    if (!onUpdate) return
    const next = clone()
    const item = next.daily_plans[dayIndex]?.timeline[itemIndex]
    if (!item) return
    item.poi = poi
    onUpdate(recomputeBudget(next))
  }

  const handleRemove = (dayIndex: number, itemIndex: number) => {
    if (!onUpdate) return
    const next = clone()
    const day = next.daily_plans[dayIndex]
    if (!day) return
    day.timeline.splice(itemIndex, 1)
    onUpdate(recomputeBudget(next))
  }

  // 选/换酒店：仅替换当天（每晚独立），并重算住宿费
  const handleSelectHotel = (dayIndex: number, poi: POI) => {
    if (!onUpdate) return
    const next = clone()
    const day = next.daily_plans[dayIndex]
    if (!day) return
    day.hotel = poi
    onUpdate(recomputeBudget(next))
  }

  // 一键采纳雨天 Plan B：把当天户外景点替换为室内备选，并重算预算
  const handleApplyPlanB = (dayIndex: number) => {
    if (!onUpdate) return
    const next = clone()
    const day = next.daily_plans[dayIndex]
    if (!day) return
    const used = new Set(day.timeline.map((it) => it.poi.name))
    const indoor = next.attraction_options.filter((p) => isIndoorPoi(p) && !used.has(p.name))
    if (indoor.length === 0) return
    let replaced = 0
    for (const item of day.timeline) {
      if (item.poi.type === '景点' && !isIndoorPoi(item.poi)) {
        item.poi = indoor[replaced % indoor.length]
        replaced += 1
      }
    }
    if (replaced > 0) {
      day.plan_b = ''
      onUpdate(recomputeBudget(next))
    }
  }

  return (
    <div>
      {/* 概览卡：总预算 + 分项预算 + 住宿说明 + 实时天气，紧凑地聚合在一起 */}
      <Card title={plan.summary} style={{ marginBottom: 12 }}>
        <Statistic title="总预算估算（元）" value={plan.total_budget_estimate} precision={0} prefix="¥" />
        <Descriptions column={4} size="small" style={{ marginTop: 12 }}>
          <Descriptions.Item label="交通">¥{plan.budget_breakdown.transport}</Descriptions.Item>
          <Descriptions.Item label="门票">¥{plan.budget_breakdown.tickets}</Descriptions.Item>
          <Descriptions.Item label="餐饮">¥{plan.budget_breakdown.dining}</Descriptions.Item>
          <Descriptions.Item label="住宿">¥{plan.budget_breakdown.hotel}</Descriptions.Item>
        </Descriptions>
        {nights > 0 && (
          <div style={{ marginTop: 8, fontSize: 12, color: token.colorTextTertiary }}>
            住宿：{nights} 晚 · {rooms} 间
            {stayHotels.length > 0
              ? ` · ${stayHotels.join(' / ')}`
              : ' · 暂无酒店数据，按 ¥350/晚/间估算'}
          </div>
        )}
        {surplus != null && (
          <div
            style={{
              marginTop: 4,
              fontSize: 12,
              fontWeight: 600,
              color: surplus >= 0 ? '#52c41a' : '#fa541c',
            }}
          >
            你的预算 ¥{plan.user_budget} ·{' '}
            {surplus >= 0 ? `预计结余 ¥${Math.round(surplus)}` : `预计超出 ¥${Math.round(-surplus)}`}
          </div>
        )}
        <Divider style={{ margin: '12px 0' }} />
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>实时天气预报</div>
        <WeatherStrip days={plan.daily_plans} />
      </Card>

      {plan.conflicts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="温馨提示（系统检测到以下潜在问题，是否采纳建议由您决定）"
          description={
            <div>
              {plan.conflicts.map((c) => (
                <div key={c.id}>
                  · {c.message} —— <b>{c.suggestion}</b>
                </div>
              ))}
            </div>
          }
          action={
            actionable && onApplySuggestions ? (
              <Button size="small" type="primary" onClick={onApplySuggestions} loading={applying}>
                一键采纳建议
              </Button>
            ) : undefined
          }
        />
      )}

      {plan.daily_plans.map((day, dayIndex) => (
        <DayCard
          key={day.date}
          day={day}
          diningOptions={plan.dining_options}
          hotelOptions={plan.hotel_options}
          attractionOptions={plan.attraction_options}
          isLastDay={dayIndex === plan.daily_plans.length - 1}
          onRemove={onUpdate ? (i) => handleRemove(dayIndex, i) : undefined}
          onSwapMeal={onUpdate ? (i, p) => replacePoi(dayIndex, i, p) : undefined}
          onSwapAttraction={onUpdate ? (i, p) => replacePoi(dayIndex, i, p) : undefined}
          onSelectHotel={onUpdate ? (poi) => handleSelectHotel(dayIndex, poi) : undefined}
          onApplyPlanB={onUpdate ? () => handleApplyPlanB(dayIndex) : undefined}
        />
      ))}
    </div>
  )
}
