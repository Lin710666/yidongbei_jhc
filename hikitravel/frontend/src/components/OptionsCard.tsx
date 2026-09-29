import { useState } from 'react'
import type { POI } from '../types/plan'
import { fmt } from '../lib/format'

type OptTab = 'dining' | 'hotel' | 'attraction'

const TABS: { key: OptTab; label: string; unit: string }[] = [
  { key: 'dining', label: '餐厅', unit: '/人' },
  { key: 'hotel', label: '酒店', unit: '/晚' },
  { key: 'attraction', label: '景点', unit: '/人' },
]

interface Props {
  dining: POI[]
  hotel: POI[]
  attraction: POI[]
}

// 备选池：只用于浏览候选。
//
// 替换入口故意不放在这里——从池子里点「替换」说不清是要换掉行程里的哪一项，
// 之前那条链路就是这么坏的（一天可能有好几家餐厅，大模型只能猜）。
// 现在替换统一从行程里具体某一项的「替换」按钮发起，见 ReplaceDialog。
export default function OptionsCard({ dining, hotel, attraction }: Props) {
  const [tab, setTab] = useState<OptTab>('dining')
  const cur = TABS.find((t) => t.key === tab) ?? TABS[0]
  const list = tab === 'dining' ? dining : tab === 'hotel' ? hotel : attraction

  return (
    <div className="card">
      <div className="card__head">
        <h2 className="card__title">备选</h2>
        <span className="meta">{list.length} 条</span>
      </div>
      <div className="segmented segmented--sm" style={{ marginBottom: 6 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={t.key === tab ? 'is-on' : ''}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="opts">
        {list.slice(0, 12).map((o, i) => (
          <div className="opt" key={`${o.name}-${i}`}>
            <span style={{ minWidth: 0 }}>
              <span className="opt__name">{o.name}</span>
              {o.description && <p className="opt__desc">{o.description}</p>}
            </span>
            <span className="opt__side">
              <span className="meta num">
                {o.rating ? `★${o.rating}` : ''}
                {o.price ? ` · ${fmt(o.price)}${cur.unit}` : ''}
              </span>
              {o.tier && <span className="meta">{o.tier}</span>}
            </span>
          </div>
        ))}
        {list.length === 0 && <p className="meta">暂无备选</p>}
      </div>
    </div>
  )
}
