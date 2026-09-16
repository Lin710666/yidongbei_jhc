#!/usr/bin/env node
import { loadPlaywright } from './_playwright.mjs'
/**
 * generate-model-previews.mjs —— 给每个 Live2D 模型生成一张预览图
 *
 * 为什么需要：形象选择器如果只有文字，用户根本不知道换出来是什么样。
 * 但让前端在运行时为每个模型实时渲染缩略图太贵（纳西妲的纹理 15 MB）。
 * 所以改成"离线生成一次、静态复用"：用真实渲染器（PixiJS + Cubism）渲染一帧，
 * 存成 public/models/<id>/preview.png，之后选择器直接读图，零运行时开销。
 *
 * 用法（需要 web 服务已在 8000 运行）：
 *   node test/generate-model-previews.mjs [baseUrl]
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PUBLIC = join(here, '..', 'public')
const BASE = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/+$/, '')

// Playwright 不在本交付物的依赖里，按候选路径自动去找（见 _playwright.mjs）
const { chromium } = await loadPlaywright()

const W = 360
const H = 460

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('console', (m) => { if (m.type() === 'error') console.log('   [页面错误]', m.text().split('\n')[0]) })

// 先打开应用本体，拿到同源环境（这样加载 /vendor 与 /models 不会有跨域问题）
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForFunction(() => typeof window.PIXI !== 'undefined' && window.PIXI.live2d, { timeout: 60000 })

const models = await (await fetch(`${BASE}/api/capabilities`)).json().then(d => d.live2d)

console.log(`共 ${models.length} 个模型，逐个渲染预览图…\n`)

for (const m of models) {
  process.stdout.write(`  ${m.id} … `)
  const dataUrl = await page.evaluate(async ({ entry, W, H }) => {
    // 每次都新建一个离屏 PIXI 应用，渲染完就销毁，模型之间互不干扰
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(canvas)

    const app = new window.PIXI.Application({
      view: canvas,
      width: W,
      height: H,
      backgroundAlpha: 0,          // 透明底，贴到任何背景上都好看
      antialias: true,
      autoDensity: true,
      resolution: 2,               // 2 倍图，高分屏不糊
      preserveDrawingBuffer: true, // 不设这个 toDataURL 会拿到空白
    })

    try {
      try { window.PIXI.live2d.Live2DModel.registerTicker(window.PIXI.Ticker) } catch { /* 已注册 */ }
      const model = await window.PIXI.live2d.Live2DModel.from(entry, { autoInteract: false })
      app.stage.addChild(model)

      // 让模型高度占画面 92%，底部对齐，水平居中
      const scale = (H * 0.92) / (model.height || 1)
      model.scale.set(scale)
      model.anchor.set(0.5, 1)
      model.position.set(W / 2, H * 0.99)

      // 摆一个自然的姿势：视线看向镜头偏上，嘴巴闭合
      try { model.focus(0, -0.15) } catch { /* 忽略 */ }

      // 等若干帧，让物理（头发/饰品）稳定下来再截，否则会拍到"刚出生"的僵硬姿态
      await new Promise((resolve) => {
        let n = 0
        const tick = () => { if (++n > 90) resolve(); else requestAnimationFrame(tick) }
        requestAnimationFrame(tick)
      })

      const url = canvas.toDataURL('image/png')
      model.destroy()
      return url
    } catch (e) {
      return `ERROR:${e && e.message ? e.message : e}`
    } finally {
      try { app.destroy(false, { children: true }) } catch { /* 忽略 */ }
      canvas.remove()
    }
  }, { entry: `${BASE}${m.entry}`, W, H })

  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png')) {
    console.log(`失败：${String(dataUrl).slice(0, 120)}`)
    continue
  }
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
  const out = join(PUBLIC, 'models', m.id, 'preview.png')
  writeFileSync(out, buf)
  console.log(`OK  ${(buf.length / 1024).toFixed(1)} KB -> models/${m.id}/preview.png`)
}

await browser.close()
console.log('\n完成。刷新页面即可在形象选择器里看到预览图。')
