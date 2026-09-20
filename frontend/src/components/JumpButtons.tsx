/**
 * JumpButtons —— 单个 POI 旁的一键跳转组件
 *
 * 需求：按 POI 类型提供差异化跳转入口：
 *  - 景点（含博物馆）：仅「导航」（打开高德地图路线页，可查看景区图片并一键打车）
 *  - 餐厅 / 住宿 / 购物：导航 + 大众点评 + 美团（点击直接搜到该门店主页）
 *  - 交通节点：不提供跳转
 *
 * 唤起失败走完整降级链（见 useAppJump）：Scheme -> 2 秒超时检测 -> H5 -> 复制口令。
 */
import { useState } from 'react'
import { Button, Space } from 'antd'
import { useAppJump, type AppTarget } from '../hooks/useAppJump'
import type { POI, PoiType } from '../types/plan'

const TARGET_LABEL: Record<AppTarget, string> = {
  navigation: '导航',
  dianping: '点评',
  meituan: '美团',
  booking: '携程',
  tujia: '途家',
}

// POI 类型 -> 可用跳转动作：景点仅导航；餐厅点评+美团；酒店携程+途家；交通无跳转
function actionsForType(type: PoiType): AppTarget[] {
  switch (type) {
    case '景点':
      return ['navigation']
    case '餐厅':
      return ['navigation', 'dianping', 'meituan']
    case '住宿':
      return ['navigation', 'booking', 'tujia']
    case '购物':
      return ['navigation', 'dianping', 'meituan']
    case '交通':
      return []
  }
}

export default function JumpButtons({ poi }: { poi: POI }) {
  const { jump, copyKeyword } = useAppJump()
  const [notice, setNotice] = useState<string | null>(null)
  const [manual, setManual] = useState<{ target: AppTarget; text: string } | null>(null)

  // 无有效坐标时，导航（依赖经纬度）不可用，仅保留按名称搜索的入口
  const hasLocation = poi.location.lat !== 0 || poi.location.lng !== 0
  const actions = actionsForType(poi.type).filter((t) => t !== 'navigation' || hasLocation)

  const handleJump = async (target: AppTarget) => {
    setNotice(null)
    setManual(null)
    const res = await jump(target, {
      name: poi.name,
      lat: poi.location.lat,
      lng: poi.location.lng,
      city: poi.city,
    })
    setNotice(res.message)
    if (res.needManual && res.copyText) setManual({ target, text: res.copyText })
  }

  const handleCopy = async () => {
    if (!manual) return
    await copyKeyword(manual.target, { name: manual.text, lat: 0, lng: 0 })
    setNotice('口令已复制，请打开对应 App 搜索')
    setManual(null)
  }

  if (actions.length === 0) return null

  return (
    <div style={{ marginTop: 4 }}>
      <Space size={4} wrap>
        {actions.map((target) => (
          <Button
            key={target}
            type={target === 'navigation' ? 'primary' : 'default'}
            size="small"
            onClick={() => handleJump(target)}
          >
            {TARGET_LABEL[target]}
          </Button>
        ))}
      </Space>
      {notice && (
        <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
          {notice}
          {manual && (
            <Button type="link" size="small" style={{ padding: '0 4px' }} onClick={handleCopy}>
              复制口令
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
