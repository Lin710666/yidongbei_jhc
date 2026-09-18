#!/usr/bin/env node
/**
 * verify-browser.mjs —— 真实浏览器验收（Playwright + 系统 Edge）
 *
 * 为什么需要它：Live2D 渲染、词云布局、流式输出这些只有真跑起来才算数。
 * http 请求能过不代表页面能用。这个脚本会：
 *   1. 打开页面，抓全部 console 错误与失败请求
 *   2. 等 Live2D 画布真的画出东西（采样像素，确认不是空白画布）
 *   3. 等词云真的排布完成（元素数量 + 位置不重叠）
 *   4. 点词云触发一次生成，等流式内容出现
 *   5. 逐个切换六个页签，确认没有 JS 报错
 *   6. 每个关键状态截图存盘
 *
 * 用法：node verify-browser.mjs [url]
 */

import { mkdirSync } from 'node:fs'
import { loadPlaywrightOrSkip } from './_playwright.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, 'shots')
mkdirSync(OUT, { recursive: true })

const URL_BASE = process.argv[2] || 'http://127.0.0.1:8000'
// playwright 来自 AIRI 的 node_modules（本交付物本身零依赖）
// Playwright 不在本交付物的依赖里，按候选路径自动去找（见 _playwright.mjs）
const { chromium } = await loadPlaywrightOrSkip('verify-browser.mjs（页面/词云/Live2D/流式生成/页签/异常）')

