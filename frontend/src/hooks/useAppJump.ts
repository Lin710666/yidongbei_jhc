/**
 * useAppJump —— 一键跳转与降级链路 Hook（比赛核心加分项）
 *
 * 需求文档「模块4 + 五、异常处理与降级策略」：
 * 点击 POI 弹出「导航 / 大众点评 / 一键预订」，调用手机本地 App。
 * 但唤起 App 在不同平台（iOS / Android / 微信）会失败，绝不能成为死胡同。
 *
 * 完整降级链路（必须实现）：
 *   步骤1 尝试唤起 App Scheme
 *   步骤2 2 秒超时检测，判定唤起失败
 *   步骤3 自动降级到网页版 H5
 *   步骤4 微信内无法唤起时，提示「在浏览器打开」+「复制口令」兜底
 *
 * 说明：下列 scheme 为常见方案示例，各 App 官方 scheme 可能调整，
 * 生产环境请以各开放平台的官方 scheme 文档为准，并在此集中配置。
 */
import { useCallback } from 'react'

// 跳转目标类型
export type AppTarget = 'navigation' | 'dianping' | 'meituan' | 'booking' | 'tujia'

// 待跳转的 POI
export interface JumpPoi {
  name: string
  lat: number
  lng: number
  city?: string
}

// 城市 + 店名 组合关键词：帮助点评/美团精准命中该门店（连锁品牌尤其需要）
const shopKeyword = (p: JumpPoi) => (p.city && !p.name.includes(p.city) ? `${p.city}${p.name}` : p.name)

// 跳转结果
export interface JumpResult {
  ok: boolean
  message: string
  needManual: boolean // 是否需要用户手动操作（浏览器打开 / 复制口令）
  copyText?: string
}

// 各 App 的唤起方案：scheme（优先）+ h5（降级）+ keyword（复制口令）
interface AppScheme {
  label: string
  iosScheme: (p: JumpPoi) => string
  androidScheme: (p: JumpPoi) => string
  h5: (p: JumpPoi) => string
  keyword: (p: JumpPoi) => string
}

const SCHEMES: Record<AppTarget, AppScheme> = {
  navigation: {
    label: '导航',
    iosScheme: (p) =>
      `iosamap://path?sourceApplication=travelplanner&dlat=${p.lat}&dlon=${p.lng}&dname=${encodeURIComponent(p.name)}&dev=0&t=0`,
    androidScheme: (p) =>
      `androidamap://route?sourceApplication=travelplanner&dlat=${p.lat}&dlon=${p.lng}&dname=${encodeURIComponent(p.name)}&dev=0&t=0`,
    h5: (p) =>
      `https://uri.amap.com/navigation?to=${p.lng},${p.lat},${encodeURIComponent(p.name)}&mode=car&coordinate=gaode`,
    keyword: (p) => p.name,
  },
  dianping: {
    label: '大众点评',
    iosScheme: (p) => `dianping://shoplist?keyword=${encodeURIComponent(shopKeyword(p))}`,
    androidScheme: (p) => `dianping://shoplist?keyword=${encodeURIComponent(shopKeyword(p))}`,
    h5: (p) => `https://www.dianping.com/search/keyword/0/${encodeURIComponent(shopKeyword(p))}`,
    keyword: (p) => p.name,
  },
  meituan: {
    label: '美团',
    iosScheme: (p) => `imeituan://www.meituan.com/search?q=${encodeURIComponent(shopKeyword(p))}`,
    androidScheme: (p) => `imeituan://www.meituan.com/search?q=${encodeURIComponent(shopKeyword(p))}`,
    h5: (p) => `https://www.meituan.com/s/${encodeURIComponent(shopKeyword(p))}`,
    keyword: (p) => p.name,
  },
  booking: {
    label: '携程',
    iosScheme: (p) => `ctrip://wireless/search/hotel?keyword=${encodeURIComponent(shopKeyword(p))}`,
    androidScheme: (p) => `ctrip://wireless/search/hotel?keyword=${encodeURIComponent(shopKeyword(p))}`,
    h5: (p) => `https://m.ctrip.com/webapp/hotel/hotellist?keyword=${encodeURIComponent(shopKeyword(p))}`,
    keyword: (p) => p.name,
  },
  tujia: {
    label: '途家',
    iosScheme: (p) => `tujia://search?q=${encodeURIComponent(shopKeyword(p))}`,
    androidScheme: (p) => `tujia://search?q=${encodeURIComponent(shopKeyword(p))}`,
    h5: (p) => `https://www.tujia.com/search/?keywords=${encodeURIComponent(p.name)}`,
    keyword: (p) => p.name,
  },
}

// UA 检测：区分 iOS / Android / 微信 / 移动端
export interface Env {
  isWeChat: boolean
  isIOS: boolean
  isAndroid: boolean
  isMobile: boolean
}

export function detectEnv(): Env {
  const ua = navigator.userAgent.toLowerCase()
  return {
    isWeChat: ua.includes('micromessenger'),
    isIOS: /iphone|ipad|ipod/.test(ua),
    isAndroid: ua.includes('android'),
    isMobile: /iphone|ipad|ipod|android/.test(ua),
  }
}

// 复制到剪贴板（含兼容降级）
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  }
}

export function useAppJump() {
  const jump = useCallback((target: AppTarget, poi: JumpPoi): Promise<JumpResult> => {
    const env = detectEnv()
    const cfg = SCHEMES[target]
    const scheme = env.isIOS ? cfg.iosScheme(poi) : cfg.androidScheme(poi)

    // 微信内 / 桌面端：无法走 App Scheme，直接 H5 / 手动兜底
    if (!env.isMobile || env.isWeChat) {
      return Promise.resolve(fallback(target, poi, env))
    }

    // 步骤1：尝试唤起 App，并用「页面退到后台」判断是否唤起成功
    let appOpened = false
    const onVisibility = () => {
      if (document.hidden) appOpened = true
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.location.href = scheme

    // 步骤2：2 秒超时检测
    return new Promise((resolve) => {
      window.setTimeout(() => {
        document.removeEventListener('visibilitychange', onVisibility)
        if (appOpened) {
          resolve({ ok: true, message: `已唤起${cfg.label}`, needManual: false })
        } else {
          resolve(fallback(target, poi, env)) // 步骤3：降级 H5
        }
      }, 2000)
    })
  }, [])

  const copyKeyword = useCallback(async (target: AppTarget, poi: JumpPoi) => {
    const cfg = SCHEMES[target]
    const ok = await copyText(cfg.keyword(poi))
    return ok
  }, [])

  return { jump, copyKeyword }
}

// 步骤3：H5 降级；步骤4：微信内提示「在浏览器打开」+「复制口令」
function fallback(target: AppTarget, poi: JumpPoi, env: Env): JumpResult {
  const cfg = SCHEMES[target]
  if (env.isWeChat) {
    return {
      ok: false,
      needManual: true,
      copyText: cfg.keyword(poi),
      message: `微信内无法直接打开${cfg.label}，请点击右上角「在浏览器中打开」，或复制口令后到${cfg.label} App 内搜索`,
    }
  }
  window.open(cfg.h5(poi), '_blank')
  return { ok: true, needManual: false, message: `已跳转到${cfg.label}网页版` }
}
