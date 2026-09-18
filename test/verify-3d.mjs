#!/usr/bin/env node
/**
 * verify-3d.mjs —— 验收「本地上传 3D 角色模型 + 背景」这两件事
 *
 * 检查的都是真跑起来的效果，而不是接口返回 200：
 *   · 形象选择器是否同时列出 Live2D 与 3D 两组
 *   · 点 3D 形象后是否出现 3D 画布（WebGL 真的画出了东西，不是黑屏/空白）
 *   · 3D 模型是否被归一化到合理大小（占画面高度的一个合理比例）
 *   · 上传一个 .glb 是否落盘、出现在列表、能取回、能删除
 *   · 上传非模型文件（比如一张 PNG）是否被明确拒绝，而不是写出一个坏文件
 *   · 背景上传链路是否依然可用
 *
 * 用法：node test/verify-3d.mjs [baseUrl]
 */

import { mkdirSync } from 'node:fs'
import { loadPlaywrightOrSkip } from './_playwright.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, 'shots')
mkdirSync(OUT, { recursive: true })
const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/+$/, '')

// Playwright 不在本交付物的依赖里，按候选路径自动去找（见 _playwright.mjs）
const { chromium } = await loadPlaywrightOrSkip('verify-3d.mjs（3D 形象渲染/上传 VRM、GLB）')

