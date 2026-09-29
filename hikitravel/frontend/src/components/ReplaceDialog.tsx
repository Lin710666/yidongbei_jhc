import { createPortal } from 'react-dom'
import type { POI } from '../types/plan'
import { fmt } from '../lib/format'

interface Props {
  /** 要替换掉的那一项（当前行程里的具体名称） */
  target: string
  typeLabel: string
  options: POI[]
  disabled?: boolean
  onPick: (name: string) => void
  onClose: () => void
}

// 替换候选弹窗。
//
// 之前这里是「备选池里点一下替换」——只说了「把第 N 天的餐厅换掉」，
// 既没指明换哪一个，也没让用户挑哪个顶上，大模型只能猜。
// 现在改成：从行程里具体某一项点「替换」，再明确选一个候选，
// 提交的是「把第 N 天的『A』换成『B』」，指代清楚、可复现。
export default function ReplaceDialog({
  target,
  typeLabel,
  options,
  disabled,
  onPick,
  onClose,
}: Props) {
  return createPortal(
    <div className="modal" onClick={onClose}>
      <div className="modal__box" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <div>
            <h3>把「{target}」换成…</h3>
            <p className="meta">从{typeLabel}备选里挑一个，确认后按新条件重新生成这版行程</p>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="关闭">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="modal__body">
          {options.length === 0 && (
            <p className="meta" style={{ padding: 12 }}>暂无可替换的{typeLabel}</p>
          )}
          {options.map((o, i) => (
            <button
              className="cand"
              key={`${o.name}-${i}`}
              disabled={disabled || o.name === target}
              onClick={() => {
                onPick(o.name)
                onClose()
              }}
            >
              {o.photos?.[0] ? (
                <img src={o.photos[0]} alt="" loading="lazy" />
              ) : (
                <span className="cand__ph" />
              )}
              <span className="cand__body">
                <b>{o.name}</b>
                <span className="meta">
                  {o.rating ? `★${o.rating}` : '评分待查'}
                  {o.price ? ` · ${fmt(o.price)}` : ''}
                  {o.tier ? ` · ${o.tier}` : ''}
                  {o.name === target ? ' · 当前选项' : ''}
                </span>
                {o.description && <span className="meta cand__desc">{o.description}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
