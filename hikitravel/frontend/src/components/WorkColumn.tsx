import { useState } from 'react'
import type { Planner } from '../hooks/usePlanner'
import type { POI, TravelPlan } from '../types/plan'
import { useAppJump, type AppTarget } from '../hooks/useAppJump'
import { collectPoints, hotelKey, poiKey } from '../lib/amap'
import { BUDGET_COLORS, BUDGET_LABELS, DAY_COLORS, fmt, monthDay, weekday } from '../lib/format'
import ProgressCard from './ProgressCard'
import OptionsCard from './OptionsCard'
import ChecksCard from './ChecksCard'
import ReplaceDialog from './ReplaceDialog'

interface Props {
  planner: Planner
  notify: (text: string) => void
  day: number
  setDay: (n: number) => void
  /** 地图上被选中的元素键（行程点用 poi:天:序号，酒店用 hotel:天） */
  focus: string | null
  setFocus: (key: string | null) => void
}

/** 预算按当前规划实时汇总：移除安排后金额会跟着变 */
function budgetOf(plan: TravelPlan) {
  const b = { ...plan.budget_breakdown }
  const total = b.transport + b.tickets + b.dining + b.hotel
  return { b, total }
}

/** POI 类型 -> 对应哪一池备选 + 给用户看的措辞 */
function poolOf(plan: TravelPlan, type: string): { label: string; list: POI[] } | null {
  if (type === '景点') return { label: '景点', list: plan.attraction_options }
  if (type === '餐厅') return { label: '餐厅', list: plan.dining_options }
  if (type === '住宿') return { label: '酒店', list: plan.hotel_options }
  return null
}

/**
 * 行程项的实拍图（来自高德 POI 接口，地址已统一成 https）。
 *
 * 加载失败就整块返回 null：`.tl` 的第三列是 auto 宽，没有内容时自动收成 0 宽，
 * 所以图挂了不会在卡片右侧留一块空白（高德图床偶尔会 404）。
 */
function PoiThumb({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <div className="tl__thumb">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </div>
  )
}