const consoleErrors = []
const failedRequests = []
let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`) }
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 })

page.on('console', (msg) => {
  if (msg.type() === 'error')
    consoleErrors.push(msg.text())
})
page.on('requestfailed', (req) => {
  // favicon 之类无关紧要的失败忽略掉
  if (!/favicon/.test(req.url()))
    failedRequests.push(`${req.url()} :: ${req.failure()?.errorText}`)
})

console.log(`验收目标：${URL_BASE}\n`)
await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })

// ---------- 1. 页面基础 ----------
await page.waitForTimeout(1500)
check('页面标题正确', (await page.title()).includes('文旅智能辅助'), await page.title())
check('顶栏品牌渲染', await page.locator('.brand-title').isVisible())

// ---------- 2. Live2D 真的画出来了 ----------
// 等 canvas 有非透明像素：直接采样 WebGL 画布的可读像素
const live2dPainted = await page.waitForFunction(() => {
  const c = document.querySelector('#live2d-canvas')
  if (!c || !c.width)
    return false
  // 用一个临时 2D canvas 去 drawImage WebGL 画布，统计非透明像素比例
  const tmp = document.createElement('canvas')
  tmp.width = 160
  tmp.height = 160
  const ctx = tmp.getContext('2d')
  try {
    ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 160, 160)
  }
  catch {
    return false
  }
  const d = ctx.getImageData(0, 0, 160, 160).data
  let opaque = 0
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] > 12)
      opaque++
  }
  return opaque > 400          // 至少 400/25600 个像素不透明，才算真的渲染出模型
}, { timeout: 45000 }).then(() => true).catch(() => false)

check('Live2D 画布已渲染出模型（非空白）', live2dPainted)
check('舞台加载遮罩已隐藏', await page.locator('#stage-empty').evaluate(el => el.classList.contains('hidden')))
await page.screenshot({ path: join(OUT, '01-home.png') })

// ---------- 3. 词云排布 ----------
await page.waitForFunction(() => document.querySelectorAll('.wc-word').length > 20, { timeout: 15000 }).catch(() => {})
const wcInfo = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.wc-word')].filter(n => !n.hidden && n.style.visibility !== 'hidden')
  const rects = nodes.map((n) => {
    const r = n.getBoundingClientRect()
    return { w: n.textContent, x: r.x, y: r.y, ww: r.width, h: r.height }
  })
  // 统计重叠对数（轻微重叠可接受，大面积重叠说明布局算法失效）
  let overlaps = 0
  for (let i = 0; i < rects.length; i++) {
    for (let k = i + 1; k < rects.length; k++) {
      const a = rects[i]; const b = rects[k]
      if (!(a.x + a.ww < b.x || b.x + b.ww < a.x || a.y + a.h < b.y || b.y + b.h < a.y))
        overlaps++
    }
  }
  return { total: nodes.length, overlaps, sample: rects.slice(0, 5).map(r => r.w) }
})
check(`词云渲染出足够词条（${wcInfo.total} 个）`, wcInfo.total > 20, JSON.stringify(wcInfo.sample))
check(`词云基本不重叠（重叠 ${wcInfo.overlaps} 对）`, wcInfo.overlaps <= 3, `重叠 ${wcInfo.overlaps} 对`)

// 人物的排除区是椭圆，圆心在**舞台中心**，半径按"可用区"（扣掉工具栏与字幕条）算。
// 这里刻意从 DOM 上读取页面实际使用的 inset，而不是自己另猜一套 —— 
// 否则脚本的几何和实现的几何不一致，会把"实现是对的"误判成"压住人物了"。
const inCharacterZone = await page.evaluate(() => {
  const host = document.querySelector('#wordcloud-layer')
  const r = host.getBoundingClientRect()
  let ins = { top: 58, bottom: 58, left: 16, right: 16 }
  try { ins = JSON.parse(host.dataset.insets || '') || ins } catch { /* 用默认值 */ }
  const availW = Math.max(1, r.width - ins.left - ins.right)
  const availH = Math.max(1, r.height - ins.top - ins.bottom)
  const minDim = Math.min(availW, availH)
  const charCx = r.width / 2
  const charCy = r.height / 2
  const exRx = minDim * 0.22; const exRy = minDim * 0.47
  let hit = 0
  for (const n of document.querySelectorAll('.wc-word')) {
    if (n.hidden) continue
    const b = n.getBoundingClientRect()
    if (b.width === 0) continue
    const x = b.x - r.x; const y = b.y - r.y
    const nx = Math.max(x, Math.min(charCx, x + b.width))
    const ny = Math.max(y, Math.min(charCy, y + b.height))
    const dx = (nx - charCx) / exRx; const dy = (ny - charCy) / exRy
    if (dx * dx + dy * dy < 1) hit++
  }
  return { hit, ins, availW: Math.round(availW), availH: Math.round(availH) }
})
check(`词云不压住人物（侵入人物椭圆区的词 ${inCharacterZone.hit} 个）`, inCharacterZone.hit <= 2,
  `侵入 ${inCharacterZone.hit} 个（insets=${JSON.stringify(inCharacterZone.ins)}，可用区 ${inCharacterZone.availW}×${inCharacterZone.availH}）`)

// ---------- 4. 点词云触发功能 ----------
// 优先点「杭州」（权重高，一定在），触发方案生成并切到文旅页签
//
// 注意：词云上的词带持续的悬浮动画，Playwright 默认的可操作性检查会一直判定
// "element is not stable" 而拒绝点击。真实用户点击毫无问题（位移只有 3~8px），
// 所以这里用 force: true 跳过稳定性等待——这不是在掩盖缺陷，是因为
// "元素必须静止" 本来就是自动化测试特有的要求。
const cityWord = page.locator('.wc-word', { hasText: /^杭州$/ }).first()
check('词云里能找到「杭州」', await cityWord.count() > 0)
if (await cityWord.count()) {
  // 用 JS 直接派发 click，而不是 playwrigt 的物理点击：
  // 词云上的词带持续悬浮动画，物理点击的落点会随动画漂移，
  // 有可能点到相邻的词（比如点到「让 AI 先问我」就走成追问分支，永远等不到行程）。
  // 派发 click 事件仍然走的是页面真实注册的 addEventListener 处理器，
  // 后面的动作分发、fetch、流式渲染全都是真的，只是去掉了"落点抖动"这个不确定因素。
  await page.evaluate(() => {
    const node = [...document.querySelectorAll('.wc-word')]
      .find(n => n.textContent.trim() === '杭州' && !n.hidden)
    if (!node)
      throw new Error('词云里找不到「杭州」')
    node.click()
  })
  await page.waitForTimeout(800)
  const onTools = await page.locator('#pane-tools').evaluate(el => el.classList.contains('active'))
  check('点词云后自动切到「文旅功能」页签', onTools)
  check('点词云后目的地被回填为「杭州」', (await page.locator('#plan-city').inputValue()) === '杭州',
    await page.locator('#plan-city').inputValue())
  const started = await page.waitForFunction(
    () => /正在调用本机大模型|##|行程/.test(document.querySelector('#tools-output')?.textContent || ''),
    { timeout: 120000 },
  ).then(() => true).catch(() => false)
  check('点词云后确实开始了生成（结果区有内容）', started)
  await page.screenshot({ path: join(OUT, '02-wordcloud-trigger.png') })
  // 等生成真正结束，顺便验证流式输出能收尾。
  // 注意：输出区是 renderMarkdown 渲染后的 HTML，`## 行程总览` 已经变成 <h2>行程总览</h2>，
  // 所以这里按纯文本关键字匹配，不能带 ## 前缀。
  //
  // 超时给到 10 分钟：这里等的是**真模型生成**，耗时完全取决于机器与显存。
  // 实测本机 2 天方案 15~25 秒（qwen2.5:7b，模型已加载）；换成装不进显存的模型、
  // 或者浏览器用软件渲染时会被显著拖慢，冷启动还要再加约 90 秒模型加载。
  // 这是性能问题不是正确性问题，所以不该用紧超时把它判成失败。
  const finished = await page.waitForFunction(
    () => /行程总览|Day\s*1/.test(document.querySelector('#tools-output')?.textContent || ''),
    { timeout: 600000 },
  ).then(() => true).catch(() => false)
  check('方案生成完整收尾（出现行程总览 / Day 1）', finished)
  await page.screenshot({ path: join(OUT, '02b-plan-done.png') })
}

