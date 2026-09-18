/**
 * verify-interactions.mjs —— v4.0 交互层验收
 *
 * 为什么单独有这一个：仓库里原有的 verify-browser / verify-look / verify-3d 是 3.1 时代写的，
 * 覆盖不到 4.0 改掉的交互。4.0 的核心变化全在词云的「渐进披露 + 选中与生成分离」和
 * 底部结果卡的排版上，这一份专门验这些。
 *
 * 用法：
 *   1. 先起服务（双击 start.bat，或 node server.js）
 *   2. node test/verify-interactions.mjs
 *   3. 需要 Playwright；本机没有会打印一句「跳过」而不是报错
 *
 * 端口可用 PORT 环境变量覆盖，默认 8000。
 */

import { loadPlaywrightOrSkip } from './_playwright.mjs'

const PORT = process.env.PORT || 8000
const BASE = `http://127.0.0.1:${PORT}`

const { chromium } = await loadPlaywrightOrSkip('verify-interactions.mjs（v4.0 交互验收）')

let pass = 0
const fails = []
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(8000)

  // ---------- 工具：找到词云上的某个词并返回它的位置与状态 ----------
  const probe = (word) => page.evaluate((w) => {
    const n = Array.from(document.querySelectorAll('#wordcloud-layer .wc-word'))
      .find((x) => x.textContent.replace(/\s+/g, '').includes(w))
    if (!n) return null
    const r = n.getBoundingClientRect()
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      text: n.textContent.trim(),
      role: n.dataset.role || '',
      group: n.dataset.group || '',
      opacity: +parseFloat(getComputedStyle(n).opacity).toFixed(2),
      selected: n.classList.contains('is-sel'),
      peek: n.classList.contains('is-peek'),
    }
  }, word)

  const clickWord = async (word) => {
    const q = await probe(word)
    if (!q) return null
    await page.mouse.move(q.x, q.y)
    await page.waitForTimeout(300)
    await page.mouse.click(q.x, q.y)
    await page.waitForTimeout(650)
    return probe(word)
  }

  console.log('\n【一、词云渐进披露】')

  const visible = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('#wordcloud-layer .wc-word'))
    const vis = all.filter((n) => parseFloat(getComputedStyle(n).opacity) > 0.05)
    const byRole = {}
    vis.forEach((n) => {
      const r = (n.dataset.role || 'member')
      byRole[r] = (byRole[r] || 0) + 1
    })
    return { total: all.length, visible: vis.length, byRole }
  })
  check('词云节点总数 68', visible.total === 68, `实际 ${visible.total}`)
  check('默认只露 17 个（12 个分组标签 + 5 个核心词）',
    visible.visible === 17 && visible.byRole.label === 12 && visible.byRole.core === 5,
    `实际可见 ${visible.visible}，label ${visible.byRole.label || 0} / core ${visible.byRole.core || 0}`)
  check('成员词默认不可见', !visible.byRole.member, `却有 ${visible.byRole.member || 0} 个可见`)

  const beforeHover = await probe('杭州')
  check('静止时「杭州」不可见', beforeHover && beforeHover.opacity === 0, `opacity=${beforeHover && beforeHover.opacity}`)

  const label = await probe('目的地')
  await page.mouse.move(label.x, label.y)
  await page.waitForTimeout(600)
  const afterHover = await probe('杭州')
  check('悬停「目的地」标签 → 该组成员半透明预览',
    afterHover && afterHover.opacity > 0 && afterHover.opacity < 1,
    `opacity=${afterHover && afterHover.opacity}`)

  await page.mouse.click(label.x, label.y)
  await page.waitForTimeout(650)
  const afterClick = await probe('杭州')
  check('点击标签 → 该组完全展开', afterClick && afterClick.opacity === 1, `opacity=${afterClick && afterClick.opacity}`)

  console.log('\n【二、选中与生成分离】')

  await clickWord('兴趣')
  const i1 = await clickWord('自然风光')
  const i2 = await clickWord('人文历史')
  check('「兴趣」组可多选（两个同时带红框）',
    !!(i1 && i1.selected && i2 && i2.selected),
    `自然风光=${i1 && i1.selected} 人文历史=${i2 && i2.selected}`)

  const c1 = await clickWord('杭州')
  const c2 = await clickWord('苏州')
  check('「目的地」组单选（点新的会顶掉旧的）',
    !!(c2 && c2.selected && !(await probe('杭州')).selected),
    `杭州选中=${(await probe('杭州')).selected} 苏州选中=${c2 && c2.selected}`)

  const coreBtn = await probe('个性化方案')
  check('点条件词不会触发生成（还没进结果模式）',
    !(await page.evaluate(() => document.body.classList.contains('wc-result'))))

  console.log('\n【三、游玩天数控件】')

  const daysWord = await probe('游玩天数')
  check('「游玩天数」是词云上的控件（带上下箭头）',
    !!(daysWord && /[▼▲]/.test(daysWord.text)),
    daysWord ? `实际文本「${daysWord.text}」` : '找不到该词')
  if (daysWord) {
    const before = await page.evaluate(() => {
      const el = document.querySelector('#plan-days')
      return el ? el.value : null
    })
    await page.mouse.move(daysWord.x, daysWord.y)
    await page.waitForTimeout(300)
    const up = await page.evaluate(() => {
      const n = Array.from(document.querySelectorAll('#wordcloud-layer .wc-word'))
        .find((e) => e.textContent.includes('游玩天数'))
      const steps = n.querySelectorAll('.wc-step')
      const el = steps[steps.length - 1]
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })
    await page.mouse.click(up.x, up.y)
    await page.waitForTimeout(700)
    const after = await page.evaluate(() => {
      const el = document.querySelector('#plan-days')
      return el ? el.value : null
    })
    const txt = (await probe('游玩天数')).text
    check('点 ▲ 后词云天数 +1，且同步到右侧表单',
      before !== null && Number(after) === Number(before) + 1,
      `${before} → ${after}，词云显示「${txt}」`)
  }

  console.log('\n【四、全屏结果卡】')

  await page.click('#wc-full')
  await page.waitForTimeout(1600)
  await clickWord('个性化方案')
  await page.waitForTimeout(1500)

  const stage = await page.evaluate(() => ({
    wcResult: document.body.classList.contains('wc-result'),
    cardHidden: document.getElementById('result-card').hidden,
    wcOpacity: +parseFloat(getComputedStyle(document.getElementById('wordcloud-layer')).opacity).toFixed(2),
    who: (document.getElementById('result-who') || {}).textContent || '',
    hasSpeak: !!document.getElementById('result-speak'),
  }))
  check('点核心词后进入结果模式（body.wc-result）', stage.wcResult)
  check('词云整体收起（opacity 归 0 且不接收点击）', stage.wcOpacity === 0, `opacity=${stage.wcOpacity}`)
  check('底部结果卡浮出', !stage.cardHidden)
  check('结果卡左上角写了角色名', !!stage.who.trim(), `实际「${stage.who}」`)
  check('结果卡右上角有朗读按钮', stage.hasSpeak)

  // 等生成真正结束。这里盯的是 S.busy，不是字数 —— 字数会在"⏳ 正在生成…"的
  // 占位文案上就超过阈值，容易误判。
  //
  // 超时给得比较宽：纯软件渲染的浏览器里，舞台动画会和 Ollama 抢 CPU，
  // 同一个请求可能从十几秒被拖到几分钟（见 docs/评分架构说明.md 的性能一节）。
  // 这是环境问题不是正确性问题，所以不该用紧超时判失败，只在结果不对时才判失败。
  const t0 = Date.now()
  let waited = 0
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(2000)
    waited = (Date.now() - t0) / 1000
    const busy = await page.evaluate(() => !!(window.__wenlv && window.__wenlv.state && window.__wenlv.state.busy))
    if (!busy) break
  }
  await page.waitForTimeout(1200)

  const bodyText = await page.evaluate(() => (document.getElementById('result-body') || {}).textContent || '')
  const len = bodyText.trim().length
  check('结果卡里真的写出了方案（不是占位文案）',
    len > 200 && !/正在调用本机大模型生成/.test(bodyText),
    `实际 ${len} 字，等待 ${waited.toFixed(0)}s${len <= 200 ? `，内容：「${bodyText.trim().slice(0, 40)}」` : ''}`)
  console.log(`    （这一次生成耗时 ${waited.toFixed(0)} 秒）`)

  // ---------- 排版规则：直接喂合成 HTML，不重复跑模型 ----------
  const layout = await page.evaluate(() => {
    const body = document.getElementById('result-body')
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width) } }
    const orig = body.innerHTML

    body.className = 'result-body output'
    body.innerHTML = '<h1>方案</h1><h2>行程总览</h2><table><tr><td>a</td></tr></table>'
      + '<h2>Day 1 · 自然</h2><ul><li>x</li></ul><h2>Day 2 · 人文</h2><ul><li>y</li></ul>'
      + '<h2>费用预估</h2><table><tr><td>b</td></tr></table>'
    window.__wenlv.layoutResultBlock(body)
    const days = Array.from(body.querySelectorAll('.result-day')).map((d) => r(d))
    const blocks = Array.from(body.querySelectorAll('.result-block')).map((b) => r(b))
    const cls1 = body.className

    body.className = 'result-body output'
    body.innerHTML = '<h1>文案</h1><h2>版本 A</h2><p>a</p><h2>版本 B</h2><p>b</p>'
    window.__wenlv.layoutResultBlock(body)
    const cols = Array.from(body.querySelectorAll('.result-col')).map((c) => r(c))
    const cls2 = body.className

    body.className = 'result-body output'
    body.innerHTML = orig
    window.__wenlv.layoutResultBlock(body)
    return { days, blocks, cls1, cols, cls2 }
  })

  check('行程方案：Day 块并排成一行', layout.days.length >= 2 && layout.days[0].y === layout.days[1].y,
    layout.days.map((d) => `y=${d.y}`).join(' / '))
  check('行程方案：其余块各占整行（比 Day 块宽一倍左右）',
    layout.blocks.length >= 1 && layout.days.length >= 1 && layout.blocks[0].w > layout.days[0].w * 1.6,
    `整行 ${layout.blocks[0] && layout.blocks[0].w} vs Day ${layout.days[0] && layout.days[0].w}`)
  check('营销文案：版本 A / B 分成两列', layout.cols.length === 2 && layout.cols[1].x > layout.cols[0].x,
    `列 x: ${layout.cols.map((c) => c.x).join(', ')}`)
  check('两套排版各自带上正确的类名',
    layout.cls1.includes('is-days') && layout.cls2.includes('is-columns'),
    `${layout.cls1} | ${layout.cls2}`)

  console.log('\n【五、词云字色】')

  const ink = await page.evaluate(() => {
    const layer = document.getElementById('wordcloud-layer')
    const before = getComputedStyle(layer).getPropertyValue('--wc-ink').trim()
    const sel = document.getElementById('wc-ink')
    if (!sel) return { before, after: before, hasSelect: false }
    sel.value = 'custom'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    const custom = document.getElementById('wc-ink-custom')
    if (custom) { custom.value = '#ff8800'; custom.dispatchEvent(new Event('input', { bubbles: true })) }
    return { before, after: getComputedStyle(layer).getPropertyValue('--wc-ink').trim(), hasSelect: true }
  })
  check('有字色选择器', ink.hasSelect)
  check('改字色后 --wc-ink 跟着变（配色全库由它推导）',
    ink.hasSelect && ink.before !== ink.after,
    `${ink.before} → ${ink.after}`)

  check('全程没有 JS 报错', pageErrors.length === 0, pageErrors.slice(0, 2).join(' ; '))
} finally {
  await browser.close()
}

console.log('\n' + '─'.repeat(60))
console.log(`结果：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) {
  console.log('失败项：')
  fails.forEach((f) => console.log('  - ' + f))
}
process.exit(fails.length ? 1 : 0)
