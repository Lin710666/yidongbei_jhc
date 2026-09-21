/**
 * 「滚到工作台里对应的那一块并高亮」。
 *
 * 用途：词云上的产物词（实时天气 / 费用明细 / 推荐池 / 雨天备选 / 一键跳转 …）
 * 现在点下去会调这里，把右侧滚到方案里真正对应的位置。
 * 这样词云就不只是一排"入口"，而是这个项目产出的目录。
 *
 * 三个注意点：
 *
 * 1. **滚动容器不是 window，而是 `#pane-tools`**（外壳的右侧面板，`.pane` 自带
 *    overflow-y:auto）。用 scrollIntoView 会把整个页面/舞台也带着滚，所以这里
 *    自己算相对面板的偏移。
 *
 * 2. **有些块要先生成方案、甚至先展开才存在**。比如「景点备选」平时不渲染，
 *    要点一下那一行的「换一个」才会出来；「餐饮推荐」要点「换一家餐厅」。
 *    所以这些目标先点一下按钮，等一帧（React 渲染完）再滚。
 *
 * 3. **没生成方案时不能装作滚到了**。找不到目标就返回 false，
 *    让外壳去提示"先生成方案" —— 静默地什么都不发生是最糟的。
 */

/**
 * 这几块平时不渲染，要先点一下展开按钮才会出现。
 * 一个目标可能有多种按钮文案（比如酒店那块，有酒店时是「更换酒店」、
 * 没有时是「🏨 选择酒店」），所以给一组候选。
 */
const CLICK_LABELS: Record<string, string[]> = {
  attraction: ['换一个'],
  dining: ['换一家餐厅'],
  hotel: ['更换酒店', '选择酒店'],
}

function norm(s: string): string {
  return String(s || '').replace(/\s+/g, '')
}

function hostEl(): HTMLElement | null {
  return document.getElementById('wenlv-planner')
}

/**
 * 在容器里按文字找一个元素，返回**最紧凑**的那个。
 *
 * 不能用「第一个 textContent 包含它的元素」—— 那多半会命中外层大容器：
 * 比如找「实时天气预报」，最外层那个 div 的 textContent 也包含这几个字，
 * 结果滚过去停在页面顶端，高亮也糊在整块内容上（实测就是滚到 67px 不动了）。
 * 取"文字最短的匹配元素"就能落到真正那一行上。
 */
function byText(root: HTMLElement, text: string): HTMLElement | null {
  const target = norm(text)
  let best: HTMLElement | null = null
  let bestLen = Infinity
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    const t = norm(el.textContent)
    if (!t.includes(target)) continue
    if (t.length < bestLen) {
      bestLen = t.length
      best = el
    }
  }
  return best
}

function findButton(root: HTMLElement, label: string): HTMLElement | null {
  const target = norm(label)
  return (
    [...root.querySelectorAll<HTMLElement>('button')].find((b) => norm(b.textContent).includes(target)) || null
  )
}

/** 按 target 找元素；找到就返回，找不到返回 null */
function locate(root: HTMLElement, target: string): HTMLElement | null {
  // ① 工作台表单里的字段（antd 会把 Form.Item 的 name 写成 input 的 id）
  const field = root.querySelector<HTMLElement>(`#${CSS.escape(target)}`)
  if (field) return field

  switch (target) {
    case 'chat':
      return root.querySelector<HTMLElement>('input[placeholder*="带80岁老人"]')
    case 'overview':
      // 概览卡：有「总预算估算」那个 Statistic 的卡片
      return byText(root, '总预算估算')
    case 'cost':
      // 叫 cost 不叫 budget：工作台表单里有个 id=udget 的输入框，
      // 同名的话 locate 第一步的 `#budget` 会先把表单那个框命中，滚到表单去了。
      return root.querySelector<HTMLElement>('.ant-statistic')
    case 'weather':
      return byText(root, '实时天气预报')
    case 'timeline':
      return root.querySelector<HTMLElement>('.ant-timeline')
    case 'tips':
      return byText(root, '游玩贴士')
    case 'map':
      return root.querySelector<HTMLElement>('svg[viewBox="0 0 640 400"]')
    case 'conflict':
      return (
        byText(root, '是否采纳建议') ||
        byText(root, '一键采纳建议') ||
        root.querySelector<HTMLElement>('.ant-alert-warning')
      )
    case 'planb':
      return byText(root, '一键换成室内') || byText(root, '室内')
    case 'jump':
      return findButton(root, '导航') || byText(root, '导 航')
    case 'toolbar':
      return findButton(root, '保存计划')
    // 下面三块要先展开才存在（展开逻辑在 focusTarget 里），
    // 展开后靠"挑选按钮"的文字来认：餐饮是「换这家」、景点是「换这个」、酒店是「选这家」
    case 'dining':
      return byText(root, '换这家')
    case 'attraction':
      return byText(root, '换这个')
    case 'hotel':
      return byText(root, '选这家')
    default:
      return null
  }
}

/** 滚到元素：相对左侧外壳的面板算偏移，别用 scrollIntoView（那会把整页也滚走） */
function scrollTo(root: HTMLElement, el: HTMLElement): void {
  const pane = document.getElementById('pane-tools') || root
  const top =
    el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop - 24
  pane.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })

  // 高亮一下，免得滚过去之后不知道要看哪
  el.classList.add('wenlv-focus-flash')
  setTimeout(() => el.classList.remove('wenlv-focus-flash'), 1600)
}

/**
 * 对外入口。
 * @returns true = 找到并滚过去了；false = 还没生成方案（或这块暂时不存在）
 */
export function focusTarget(target: string): boolean {
  const root = hostEl()
  if (!root) return false

  const el = locate(root, target)
  if (el) {
    scrollTo(root, el)
    // 表单字段顺手聚焦一下，方便接着改
    if (el instanceof HTMLInputElement) el.focus({ preventScroll: true })
    return true
  }

  // 折叠类的块：先点开展开按钮，渲染完再找一次
  const labels = CLICK_LABELS[target]
  if (labels) {
    const btn = labels.map((l) => findButton(root, l)).find(Boolean)
    if (btn) {
      btn.click()
      setTimeout(() => {
        const inner = locate(root, target)
        if (inner) scrollTo(root, inner)
      }, 220)
      return true
    }
  }
  return false
}
