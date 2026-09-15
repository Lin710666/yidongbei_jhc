#!/usr/bin/env node
/**
 * verify-look.mjs —— 验收「界面整理 + 换背景 + 换形象」这三件事
 *
 * 检查的都是"肉眼能看到的效果"，而不是"接口返回 200"：
 *   · 舞台分层是否正确（背景在人物下面，字幕条在最上面）
 *   · 词云是否真的避开了顶部工具栏与底部字幕条（不重叠）
 *   · 背景选择器能否打开、是否有缩略图、点击后背景是否真的换了（采样像素对比）
 *   · 形象选择器能否打开、3 个模型是否都有预览图、点击后人物是否真的换了
 *   · 上传自定义背景是否落盘并出现在列表里
 *
 * 用法：node test/verify-look.mjs [baseUrl]
 */

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, 'shots')
mkdirSync(OUT, { recursive: true })
const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/+$/, '')

const { chromium } = await import('file:///E:/deepseck/src/airi/node_modules/playwright/index.mjs')

const consoleErrors = []
let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`) }
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().split('\n')[0]) })

console.log(`验收目标：${BASE}\n`)
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
// 等 Live2D 与词云都就绪
await page.waitForFunction(() => document.querySelectorAll('.wc-word').length > 15, { timeout: 60000 })
await page.waitForTimeout(2500)

/* ---------- 1. 舞台分层与新结构 ---------- */
const layers = await page.evaluate(() => {
  const z = (sel) => {
    const n = document.querySelector(sel)
    return n ? Number(getComputedStyle(n).zIndex) || 0 : null
  }
  return {
    bg: z('.stage-bg'),
    l2d: z('#live2d-canvas'),
    cloud: z('#wordcloud-layer'),
    top: z('.stage-top'),
    subtitle: z('.subtitle'),
    hasBubble: Boolean(document.querySelector('.bubble')),
    hasWcBar: Boolean(document.querySelector('.wc-bar')),
    hasSubtitle: Boolean(document.querySelector('#subtitle')),
    hasToolBtns: Boolean(document.querySelector('#open-bg') && document.querySelector('#open-model')),
    tabCount: document.querySelectorAll('#tabs .tab').length,
  }
})
check('背景层在最底、人物其次、词云再上、工具条与字幕条最上',
  layers.bg <= layers.l2d && layers.l2d <= layers.cloud && layers.cloud <= layers.top && layers.cloud <= layers.subtitle,
  JSON.stringify(layers))
check('旧的浮动气泡 .bubble 已移除', !layers.hasBubble)
check('旧的词云工具条 .wc-bar 已移除（并进顶部工具条）', !layers.hasWcBar)
check('底部字幕条存在', layers.hasSubtitle)
check('舞台工具条里有「背景」「形象」两个按钮', layers.hasToolBtns)
check(`页签数量收敛为 6 个（原来是 6 个但含设置）`, layers.tabCount === 6, `实际 ${layers.tabCount}`)

/* ---------- 2. 词云避开工具栏与字幕条 ---------- */
// 先让字幕出现，才能测"字幕在时不重叠"
await page.evaluate(() => {
  const btn = [...document.querySelectorAll('.wc-word')].find(n => n.textContent.trim() === '打招呼')
  if (btn) btn.click()
})
await page.waitForTimeout(1200)
const overlap = await page.evaluate(() => {
  const sub = document.querySelector('#subtitle')
  const top = document.querySelector('.stage-top')
  const sr = sub ? sub.getBoundingClientRect() : null
  const tr = top ? top.getBoundingClientRect() : null
  let hitTop = 0
  let hitSub = 0
  for (const n of document.querySelectorAll('.wc-word')) {
    if (n.hidden) continue
    const b = n.getBoundingClientRect()
    const inter = (r) => r && !(b.right < r.left || r.right < b.left || b.bottom < r.top || r.bottom < b.top)
    if (inter(tr)) hitTop++
    if (inter(sr)) hitSub++
  }
  return { hitTop, hitSub, subtitleVisible: sub ? sub.classList.contains('show') : false, subtitleText: sub ? sub.textContent.trim().slice(0, 40) : '' }
})
check('字幕条已显示（且不是旧气泡）', overlap.subtitleVisible, overlap.subtitleText)
check(`词云不压住顶部工具栏（重叠 ${overlap.hitTop} 个）`, overlap.hitTop === 0, `重叠 ${overlap.hitTop} 个`)
check(`词云不压住底部字幕条（重叠 ${overlap.hitSub} 个）`, overlap.hitSub === 0, `重叠 ${overlap.hitSub} 个`)
await page.screenshot({ path: join(OUT, 'look-01-stage.png') })

/* ---------- 3. 背景选择器 ---------- */
await page.click('#open-bg')
await page.waitForSelector('.pick-card canvas', { timeout: 15000 })
const bgInfo = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.modal .pick-card')]
  // 缩略图必须真的画了东西（采样非透明像素），否则就是空框
  let painted = 0
  for (const c of cards) {
    const cv = c.querySelector('canvas')
    if (!cv || !cv.width) continue
    try {
      const d = cv.getContext('2d').getImageData(0, 0, Math.min(cv.width, 60), Math.min(cv.height, 60)).data
      for (let i = 3; i < d.length; i += 4) { if (d[i] > 8) { painted++; break } }
    } catch { /* 跨域图片取不到像素，忽略 */ }
  }
  return {
    count: cards.length,
    painted,
    names: cards.map(c => c.querySelector('.pick-name')?.textContent || '').slice(0, 14),
    groups: [...document.querySelectorAll('.modal .lbl')].map(n => n.textContent.trim()),
  }
})
check(`背景选择器列出了 ${bgInfo.count} 个背景`, bgInfo.count >= 10, `实际 ${bgInfo.count}`)
check('分组包含「程序化背景」「内置图片」', bgInfo.groups.some(g => g.includes('程序化')) && bgInfo.groups.some(g => g.includes('内置图片')), bgInfo.groups.join(' | '))
check(`缩略图真的渲染出来了（${bgInfo.painted}/${bgInfo.count}）`, bgInfo.painted >= bgInfo.count - 1, `只有 ${bgInfo.painted} 个画出来了`)
console.log(`      背景列表：${bgInfo.names.join('、')}`)
await page.screenshot({ path: join(OUT, 'look-02-bg-picker.png') })

// 采样换背景前后的像素，确认真的换了
const sampleStage = () => page.evaluate(() => {
  const c = document.querySelector('#bg-canvas')
  const t = document.createElement('canvas')
  t.width = 40; t.height = 40
  const ctx = t.getContext('2d')
  ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 40, 40)
  const d = ctx.getImageData(0, 0, 40, 40).data
  let sum = 0
  for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]
  return sum
})
const before = await sampleStage()
// 点「山水青绿」（程序化，颜色特征明显）
await page.evaluate(() => {
  const card = [...document.querySelectorAll('.modal .pick-card')].find(c => c.querySelector('.pick-name')?.textContent.includes('山水'))
  if (!card) throw new Error('找不到山水青绿背景')
  card.click()
})
await page.waitForTimeout(1400)
const after = await sampleStage()
check('点击背景后画面像素确实变了（不是只改了个选择状态）', Math.abs(after - before) > 1000, `before=${before} after=${after}`)
const activeName = await page.evaluate(() => document.querySelector('.modal .pick-card.active .pick-name')?.textContent || '')
check('被点的背景变成选中态', activeName.includes('山水'), activeName)
await page.screenshot({ path: join(OUT, 'look-03-bg-applied.png') })

// 关掉弹层
await page.keyboard.press('Escape').catch(() => {})
await page.evaluate(() => document.querySelector('.modal-mask')?.remove())
await page.waitForTimeout(500)

/* ---------- 4. 形象选择器 ---------- */
await page.click('#open-model')
await page.waitForSelector('.modal .pick-card', { timeout: 15000 })
const modelInfo = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.modal .pick-card')]
  return {
    count: cards.length,
    names: cards.map(c => c.querySelector('.pick-name')?.textContent || ''),
    notes: cards.map(c => c.querySelector('.pick-note')?.textContent || ''),
    withPreview: cards.filter(c => c.querySelector('img.pick-model-img')).length,
    tags: cards.map(c => [...c.querySelectorAll('.pick-tag')].map(t => t.textContent).join('/')),
  }
})
check(`形象选择器列出 ${modelInfo.count} 个模型`, modelInfo.count >= 3, `实际 ${modelInfo.count}`)
check(`每个模型都有预览图（${modelInfo.withPreview}/${modelInfo.count}）`, modelInfo.withPreview === modelInfo.count, `只有 ${modelInfo.withPreview} 个有图`)
check('内置的 AIRI 基础建模（hiyori）在列表里', modelInfo.names.some(n => n.includes('ひより')), modelInfo.names.join(' | '))
// 两类形象的规格描述本来就不同：
//   Live2D 报"N 组动作 / M 个"；3D（VRM）报"3D · VRM · 体积"
// 所以这里要求的是"每一张卡都给出了规格"，而不是"都写成交互数量"
check('每张卡都标注了规格（2D 报动作/表情数，3D 报格式与体积）',
  modelInfo.notes.every(n => /组动作/.test(n) || /^3D · /.test(n)), modelInfo.notes.join(' | '))
console.log(`      模型：${modelInfo.names.map((n, i) => `${n}（${modelInfo.tags[i]}）`).join('、')}`)
await page.screenshot({ path: join(OUT, 'look-04-model-picker.png') })

// 点一个**和当前不同**的模型，确认真的换了。
// 不能写死"点 Pro 版"：上一次跑完已经把 Pro 存进角色卡了，再点一次是空操作，
// 测试就会假失败。所以要动态挑一个非当前的。
const beforeModel = await page.evaluate(() => document.querySelector('#look-model-name')?.textContent)
const targetName = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.modal .pick-card')]
  const current = cards.find(c => c.classList.contains('active'))
  const target = cards.find(c => c !== current) || cards[0]
  target.click()
  return target.querySelector('.pick-name')?.textContent || ''
})
await page.waitForTimeout(3500)
const afterModel = await page.evaluate(() => document.querySelector('#look-model-name')?.textContent)
check('点形象后当前形象确实变了', Boolean(afterModel) && afterModel !== beforeModel, `${beforeModel} -> ${afterModel}（点了「${targetName}」）`)
const l2dPainted = await page.evaluate(() => {
  const c = document.querySelector('#live2d-canvas')
  const t = document.createElement('canvas')
  t.width = 120; t.height = 120
  const ctx = t.getContext('2d')
  try { ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 120, 120) } catch { return 0 }
  const d = ctx.getImageData(0, 0, 120, 120).data
  let n = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 12) n++
  return n
})
check('换完形象后 Live2D 依然渲染出内容（不是换空了）', l2dPainted > 400, `不透明像素 ${l2dPainted}`)
await page.screenshot({ path: join(OUT, 'look-05-model-switched.png') })
await page.evaluate(() => document.querySelector('.modal-mask')?.remove())

/* ---------- 5. 上传自定义背景 ---------- */
// 造一张 64x64 的纯色 PNG 当作用户图片上传
const uploaded = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 64; c.height = 64
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#c2410c'
  ctx.fillRect(0, 0, 64, 64)
  ctx.fillStyle = '#fde68a'
  ctx.fillRect(16, 16, 32, 32)
  const dataUrl = c.toDataURL('image/png')
  const r = await fetch('/api/backgrounds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, name: '验收测试图.png' }),
  })
  const d = await r.json()
  return { status: r.status, ok: d.ok, id: d.item && d.item.id, bytes: d.bytes }
})
check('上传自定义背景返回 200 且落盘', uploaded.status === 200 && uploaded.ok && uploaded.bytes > 0, JSON.stringify(uploaded))

const listAfter = await page.evaluate(async () => (await (await fetch('/api/backgrounds')).json()).custom)
check('自定义背景出现在列表里', listAfter.some(c => c.id === uploaded.id), JSON.stringify(listAfter.map(c => c.label)))
const fileOk = await page.evaluate(async (url) => {
  const r = await fetch(url)
  return { status: r.status, type: r.headers.get('content-type') }
}, `/api/backgrounds/file/${uploaded.id.replace(/^custom-/, '')}`)
check('自定义背景文件能通过接口取回', fileOk.status === 200 && /image\//.test(fileOk.type || ''), JSON.stringify(fileOk))

// 删掉测试图，别留在交付物里
const delOk = await page.evaluate(async (id) => {
  const r = await fetch(`/api/backgrounds/${encodeURIComponent(id)}`, { method: 'DELETE' })
  return r.status
}, uploaded.id)
check('自定义背景可删除（清理干净）', delOk === 200, `HTTP ${delOk}`)

/* ---------- 6. 外观页 ---------- */
await page.click('#tabs .tab[data-pane="look"]')
await page.waitForTimeout(900)
const lookPane = await page.evaluate(() => {
  const p = document.querySelector('#pane-look')
  return {
    active: p.classList.contains('active'),
    bgName: document.querySelector('#look-bg-name')?.textContent,
    modelName: document.querySelector('#look-model-name')?.textContent,
    modelNote: document.querySelector('#look-model-note')?.textContent,
    hasBgThumb: Boolean(document.querySelector('#look-bg-thumb')),
    hasModelImg: Boolean(document.querySelector('#look-model-img')?.getAttribute('src')),
    folds: [...document.querySelectorAll('#pane-look .fold summary')].map(s => s.textContent.trim()),
  }
})
check('「外观」页签可打开', lookPane.active)
check('外观页显示当前背景名', Boolean(lookPane.bgName), lookPane.bgName)
check('外观页显示当前形象名与规格', Boolean(lookPane.modelName) && /组动作/.test(lookPane.modelNote || ''), `${lookPane.modelName} / ${lookPane.modelNote}`)
check('外观页有背景缩略图与形象立绘', lookPane.hasBgThumb && lookPane.hasModelImg)
check('「服务状态」「关于」收进折叠块（不再一屏全是信息）', lookPane.folds.length >= 2, lookPane.folds.join(' | '))
await page.screenshot({ path: join(OUT, 'look-06-look-pane.png') })

/* ---------- 汇总 ---------- */
const relevant = consoleErrors.filter(e => !/favicon/.test(e))
console.log('\n----- 控制台错误 -----')
console.log(relevant.length ? [...new Set(relevant)].slice(0, 8).join('\n') : '（无）')
check('没有控制台错误', relevant.length === 0, `${relevant.length} 条`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
console.log(`截图目录：${OUT}`)
await browser.close()
process.exitCode = fail ? 1 : 0