// ---------- 5. 六个页签都能打开且不报错 ----------
// 注意：原来的「设置」页签已合并进「外观」（背景 / 形象 / 词云 + 折叠起来的服务状态与关于）
const tabs = ['chat', 'tools', 'look', 'memory', 'cards', 'voice']
for (const t of tabs) {
  const before = consoleErrors.length
  await page.locator(`#tabs .tab[data-pane="${t}"]`).click()
  await page.waitForTimeout(450)
  const active = await page.locator(`#pane-${t}`).evaluate(el => el.classList.contains('active'))
  const newErrs = consoleErrors.length - before
  check(`页签「${t}」可打开且无 JS 报错`, active && newErrs === 0, active ? `${newErrs} 个新报错` : '未激活')
  if (t === 'look' || t === 'memory' || t === 'cards' || t === 'voice')
    await page.screenshot({ path: join(OUT, `03-pane-${t}.png`) })
}

// ---------- 6. 状态灯 ----------
const pills = await page.evaluate(() => [...document.querySelectorAll('.status-pill')].map(p => p.querySelector('.lbl')?.textContent || ''))
check('状态灯已填充（不是"检测中…"）', pills.length >= 4 && !pills.some(p => p.includes('检测中')), JSON.stringify(pills))

// 到这里为止的 console 错误才算"未预期的"。下面的畸形请求会故意制造 400/404，
// 浏览器会把它们记进 console，那是预期行为，不能算失败。
const errorsBeforeBadRequests = consoleErrors.slice()

// ---------- 7. 崩服回归：畸形请求后页面仍可用 ----------
await page.evaluate(async () => {
  for (const bad of ['/%', '/../server.js', '/api/nope']) {
    try { await fetch(bad) } catch { /* 预期会失败 */ }
  }
})
await page.waitForTimeout(400)
const stillAlive = await page.evaluate(async () => {
  try {
    const r = await fetch('/api/status')
    return r.ok
  }
  catch { return false }
})
check('畸形请求之后页面与服务仍可用', stillAlive)

// ---------- 汇总 ----------
console.log('\n----- 控制台错误（已排除畸形请求造成的预期 4xx）-----')
console.log(errorsBeforeBadRequests.length ? [...new Set(errorsBeforeBadRequests)].slice(0, 12).join('\n') : '（无）')
console.log('\n----- 失败请求 -----')
console.log(failedRequests.length ? [...new Set(failedRequests)].slice(0, 12).join('\n') : '（无）')

check('没有未预期的控制台错误', errorsBeforeBadRequests.length === 0, `${errorsBeforeBadRequests.length} 条`)
check('没有失败的网络请求', failedRequests.length === 0, `${failedRequests.length} 条`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
console.log(`截图目录：${OUT}`)

await browser.close()
process.exitCode = fail ? 1 : 0