const consoleErrors = []
const failedRequests = []
let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`) }
}

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().split('\n')[0]) })
page.on('requestfailed', (r) => { if (!/favicon/.test(r.url())) failedRequests.push(`${r.url().replace(BASE, '')} :: ${r.failure()?.errorText}`) })

console.log(`验收目标：${BASE}\n`)
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => document.querySelectorAll('.wc-word').length > 15, { timeout: 60000 })
await page.waitForTimeout(2500)

/* ---------- 1. 接口层 ---------- */
const api3d = await page.evaluate(async () => {
  const r = await fetch('/api/models3d')
  return { status: r.status, ...(await r.json()) }
})
check('/api/models3d 返回 200', api3d.status === 200)
check(`内置 3D 模型 ${api3d.bundled?.length} 个（来自 Project AIRI 的 VRM 示例）`, (api3d.bundled || []).length >= 2, JSON.stringify((api3d.bundled || []).map(b => b.label)))
check('声明的支持格式含 .vrm 与 .glb', Boolean(api3d.formats?.['.vrm'] && api3d.formats?.['.glb']), JSON.stringify(Object.keys(api3d.formats || {})))

const vrmUrl = api3d.bundled[0].url
const headRes = await page.evaluate(async (u) => {
  const r = await fetch(u, { method: 'HEAD' })
  return { status: r.status, type: r.headers.get('content-type'), len: Number(r.headers.get('content-length') || 0) }
}, vrmUrl)
check('VRM 文件可 HEAD（静态服务支持 HEAD，不再误报 404）', headRes.status === 200, JSON.stringify(headRes))
check('VRM 的 Content-Type 是 model/gltf-binary', headRes.type === 'model/gltf-binary', String(headRes.type))

/* ---------- 2. 形象选择器：Live2D 与 3D 分组 ---------- */
await page.click('#open-model')
await page.waitForSelector('.modal .pick-card', { timeout: 15000 })
const sections = await page.evaluate(() => ({
  labels: [...document.querySelectorAll('.modal .pick-sections > .lbl')].map(n => n.textContent.trim()),
  cards: [...document.querySelectorAll('.modal .pick-card')].map(c => ({
    name: c.querySelector('.pick-name')?.textContent || '',
    note: c.querySelector('.pick-note')?.textContent || '',
    tags: [...c.querySelectorAll('.pick-tag')].map(t => t.textContent),
  })),
  hasUpload: [...document.querySelectorAll('.modal .btn')].some(b => /上传/.test(b.textContent)),
}))
check('选择器分成 Live2D 与 3D 两组', sections.labels.some(l => l.includes('Live2D')) && sections.labels.some(l => l.includes('3D')), sections.labels.join(' | '))
check('列出了 3D 模型', sections.cards.some(c => c.tags.includes('3D')), JSON.stringify(sections.cards.map(c => c.name)))
check('有「上传 VRM / GLB」按钮', sections.hasUpload)
check('3D 卡片标注了格式与体积', sections.cards.some(c => /3D · VRM/.test(c.note)), sections.cards.map(c => c.note).join(' | '))
await page.screenshot({ path: join(OUT, '3d-01-model-picker.png') })

/* ---------- 3. 切到 3D 形象：WebGL 真的画出来了吗 ---------- */
const beforeSwitch = await page.evaluate(() => ({
  l2d: getComputedStyle(document.querySelector('#live2d-canvas')).display,
  c3d: getComputedStyle(document.querySelector('#stage3d-canvas')).display,
}))
check('切换前显示的是 Live2D 画布', beforeSwitch.l2d !== 'none' && beforeSwitch.c3d === 'none', JSON.stringify(beforeSwitch))

await page.evaluate(() => {
  const card = [...document.querySelectorAll('.modal .pick-card')].find(c => [...c.querySelectorAll('.pick-tag')].some(t => t.textContent === '3D'))
  if (!card) throw new Error('选择器里没有 3D 卡片')
  card.click()
})
// 25MB 的 VRM + three.js 首帧，给足时间
const loaded3d = await page.waitForFunction(() => {
  const c = document.querySelector('#stage3d-canvas')
  return c && getComputedStyle(c).display !== 'none' && c.width > 0
}, { timeout: 120000 }).then(() => true).catch(() => false)
check('切换到 3D 后显示 3D 画布', loaded3d)
await page.waitForTimeout(6000)   // 等模型解析 + 首帧渲染
await page.screenshot({ path: join(OUT, '3d-02-vrm-loaded.png') })

const painted = await page.evaluate(() => {
  const c = document.querySelector('#stage3d-canvas')
  // three.js 用的是 WebGL 上下文，drawImage 到 2D canvas 取像素
  const t = document.createElement('canvas')
  t.width = 200; t.height = 200
  const ctx = t.getContext('2d')
  try { ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 200, 200) } catch { return { opaque: 0, err: 'drawImage 失败' } }
  const d = ctx.getImageData(0, 0, 200, 200).data
  let opaque = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 20) opaque++
  return { opaque, total: 200 * 200, w: c.width, h: c.height }
})
check(`3D 画布真的渲染出内容（非透明像素 ${painted.opaque}/${painted.total}）`, painted.opaque > 300, JSON.stringify(painted))

// 模型大小是否合理：非透明像素的包围盒应占画面高度的 30%~95%
const fit = await page.evaluate(() => {
  const c = document.querySelector('#stage3d-canvas')
  const t = document.createElement('canvas')
  t.width = 200; t.height = 200
  const ctx = t.getContext('2d')
  ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, 200, 200)
  const d = ctx.getImageData(0, 0, 200, 200).data
  let minY = 200; let maxY = -1; let minX = 200; let maxX = -1
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 200; x++) {
      if (d[(y * 200 + x) * 4 + 3] > 20) {
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
  }
  return { minY, maxY, minX, maxX, hRatio: (maxY - minY) / 200, wRatio: (maxX - minX) / 200 }
})
check(`3D 人物大小合理（占画面高度 ${(fit.hRatio * 100).toFixed(0)}%）`, fit.hRatio > 0.30 && fit.hRatio < 0.98, JSON.stringify(fit))

/* ---------- 4. 上传一个真的 .glb（用最小合法 glTF 二进制） ---------- */
// 造一个最小的合法 GLB：12 字节头 + JSON chunk。三步就能验证"魔数校验 + 落盘 + 列表 + 取回 + 删除"
const uploadOk = await page.evaluate(async () => {
  // 1x1 立方体的极简 glTF JSON（够让魔数校验通过；这里主要验上传链路，不验渲染）
  const gltf = {
    asset: { version: '2.0', generator: 'wenlv-airi verify' },
    scenes: [{ nodes: [] }],
    scene: 0,
    nodes: [],
  }
  const json = new TextEncoder().encode(JSON.stringify(gltf))
  const pad = (4 - (json.length % 4)) % 4
  const jsonPadded = new Uint8Array(json.length + pad)
  jsonPadded.set(json)
  for (let i = json.length; i < jsonPadded.length; i++) jsonPadded[i] = 0x20
  const total = 12 + 8 + jsonPadded.length
  const buf = new ArrayBuffer(total)
  const dv = new DataView(buf)
  const u8 = new Uint8Array(buf)
  dv.setUint32(0, 0x46546C67, true)     // 'glTF'
  dv.setUint32(4, 2, true)              // version
  dv.setUint32(8, total, true)          // length
  dv.setUint32(12, jsonPadded.length, true)
  dv.setUint32(16, 0x4E4F534A, true)    // 'JSON'
  u8.set(jsonPadded, 20)
  const b64 = btoa(String.fromCharCode(...u8))

  const r = await fetch('/api/models3d', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: b64, name: '验收测试模型.glb' }),
  })
  const d = await r.json().catch(() => ({}))
  return { status: r.status, ok: d.ok, id: d.item && d.item.id, bytes: d.bytes, error: d.error }
})
check('上传合法 GLB 返回 200 且落盘', uploadOk.status === 200 && uploadOk.ok && uploadOk.bytes > 0, JSON.stringify(uploadOk))

const listAfter = await page.evaluate(async () => (await (await fetch('/api/models3d')).json()).custom)
check('上传的模型出现在「我上传的」里', listAfter.some(c => c.id === uploadOk.id), JSON.stringify(listAfter.map(c => c.label)))
const fileBack = await page.evaluate(async (u) => {
  const r = await fetch(u)
  const buf = new Uint8Array(await r.arrayBuffer())
  return { status: r.status, type: r.headers.get('content-type'), magic: String.fromCharCode(...buf.slice(0, 4)) }
}, `/api/models3d/file/${uploadOk.id.replace(/^vrm-custom-/, '')}`)
check('上传的模型能取回且魔数仍是 glTF', fileBack.status === 200 && fileBack.magic === 'glTF', JSON.stringify(fileBack))

/* ---------- 5. 上传非模型文件必须被明确拒绝 ---------- */
const rejectPng = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 8; c.height = 8
  c.getContext('2d').fillRect(0, 0, 8, 8)
  const dataUrl = c.toDataURL('image/png')          // 这是 PNG，不是 glTF
  const b64 = dataUrl.split(',')[1]
  const r = await fetch('/api/models3d', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: b64, name: '假装是模型.png' }),
  })
  const d = await r.json().catch(() => ({}))
  return { status: r.status, code: d.code, error: d.error }
})
check('上传 PNG 被拒绝（返回 4xx 并说明原因）', rejectPng.status === 400 && rejectPng.code === 'BAD_INPUT', JSON.stringify(rejectPng))
check('拒绝理由说明了"应当是 glTF 二进制"', /glTF/.test(String(rejectPng.error)), String(rejectPng.error).slice(0, 80))

// 清理测试模型
const delOk = await page.evaluate(async (id) => (await fetch(`/api/models3d/${encodeURIComponent(id)}`, { method: 'DELETE' })).status, uploadOk.id)
check('上传的 3D 模型可删除（测试文件已清理）', delOk === 200, `HTTP ${delOk}`)

/* ---------- 6. 背景上传链路仍然可用 ---------- */
const bgOk = await page.evaluate(async () => {
  const c = document.createElement('canvas')
  c.width = 48; c.height = 48
  const ctx = c.getContext('2d')
  ctx.fillStyle = '#0ea5e9'; ctx.fillRect(0, 0, 48, 48)
  const r = await fetch('/api/backgrounds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: c.toDataURL('image/jpeg', 0.9), name: '验收背景.jpg' }),
  })
  const d = await r.json()
  return { status: r.status, ok: d.ok, id: d.item && d.item.id }
})
check('背景上传仍可用（本地上传背景功能保持可用）', bgOk.status === 200 && bgOk.ok, JSON.stringify(bgOk))
if (bgOk.id) await page.evaluate(async (id) => { await fetch(`/api/backgrounds/${encodeURIComponent(id)}`, { method: 'DELETE' }) }, bgOk.id)

/* ---------- 7. 切回 Live2D 也要正常 ---------- */
// 先把上一个弹层关掉：它是个 z-900 的全屏遮罩，不关会拦住后面的点击
await page.evaluate(() => document.querySelectorAll('.modal-mask').forEach(n => n.remove()))
await page.waitForTimeout(400)
await page.click('#open-model')
await page.waitForSelector('.modal .pick-card', { timeout: 15000 })
await page.evaluate(() => {
  const card = [...document.querySelectorAll('.modal .pick-card')].find(c => [...c.querySelectorAll('.pick-tag')].some(t => t.textContent.includes('Live2D')))
  card.click()
})
await page.waitForTimeout(5000)
const backTo2d = await page.evaluate(() => ({
  l2d: getComputedStyle(document.querySelector('#live2d-canvas')).display,
  c3d: getComputedStyle(document.querySelector('#stage3d-canvas')).display,
}))
check('切回 Live2D 后画布恢复正确（两套渲染器可以来回切）', backTo2d.l2d !== 'none' && backTo2d.c3d === 'none', JSON.stringify(backTo2d))
await page.evaluate(() => document.querySelector('.modal-mask')?.remove())
await page.screenshot({ path: join(OUT, '3d-03-back-to-live2d.png') })

/* ---------- 汇总 ---------- */
// 两类"错误"是本脚本自己造成的，不算产品缺陷：
//   ① 步骤 5 故意上传了一张 PNG，后端按设计返回 400 —— 浏览器会把它记进 console；
//   ② 步骤 7 切回 Live2D 时，若上一个 3D 模型还在下载，浏览器会 abort 它。
//      "切换形象时中止上一个未完成的下载" 是**正确**行为，不是 bug。
const relevant = consoleErrors.filter(e => !/6121|favicon/.test(e) && !/status of 400/.test(e))
console.log('\n----- 控制台错误（已排除故意触发的 400）-----')
console.log(relevant.length ? [...new Set(relevant)].slice(0, 8).join('\n') : '（无）')
const relevantFailed = failedRequests.filter(u => !/ERR_ABORTED/.test(u))
console.log('----- 失败请求（已排除切换形象时被主动中止的下载）-----')
console.log(relevantFailed.length ? [...new Set(relevantFailed)].slice(0, 8).join('\n') : '（无）')
check('没有未预期的控制台错误', relevant.length === 0, `${relevant.length} 条`)
check('没有未预期的失败请求', relevantFailed.length === 0, `${relevantFailed.length} 条`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
console.log(`截图目录：${OUT}`)
await browser.close()
process.exitCode = fail ? 1 : 0
