import { useEffect, useState } from 'react'
import type { Planner } from '../hooks/usePlanner'
import type { Pace, Transportation, UserPreference } from '../types/preference'
import { monthDay } from '../lib/format'
import DestinationPicker from './DestinationPicker'
import MustVisitPicker from './MustVisitPicker'

type Mode = 'chat' | 'form' | 'history'

const PREFERENCES = ['人文历史', '自然风光', '美食', '娱乐']
const DIETARY = ['清真', '素食', '无海鲜', '不吃辣']
const PACES: Pace[] = ['悠闲', '适中', '特种兵']
const TRANSPORTS: Transportation[] = ['自驾', '高铁', '飞机', '本地']
const DAY_OPTIONS = [1, 2, 3, 4, 5, 6, 7]

const DEFAULT_FORM: UserPreference = {
  travelers: { adults: 2, children: 1, elderly: 0 },
  duration_days: 3,
  destination: '杭州',
  destination_adcode: '',
  transportation: '高铁',
  preferences: ['人文历史', '自然风光'],
  must_visit: [],
  pace: '适中',
  budget: 5000,
  dietary_restrictions: ['不吃辣'],
  start_date: '2026-04-03',
  departure_time: '09:00',
  return_hotel_time: '21:00',
}

const EXAMPLES = [
  '成都 5 天美食之旅，2 人，预算 6000',
  '西安 4 天人文历史，带孩子，节奏适中',
  '大理 3 天亲子游，不爬山，预算 4500',
]

interface Props {
  planner: Planner
  notify: (text: string) => void
}

