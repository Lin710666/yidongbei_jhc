#!/usr/bin/env node
import { loadPlaywright } from './_playwright.mjs'
/**
 * gen-3d-previews.mjs —— 给所有 3D 模型生成/刷新预览图
 *
 * 网页里已有一套"切到模型时自动截图"的机制（app.js 的 captureModelPreview），
 * 但那只对**被选中过**的模型生效。这个脚本把每个 3D 模型都过一遍，
 * 保证内置的两套一上手就有预览图。
 *
 * 顺便也是个视觉回归工具：站姿或相机改坏了，重跑一遍看预览图就知道。
 *
 * 走的是 window.__wenlv.switchDisplay —— 和用户点选完全相同的代码路径，
 * 只是不用去匹配选择器里的卡片文案（那样一改文案脚本就碎）。
 *
 * 用法（需要 web 服务已在 8000 运行）：
 *   node test/gen-3d-previews.mjs [baseUrl]
 */

const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/+$/, '')
// Playwright 不在本交付物的依赖里，按候选路径自动去找（见 _playwright.mjs）
const { chromium } = await loadPlaywright()

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
page.on('console', (m) => {
  const t = m.text()
  // 故意触发的 4xx 与切换时被中止的下载不算问题
  if (m.type() === 'error' && !/status of 4\d\d/.test(t)) console.log('   [页面]', t.split('\n')[0])
})

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => document.querySelectorAll('.wc-word').length > 15, { timeout: 60000 })
await page.waitForFunction(() => window.__wenlv && window.__wenlv.state.l2dModels.length > 0, { timeout: 60000 })

const list = await (await fetch(`${BASE}/api/models3d`)).json()
const all = [...list.bundled, ...list.custom]
console.log(`共 ${all.length} 个 3D 模型\n`)

let i = 0
for (const m of all) {
  process.stdout.write(`  [${++i}/${all.length}] ${m.label} … `)
  try {
    await page.evaluate(async ({ kind, id, force }) => {
      await window.__wenlv.switchDisplay(kind, id, { silent: true })
      // 已经有预览图时不会自动截图，这里强制重截一次，方便"改完站姿刷新全部预览"
      if (force) {
        // 稍微错开一点时间，让 switchDisplay 里的加载先完成
        await new Promise(r => setTimeout(r, 100))
      }
    }, { kind: m.kind, id: m.id, force: false })
    await page.waitForTimeout(9000)          // 等下载 + 解析 + 首帧 + 自动截图
    console.log('OK')
  } catch (e) {
    console.log(`失败：${e.message}`)
  }
}

const after = await (await fetch(`${BASE}/api/models3d`)).json()
console.log('\n预览图状态：')
for (const m of [...after.bundled, ...after.custom]) {
  console.log(`  ${m.preview ? '✓' : '✗'}  ${m.label.padEnd(14)} ${m.preview || '（无）'}`)
}

await browser.close()
