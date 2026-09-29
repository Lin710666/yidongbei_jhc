import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { searchAttractions, type AttractionTip } from '../api/client'
import type { MustVisit } from '../types/preference'

interface Props {
  value: MustVisit[]
  /** 目的地（或它的 adcode）：用来把候选限制在这座城市内 */
  city: string
  disabled?: boolean
  onChange: (items: MustVisit[]) => void
}

const DEBOUNCE_MS = 260
const MENU_MIN_WIDTH = 268
const MENU_GAP = 6
const MENU_MAX_HEIGHT = 260

/**
 * 必去景点选择器。
 *
 * 为什么要有它：这些景点是"必须安排进去"的硬约束，而用户写的名字与高德 POI
 * 的名字经常对不上（「雷峰塔」/「雷峰塔景区」、「西湖」/「杭州西湖风景名胜区」）。
 * 以前只能在后端按名字模糊匹配，匹配不上就退化成没有坐标的占位点——
 * 排不进路线、也画不到地图上。从下拉选定具体地点后，坐标就是权威，不再靠猜。
 *
 * 和目的地的选择器一样，它只是「建议层」：手输的照样能提交（后端按名字解析），
 * 不会把想去小众地点的人挡在门外。所以手输的条目不点亮「已锁定坐标」的小圆点。
 *
 * 候选来自 /places/attractions（按景点分类码过滤），而不是目的地用的 inputtips：
 * 后者不认类型，同一个词「长江澳」会返回「自然地名·海湾海峡」——坐标是海湾中心，
 * 标在地图上落在海里；同一批里还有好几个停车场。
 */
export default function MustVisitPicker({ value, city, disabled, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [tips, setTips] = useState<AttractionTip[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState(-1)
  const [rect, setRect] = useState<DOMRect | null>(null)

  // 目的地没填时无法限定城市，候选会跨省混进来，所以先禁用
  const blocked = Boolean(disabled) || !city.trim()

  /* 防抖 + 取消上一次请求，避免每敲一个字就打一次高德 */
  useEffect(() => {
    const q = text.trim()
    if (!open || blocked) return
    if (!q) {
      setTips([])
      setFailed(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const list = await searchAttractions(q, city.trim(), controller.signal)
        if (controller.signal.aborted) return
        setTips(list)
        setFailed(false)
        setActive(list.length ? 0 : -1)
      } catch {
        if (controller.signal.aborted) return
        setTips([])
        setFailed(true)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [text, open, blocked, city])

  /* 左栏是滚动容器，菜单必须 portal 到 body 才不会被裁掉 */
  useEffect(() => {
    if (!open) return
    const update = () => setRect(inputRef.current?.getBoundingClientRect() ?? null)
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (inputRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const add = (item: MustVisit) => {
    const name = item.name.trim()
    if (!name) return
    // 同名只留一个：后端也会去重，但这里挡住能让用户立刻看到结果
    if (!value.some((v) => v.name === name)) onChange([...value, { ...item, name }])
    setText('')
    setTips([])
    setOpen(false)
  }

  const remove = (name: string) => onChange(value.filter((v) => v.name !== name))

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
      return
    }
    if (e.key === 'Backspace' && !text && value.length) {
      remove(value[value.length - 1].name)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (!tips.length) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((cur) => (cur + step + tips.length) % tips.length)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (open && active >= 0 && tips[active]) {
        const tip = tips[active]
        add({ name: tip.name, adcode: tip.adcode, lat: tip.lat, lng: tip.lng })
        return
      }
      // 候选里没有想要的：按手输处理，由后端按名字解析
      add({ name: text, adcode: '', lat: null, lng: null })
    }
  }

  let menu = null
  if (open && rect && !blocked) {
    const width = Math.min(Math.max(rect.width, MENU_MIN_WIDTH), window.innerWidth - 16)
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - 8
    const openUp = spaceBelow < 180 && rect.top > 260
    const vertical = openUp
      ? { bottom: window.innerHeight - rect.top + MENU_GAP, maxHeight: rect.top - MENU_GAP - 8 }
      : { top: rect.bottom + MENU_GAP, maxHeight: Math.min(spaceBelow, MENU_MAX_HEIGHT) }

    menu = createPortal(
      <div className="picker__menu" ref={menuRef} role="listbox" style={{ left, width, ...vertical }}>
        {loading && tips.length === 0 && <div className="picker__hint">搜索中…</div>}
        {!loading && failed && <div className="picker__hint">候选获取失败，可直接回车按手输添加</div>}
        {!loading && !failed && tips.length === 0 && (
          <div className="picker__hint">没有匹配的地方，回车可按手输添加</div>
        )}
        {tips.map((tip, i) => (
          <div
            key={`${tip.adcode}-${tip.name}-${i}`}
            className={`picker__item ${i === active ? 'is-active' : ''}`}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => add({ name: tip.name, adcode: tip.adcode, lat: tip.lat, lng: tip.lng })}
          >
            <div className="picker__row">
              <span className="picker__name">{tip.name}</span>
              <span className="picker__kind">
                {tip.rating ? `★${tip.rating}` : '景点'}
              </span>
            </div>
            <span className="picker__path">
              {tip.district}
              {tip.address ? ` · ${tip.address}` : ''}
            </span>
          </div>
        ))}
      </div>,
      document.body,
    )
  }

  return (
    <div className="mv">
      {value.length > 0 && (
        <span className="mv__chips">
          {value.map((item) => {
            const pinned = item.lat != null && item.lng != null
            return (
              <span
                className={`mv__chip ${pinned ? 'is-pinned' : ''}`}
                key={item.name}
                title={pinned ? '已锁定坐标，不会再按名字猜' : '手输名称，将由后端按名字解析位置'}
              >
                {pinned && <i className="mv__pin" />}
                {item.name}
                <button
                  type="button"
                  className="mv__x"
                  disabled={disabled}
                  aria-label={`移除 ${item.name}`}
                  onClick={() => remove(item.name)}
                >
                  ×
                </button>
              </span>
            )
          })}
        </span>
      )}
      <input
        ref={inputRef}
        className="picker__input"
        value={text}
        disabled={blocked}
        placeholder={
          blocked ? '先填写目的地，再选景点' : '搜索景点，或在候选里选择（可回车手输）'
        }
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => {
          setText(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          if (text.trim()) setOpen(true)
        }}
        onKeyDown={onKeyDown}
      />
      {menu}
    </div>
  )
}