export default function WorkColumn({ planner, notify, day, setDay, focus, setFocus }: Props) {
  const { plan, loading, elapsed, error, retry } = planner
  const { jump, copyKeyword } = useAppJump()
  const [reviseText, setReviseText] = useState('')
  const [checking, setChecking] = useState(false)
  const [replacing, setReplacing] = useState<{ name: string; label: string; options: POI[] } | null>(
    null,
  )

  async function act(target: AppTarget, poi: POI) {
    const ref = {
      name: poi.name,
      lat: poi.location.lat,
      lng: poi.location.lng,
      city: poi.city,
    }
    const result = await jump(target, ref)
    if (result.needManual && result.copyText) await copyKeyword(target, ref)
    notify(result.message)
  }

  const handleCheckConnection = async () => {
    setChecking(true)
    await planner.checkHealth()
    setChecking(false)
    notify(
      planner.env?.ollama_available
        ? '连接正常：后端与本地大模型均可用'
        : '后端连接正常，但未检测到本地大模型',
    )
  }

  const submitRevise = () => {
    const text = reviseText.trim()
    if (!text) return
    planner.runRevise(text)
    setReviseText('')
  }

  /* 移除单个安排：本地编辑，改完由用户决定是否保存 */
  const removeItem = (dayIndex: number, itemIndex: number) => {
    planner.updatePlan((p) => {
      const item = p.daily_plans[dayIndex]?.timeline[itemIndex]
      if (!item) return p

      // 预算明细是后端按「生成时」的行程算的，本地删掉一项后必须同步扣减，
      // 否则用户会看到「少了半天行程、总价却一分没变」。
      const key = item.poi.type === '餐厅' ? 'dining' : item.poi.type === '景点' ? 'tickets' : null
      const delta = (item.poi.price ?? 0) * (p.travelers || 1)
      const budget = key
        ? { ...p.budget_breakdown, [key]: Math.max(0, p.budget_breakdown[key] - delta) }
        : p.budget_breakdown

      return {
        ...p,
        budget_breakdown: budget,
        daily_plans: p.daily_plans.map((d, di) =>
          di === dayIndex ? { ...d, timeline: d.timeline.filter((_, ii) => ii !== itemIndex) } : d,
        ),
      }
    })
    notify('已移除，记得保存')
  }

  const body = () => {
    if (error) {
      return (
        <div className="alert alert--error">
          <i className="alert__dot" />
          <div>
            {error.message}
            <div className="alert__acts">
              <button className="btn btn--link" onClick={retry}>
                重试
              </button>
              <button className="btn btn--muted" onClick={handleCheckConnection}>
                检查连接
              </button>
            </div>
          </div>
        </div>
      )
    }

    if (!plan) {
      return (
        <div className="card empty">
          <h2>还没有行程</h2>
          <p>在左侧输入一句话，或填写偏好后生成。</p>
        </div>
      )
    }

    const { b, total } = budgetOf(plan)
    const diff = (plan.user_budget ?? 0) - total
    const sum = Math.max(1, b.transport + b.tickets + b.dining + b.hotel)
    const segs = (['transport', 'tickets', 'dining', 'hotel'] as const).map((k) => ({
      k,
      value: b[k],
    }))
    const first = plan.daily_plans[0]
    const pref = plan.user_preference
    const current = plan.daily_plans[day] ?? first
    const hasRemoved = plan.daily_plans.some((d, di) => di === day && d.timeline.length === 0)
    // 有坐标的行程项（地图上画了点）才可点击定位；酒店另有 hotelKey
    const geoKeys = new Set(collectPoints(plan).map((p) => poiKey(p.lng, p.lat)))
    const hotelFocusKey = current?.hotel && current.hotel.location ? hotelKey(day) : null
    const hotelFocused = hotelFocusKey != null && focus === hotelFocusKey

    return (
      <>
        <div className="card">
          <h1 className="overview__title">{plan.summary}</h1>
          <div className="overview__meta">
            {first?.date} 起 · {plan.daily_plans.length} 天 · {plan.travelers} 人
            {pref?.transportation ? ` · ${pref.transportation}往返` : ''}
            {pref?.pace ? ` · 节奏${pref.pace}` : ''}
          </div>

          <div className="kpis">
            <div>
              <div className="kpi__k">天数</div>
              <div className="kpi__v">
                {plan.daily_plans.length}
                <small>天</small>
              </div>
            </div>
            <div>
              <div className="kpi__k">人数</div>
              <div className="kpi__v">
                {plan.travelers}
                <small>人</small>
              </div>
            </div>
            <div>
              <div className="kpi__k">预估总价</div>
              <div className="kpi__v">{fmt(total)}</div>
            </div>
            <div>
              <div className="kpi__k">预算{diff >= 0 ? '结余' : '超出'}</div>
              <div className={`kpi__v ${diff >= 0 ? 'is-good' : 'is-over'}`}>
                {diff >= 0 ? '+' : '−'}
                {fmt(Math.abs(diff))}
              </div>
            </div>
          </div>

          <div className="bar">
            {segs.map((s) => (
              <div
                className="bar__seg"
                key={s.k}
                style={{ width: `${(s.value / sum) * 100}%`, background: BUDGET_COLORS[s.k] }}
              />
            ))}
          </div>
          <div className="bar__legend">
            {segs.map((s) => (
              <span className="bar__item" key={s.k}>
                <i className="bar__dot" style={{ background: BUDGET_COLORS[s.k] }} />
                {BUDGET_LABELS[s.k]}
                <b>{fmt(s.value)}</b>
              </span>
            ))}
          </div>
          {plan.transport_note && (
            <p className="meta" style={{ margin: '12px 0 0' }}>
              {plan.transport_note}
            </p>
          )}
        </div>

        <div className="card">
          <div className="days">
            {plan.daily_plans.map((d, i) => (
              <button
                className={`day ${i === day ? 'is-on' : ''}`}
                key={d.date + i}
                onClick={() => setDay(i)}
              >
                <i className="day__dot" style={{ background: DAY_COLORS[i % 6] }} />
                <span>第 {i + 1} 天</span>
                <b>{monthDay(d.date)}</b>
                <span>{d.weather?.condition}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="day-head">
            <h3>
              第 {day + 1} 天 · {current?.date} {weekday(current?.date ?? '')}
            </h3>
            <span className="meta">
              {current?.weather?.condition} {current?.weather?.temp}
              {current?.hotel ? ` · 住 ${current.hotel.name}` : ' · 当天返程'}
            </span>
          </div>

          {current && current.timeline.length > 0 ? (
            <ol className="timeline">
              {current.timeline.map((item, ii) => {
                // 用坐标当键（缘由见 lib/amap.ts 的 poiKey 注释）：删掉一项、
                // 或者后台体检重排了顺序，下标都会变，但「是哪个地方」没变 ——
                // 用下标的话高亮会落到邻居身上，地图还会飞错点。
                const loc = item.poi.location
                const key = loc ? poiKey(loc.lng, loc.lat) : null
                const hasGeo = key !== null && geoKeys.has(key)
                const focused = hasGeo && focus === key
                const pool = poolOf(plan, item.poi.type)
                return (
                <li
                  className={`tl ${focused ? 'is-focused' : ''} ${
                    hasGeo ? 'poi--clickable' : ''
                  }`}
                  key={`${item.poi.name}-${ii}`}
                  onClick={(e) => {
                    // 点里面的按钮（导航/替换/移除）不该触发地图定位
                    if ((e.target as HTMLElement).closest('button')) return
                    if (hasGeo) setFocus(focused ? null : key)
                  }}
                  title={hasGeo ? '点一下在地图上定位' : undefined}
                >
                  <div className="tl__time">{item.time}</div>
                  <div>
                    <h4 className="tl__name">
                      {item.poi.name}
                      {item.poi.rating ? <span className="meta">★ {item.poi.rating}</span> : null}
                      <span className="meta">{item.poi.type}</span>
                      {item.poi.tier ? <span className="meta">{item.poi.tier}</span> : null}
                    </h4>
                    {item.poi.description && <p className="tl__desc">{item.poi.description}</p>}
                    {/* 招牌菜与营业时间：高德本来就给，以前没存也没显示。
                        有了营业时间，用户一眼能看出"这家晚上还开不开门"。 */}
                    {((item.poi.tags?.length ?? 0) > 0 || item.poi.open_time || item.poi.cuisine) && (
                      <p className="tl__meta">
                        {item.poi.cuisine ? `${item.poi.cuisine}　` : ''}
                        {item.poi.tags?.slice(0, 4).join('、')}
                        {item.poi.tags?.length ? '　' : ''}
                        {item.poi.open_time ? `营业 ${item.poi.open_time}` : ''}
                      </p>
                    )}
                    {(item.tips || item.poi.tips) && (
                      <p className="tl__tips">{item.tips || item.poi.tips}</p>
                    )}
                    <div className="tl__foot">
                      <span className="tl__hop">
                        {item.transport_to_next
                          ? `${item.transport_to_next.mode} ${item.transport_to_next.duration}` +
                            (item.transport_to_next.cost
                              ? ` · ${fmt(item.transport_to_next.cost)}`
                              : '')
                          : '当天结束'}
                      </span>
                      <span className="tl__acts">
                        <button className="btn btn--link" onClick={() => void act('navigation', item.poi)}>
                          导航
                        </button>
                        <button className="btn btn--link" onClick={() => void act('dianping', item.poi)}>
                          点评
                        </button>
                        {item.poi.type === '住宿' && (
                          <button className="btn btn--link" onClick={() => void act('booking', item.poi)}>
                            预订
                          </button>
                        )}
                        {item.poi.type === '餐厅' && (
                          <button className="btn btn--link" onClick={() => void act('meituan', item.poi)}>
                            团购
                          </button>
                        )}
                        {pool && pool.list.length > 0 && (
                          <button
                            className="btn btn--link"
                            disabled={loading}
                            onClick={() =>
                              setReplacing({ name: item.poi.name, label: pool.label, options: pool.list })
                            }
                          >
                            替换
                          </button>
                        )}
                        <button className="btn btn--muted" onClick={() => removeItem(day, ii)}>
                          移除
                        </button>
                      </span>
                    </div>
                  </div>
                  {item.poi.photos?.[0] && (
                    <PoiThumb src={item.poi.photos[0]} alt={item.poi.name} />
                  )}
                </li>
                )
              })}
            </ol>
          ) : (
            <p className="meta" style={{ margin: '12px 0 0' }}>
              当天安排已全部移除。可用下方输入框让它重排。
            </p>
          )}

          {/* 当晚住宿：以前只在日期标题里塞了一行小字，等于没展示 */}
          {current?.hotel ? (
            <div
              className={`hotel ${hotelFocused ? 'is-focused' : ''} ${
                hotelFocusKey ? 'poi--clickable' : ''
              }`}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button')) return
                if (hotelFocusKey) setFocus(hotelFocused ? null : hotelFocusKey)
              }}
              title={hotelFocusKey ? '点一下在地图上定位' : undefined}
            >
              <div className="hotel__head">
                <span className="hotel__badge">住</span>
                <div style={{ minWidth: 0 }}>
                  <b>{current.hotel.name}</b>
                  <span className="meta">
                    {current.hotel.rating ? `★${current.hotel.rating}` : '评分待查'}
                    {current.hotel.price ? ` · ${fmt(current.hotel.price)}/晚` : ''}
                    {current.hotel.tier ? ` · ${current.hotel.tier}` : ''}
                  </span>
                </div>
              </div>

              {(current.hotel.photos?.length ?? 0) > 0 && (
                <div className="hotel__photos">
                  {current.hotel.photos!.slice(0, 3).map((src, k) => (
                    <img
                      key={k}
                      src={src}
                      alt=""
                      decoding="async"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                  ))}
                </div>
              )}

              <div className="hotel__foot">
                <span className="meta">
                  {current.date} 晚
                  {current.hotel.check_in ? ` · ${current.hotel.check_in} 入住` : ''}
                  {current.hotel.check_out ? ` · ${current.hotel.check_out} 退房` : ''}
                </span>
                <span className="hotel__acts">
                  <button className="btn btn--link" onClick={() => void act('navigation', current.hotel!)}>
                    导航
                  </button>
                  <button className="btn btn--link" onClick={() => void act('booking', current.hotel!)}>
                    预订
                  </button>
                  {plan.hotel_options.length > 0 && (
                    <button
                      className="btn btn--link"
                      disabled={loading}
                      onClick={() =>
                        setReplacing({
                          name: current.hotel!.name,
                          label: '酒店',
                          options: plan.hotel_options,
                        })
                      }
                    >
                      换一家
                    </button>
                  )}
                </span>
              </div>
            </div>
          ) : (
            <p className="meta" style={{ marginTop: 14 }}>
              当天返程，无住宿安排。
            </p>
          )}

          {(current?.plan_b || (current?.tips?.length ?? 0) > 0) && (
            <div className="notes">
              {current?.plan_b && (
                <p className="note">
                  <b>雨天备选　</b>
                  {current.plan_b}
                </p>
              )}
              {current?.tips?.map((t, i) => (
                <p className="note faint" key={i}>
                  {t}
                </p>
              ))}
            </div>
          )}
        </div>

        {hasRemoved && <p className="meta">当天已清空，可用下方输入框重排。</p>}

        <OptionsCard
          dining={plan.dining_options}
          hotel={plan.hotel_options}
          attraction={plan.attraction_options}
        />

        <ChecksCard
          plan={plan}
          loading={loading}
          settled={planner.checksSettled}
          notify={notify}
        />

        {replacing && (
          <ReplaceDialog
            target={replacing.name}
            typeLabel={replacing.label}
            options={replacing.options}
            disabled={loading}
            onPick={(name) => planner.swapOption(replacing.name, name)}
            onClose={() => setReplacing(null)}
          />
        )}
      </>
    )
  }

  return (
    <main className="pane pane--center">
      {/* 内容区自己滚，底部的「调整条件」是停靠栏而不是悬浮层，
          这样滚动过程中它永远不会压住行程内容 */}
      <div className="work-scroll">
        {loading && (
          <ProgressCard
            elapsed={elapsed}
            steps={planner.steps}
            stageNote={planner.stageNote}
            checking={checking}
            onCancel={planner.cancel}
            onCheckConnection={handleCheckConnection}
          />
        )}
        {body()}
      </div>

      {plan && (
        <div className="revise-wrap">
          <div className="revise">
            <input
              value={reviseText}
              onChange={(e) => setReviseText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submitRevise()
                }
              }}
              placeholder="调整条件，例如：预算压到 2500 / 第二天换成室内"
            />
            <button className="btn btn--primary btn--sm" onClick={submitRevise} disabled={loading}>
              修改
            </button>
          </div>
        </div>
      )}
    </main>
  )
}