export default function LeftRail({ planner, notify }: Props) {
  const { env, loading, plan, history, historyLoading } = planner
  const [mode, setMode] = useState<Mode>('chat')
  const [prompt, setPrompt] = useState('')
  const [form, setForm] = useState<UserPreference>(DEFAULT_FORM)
  const [touched, setTouched] = useState(false)

  /* 切到历史才拉列表，避免每次打开页面都打后端 */
  useEffect(() => {
    if (mode === 'history') void planner.refreshHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const patch = (part: Partial<UserPreference>) => {
    setForm((cur) => ({ ...cur, ...part }))
    setTouched(true)
  }

  const toggleIn = (list: string[], value: string) =>
    list.includes(value) ? list.filter((x) => x !== value) : [...list, value]

  /* 与后端 Orchestrator._require_basic_info 同一套必填口径，缺哪项就说哪项 */
  const submitForm = () => {
    const missing: string[] = []
    if (!form.destination.trim()) missing.push('目的地')
    if (form.duration_days < 1) missing.push('游玩天数')
    if (form.travelers.adults + form.travelers.children + form.travelers.elderly < 1)
      missing.push('出行人数')
    if (form.budget <= 0) missing.push('总预算')
    if (missing.length) {
      notify(`还缺少：${missing.join('、')}`)
      return
    }
    void planner.runForm(form)
  }

  const submitChat = () => {
    const text = prompt.trim()
    if (!text) {
      notify('请先输入一句话')
      return
    }
    // 只有用户真的改过表单，才把表单当「底」提交；否则会覆盖对话解析出的目的地
    void planner.runChat(text, touched ? form : undefined)
  }

  return (
    <aside className="pane pane--left">
      {env && !env.ollama_available && (
        <div className="alert">
          <i className="alert__dot" />
          <div>
            未检测到本地大模型（Ollama）。需求解析与规划生成都依赖大模型，请先启动 Ollama
            并拉取模型。
            <div className="alert__acts">
              <button className="btn btn--link" onClick={() => void planner.checkHealth()}>
                重新检测
              </button>
            </div>
          </div>
        </div>
      )}

      {env && !env.amap_configured && (
        <div className="alert">
          <i className="alert__dot" />
          <div>未检测到高德密钥（AMAP_API_KEY），实时 POI 与天气无法获取。</div>
        </div>
      )}

      {/* 预热进度：后端启动时在后台跑，跑完之前第一次生成要额外等预填充 */}
      {env?.ollama_warm?.state === 'warming' && (
        <div className="alert">
          <i className="alert__dot" />
          <div>
            正在预热本地大模型与提示词缓存（{env.ollama_warm.done}/
            {env.ollama_warm.total}）… 预热完成后首次生成会快很多。
          </div>
        </div>
      )}

      {env?.ollama_warm &&
        env.ollama_available &&
        (env.ollama_warm.state === 'failed' || env.ollama_warm.state === 'partial') && (
          <div className="alert">
            <i className="alert__dot" />
            <div>{env.ollama_warm.detail}</div>
          </div>
        )}

      <div className="card">
        <div className="segmented">
          <button className={mode === 'chat' ? 'is-on' : ''} onClick={() => setMode('chat')}>
            一句话
          </button>
          <button className={mode === 'form' ? 'is-on' : ''} onClick={() => setMode('form')}>
            精细填写
          </button>
          <button className={mode === 'history' ? 'is-on' : ''} onClick={() => setMode('history')}>
            历史
          </button>
        </div>

        {mode === 'chat' && (
          <div className="compose" style={{ marginTop: 14 }}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submitChat()
                }
              }}
              placeholder="例如：带 80 岁老人游杭州 3 天，节奏悠闲，预算 5000"
            />
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  className="example"
                  onClick={() => {
                    setPrompt(ex)
                    setTouched(false)
                  }}
                >
                  {ex}
                </button>
              ))}
            </div>
            <button className="btn btn--primary btn--block" onClick={submitChat} disabled={loading}>
              {loading ? '生成中…' : '生成规划'}
            </button>
          </div>
        )}

        {mode === 'form' && (
          <div style={{ marginTop: 10 }}>
            <p className="group-label">基本信息</p>
            <div className="fields">
              <div className="field">
                <span className="field__label">目的地</span>
                <DestinationPicker
                  value={form.destination}
                  adcode={form.destination_adcode}
                  disabled={loading}
                  onChange={(name, code) =>
                    patch({ destination: name, destination_adcode: code })
                  }
                />
              </div>
              <div className="field">
                <span className="field__label">出发日期</span>
                <input
                  className="mini"
                  type="date"
                  value={form.start_date}
                  onChange={(e) => patch({ start_date: e.target.value })}
                />
              </div>
              <div className="field">
                <span className="field__label">天数</span>
                <span className="segmented segmented--sm">
                  {DAY_OPTIONS.map((d) => (
                    <button
                      key={d}
                      className={form.duration_days === d ? 'is-on' : ''}
                      onClick={() => patch({ duration_days: d })}
                    >
                      {d}
                    </button>
                  ))}
                </span>
              </div>
              {(
                [
                  ['成人', 'adults'],
                  ['儿童', 'children'],
                  ['老人', 'elderly'],
                ] as const
              ).map(([label, key]) => (
                <div className="field" key={key}>
                  <span className="field__label">{label}</span>
                  <span className="stepper">
                    <button
                      onClick={() =>
                        patch({
                          travelers: {
                            ...form.travelers,
                            [key]: Math.max(0, form.travelers[key] - 1),
                          },
                        })
                      }
                    >
                      −
                    </button>
                    <span className="stepper__n">{form.travelers[key]}</span>
                    <button
                      onClick={() =>
                        patch({
                          travelers: { ...form.travelers, [key]: form.travelers[key] + 1 },
                        })
                      }
                    >
                      +
                    </button>
                  </span>
                </div>
              ))}
            </div>

            <p className="group-label">偏好与约束</p>
            <div className="fields">
              <div className="field field--stack">
                <span className="field__label">兴趣导向（可选，不选则各类都推荐）</span>
                <span className="chips">
                  {PREFERENCES.map((p) => (
                    <button
                      key={p}
                      className={`chip ${form.preferences.includes(p) ? 'is-on' : ''}`}
                      onClick={() => patch({ preferences: toggleIn(form.preferences, p) })}
                    >
                      {p}
                    </button>
                  ))}
                </span>
              </div>
              <div className="field">
                <span className="field__label">总预算</span>
                <input
                  className="mini num"
                  type="number"
                  min={0}
                  value={form.budget}
                  onChange={(e) => patch({ budget: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="field">
                <span className="field__label">节奏</span>
                <span className="segmented segmented--sm">
                  {PACES.map((p) => (
                    <button
                      key={p}
                      className={form.pace === p ? 'is-on' : ''}
                      onClick={() => patch({ pace: p })}
                    >
                      {p}
                    </button>
                  ))}
                </span>
              </div>
              <div className="field">
                <span className="field__label">往返交通</span>
                <span className="segmented segmented--sm">
                  {TRANSPORTS.map((t) => (
                    <button
                      key={t}
                      className={form.transportation === t ? 'is-on' : ''}
                      onClick={() => patch({ transportation: t })}
                    >
                      {t}
                    </button>
                  ))}
                </span>
              </div>
              <div className="field field--stack">
                <span className="field__label">饮食禁忌</span>
                <span className="chips">
                  {DIETARY.map((d) => (
                    <button
                      key={d}
                      className={`chip ${form.dietary_restrictions.includes(d) ? 'is-on' : ''}`}
                      onClick={() =>
                        patch({ dietary_restrictions: toggleIn(form.dietary_restrictions, d) })
                      }
                    >
                      {d}
                    </button>
                  ))}
                </span>
              </div>
              <div className="field field--stack">
                <span className="field__label">必去景点（可选，从候选里选更准）</span>
                {/* 候选限定在目的地城市内，所以目的地要先填 */}
                <MustVisitPicker
                  value={form.must_visit}
                  city={form.destination_adcode || form.destination}
                  disabled={loading}
                  onChange={(items) => patch({ must_visit: items })}
                />
              </div>
              <div className="field">
                <span className="field__label">每天出发</span>
                <input
                  className="mini"
                  type="time"
                  value={form.departure_time}
                  onChange={(e) => patch({ departure_time: e.target.value })}
                />
              </div>
              <div className="field">
                <span className="field__label">回酒店</span>
                <input
                  className="mini"
                  type="time"
                  value={form.return_hotel_time}
                  onChange={(e) => patch({ return_hotel_time: e.target.value })}
                />
              </div>
            </div>

            <button
              className="btn btn--primary btn--block"
              style={{ marginTop: 14 }}
              onClick={submitForm}
              disabled={loading}
            >
              {loading ? '生成中…' : '生成规划'}
            </button>
          </div>
        )}

        {mode === 'history' && (
          <div className="history-list" style={{ marginTop: 6 }}>
            {historyLoading && <p className="meta">加载中…</p>}
            {!historyLoading && history.length === 0 && <p className="meta">暂无历史计划</p>}
            {history.map((h) => (
              <div
                className={`history-item ${plan?.plan_id === h.plan_id ? 'is-on' : ''}`}
                key={h.plan_id}
              >
                <span style={{ minWidth: 0 }}>
                  <b>{h.summary || h.plan_id}</b>
                  <span className="meta">{h.created_at?.slice(0, 16)}</span>
                </span>
                <button className="btn btn--link" onClick={() => void planner.openPlan(h.plan_id)}>
                  {plan?.plan_id === h.plan_id ? '当前' : '打开'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
