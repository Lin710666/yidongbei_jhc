import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { autocompletePlaces, type PlaceTip } from '../api/client'

interface Props {
  value: string
  adcode: string
  disabled?: boolean
  onChange: (name: string, adcode: string) => void
}

const DEBOUNCE_MS = 260
const MENU_MIN_WIDTH = 268
const MENU_GAP = 6
const MENU_MAX_HEIGHT = 300

/**
 * 目的地输入框：边打边出候选，点选后把 adcode 一并交给后端。
 *
 * 为什么要有这个下拉：用户的目的地写法千奇百怪（「福建平潭」「平潭岛」
 * 「平潭综合实验区」），而且「平潭」在全国既有福建福州的平潭县、
 * 也有广东惠州的平潭镇——同名歧义靠后端猜是在赌，只能由用户确认。
 * adcode 是高德的主键，选定之后一切字符串歧义都不存在了。
 *
 * 但它只是「建议层」：手输的仍然能直接提交，由后端解析链兜底，
 * 不会把想去小众地点的人挡在门外。
 */
export default function DestinationPicker({ value, adcode, disabled, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  /** 刚点选的名字：选完会触发一次 value 变化，别把它当成新输入又弹一次 */
  const selectedRef = useRef('')
  const [open, setOpen] = useState(false)
  const [tips, setTips] = useState<PlaceTip[]>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState(-1)
  const [rect, setRect] = useState<DOMRect | null>(null)

  /* 防抖 + 取消上一次请求：避免每次按键都打一次高德，把额度耗光 */
  useEffect(() => {
    const q = value.trim()
    if (!open || disabled) return
    if (q === selectedRef.current) return
    if (!q) {
      setTips([])
      setFailed(false)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const list = await autocompletePlaces(q, controller.signal)
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
  }, [value, open, disabled])

  /* 跟随输入框定位（左栏是滚动容器，菜单必须 portal 到 body 才不会被裁掉） */
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

  /* 点到外面就收起 */
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

  const choose = (tip: PlaceTip) => {
    selectedRef.current = tip.name
    onChange(tip.name, tip.adcode)
    setOpen(false)
    setTips([])
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false)
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
    if (e.key === 'Enter' && open && active >= 0 && tips[active]) {
      e.preventDefault()
      choose(tips[active])
    }
  }

  let menu = null
  if (open && rect) {
    const width = Math.min(Math.max(rect.width, MENU_MIN_WIDTH), window.innerWidth - 16)
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))
    const spaceBelow = window.innerHeight - rect.bottom - MENU_GAP - 8
    const openUp = spaceBelow < 180 && rect.top > 260
    const vertical = openUp
      ? { bottom: window.innerHeight - rect.top + MENU_GAP, maxHeight: rect.top - MENU_GAP - 8 }
      : { top: rect.bottom + MENU_GAP, maxHeight: Math.min(spaceBelow, MENU_MAX_HEIGHT) }

    menu = createPortal(
      <div
        className="picker__menu"
        ref={menuRef}
        role="listbox"
        style={{ left, width, ...vertical }}
      >
        {loading && tips.length === 0 && <div className="picker__hint">搜索中…</div>}
        {!loading && failed && (
          <div className="picker__hint">候选获取失败，可直接手输目的地</div>
        )}
        {!loading && !failed && tips.length === 0 && (
          <div className="picker__hint">没有匹配的地方</div>
        )}
        {tips.map((tip, i) => (
          <div
            key={`${tip.adcode}-${tip.name}-${i}`}
            className={`picker__item ${i === active ? 'is-active' : ''}`}
            role="option"
            aria-selected={i === active}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(tip)}
          >
            <div className="picker__row">
              <span className="picker__name">{tip.name}</span>
              <span className="picker__kind">{tip.kind}</span>
            </div>
            <span className="picker__path">{tip.district}</span>
          </div>
        ))}
      </div>,
      document.body,
    )
  }

  return (
    <div className="picker">
      <input
        ref={inputRef}
        className="picker__input"
        value={value}
        disabled={disabled}
        placeholder="例如：平潭"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => {
          selectedRef.current = ''
          onChange(e.target.value, '')
          setOpen(true)
        }}
        onFocus={() => {
          if (value.trim() && value.trim() !== selectedRef.current) setOpen(true)
        }}
        onKeyDown={onKeyDown}
      />
      {adcode && <span className="picker__code">{adcode}</span>}
      {menu}
    </div>
  )
}
