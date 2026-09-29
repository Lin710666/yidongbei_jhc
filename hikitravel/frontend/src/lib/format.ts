/** 展示层格式化工具。 */

/** 金额：¥4,680 */
export const fmt = (n: number): string => '¥' + Math.round(n).toLocaleString('zh-CN')

/** 星期：2026-04-03 -> 周五 */
export const weekday = (iso: string): string =>
  ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][
    new Date(iso + 'T00:00:00').getDay()
  ] ?? ''

/** 月日：2026-04-03 -> 04/03 */
export const monthDay = (iso: string): string => iso.slice(5).replace('-', '/')

/** 地图按天着色：iOS 系统色，浅深色下都有足够对比 */
export const DAY_COLORS = ['#0071e3', '#34aadc', '#ff9500', '#ff3b30', '#34c759', '#af52de']

/** 预算分段配色，与后端 budget_breakdown 的四个字段一一对应 */
export const BUDGET_COLORS: Record<string, string> = {
  transport: '#0071e3',
  tickets: '#34aadc',
  dining: '#ff9500',
  hotel: '#34c759',
}

export const BUDGET_LABELS: Record<string, string> = {
  transport: '交通',
  tickets: '门票',
  dining: '餐饮',
  hotel: '住宿',
}

/** 难度标签配色跟随严重度 */
export const severityOf = (s: string): 'high' | 'medium' | 'low' =>
  s === 'high' || s === 'low' ? s : 'medium'
