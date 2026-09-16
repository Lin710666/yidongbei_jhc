/**
 * _playwright.mjs —— 找到本机可用的 Playwright
 *
 * 为什么需要它：验收脚本原来把 Playwright 的路径写死成某台机器上的
 * `E:/deepseck/src/airi/node_modules/playwright/index.mjs`，
 * 换台机器跑就必然报模块找不到。
 *
 * 本交付物本身是零依赖的（package.json 的 dependencies 为空），
 * Playwright 只是跑浏览器验收时才需要的**外部工具**，所以按下面的顺序去找，
 * 找到哪个用哪个，都找不到时给一句能照着做的人话，而不是甩一个 ERR_MODULE_NOT_FOUND。
 *
 * 准备 Playwright 的三种办法（任选其一）：
 *   1. npm i -g playwright
 *   2. 设环境变量 PLAYWRIGHT_PATH 指向 playwright 的 index.mjs
 *   3. 本机如果有 AIRI 源码，设 AIRI_HOME 指向它
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const tried = []

/** 候选路径：{path, 说明} */
function candidates() {
  const list = []
  if (process.env.PLAYWRIGHT_PATH) list.push([process.env.PLAYWRIGHT_PATH, '环境变量 PLAYWRIGHT_PATH'])
  for (const root of [
    process.env.AIRI_HOME,
    'C:/deepseck/src/airi',
    'D:/deepseck/src/airi',
    'E:/deepseck/src/airi',
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'nodejs', 'node_modules'),
    'C:/nvm4w/nodejs/node_modules',
  ]) {
    if (!root) continue
    list.push([join(root, 'playwright', 'index.mjs'), root])
    list.push([join(root, 'node_modules', 'playwright', 'index.mjs'), root])
  }
  return list
}

/**
 * 载入 Playwright，返回 { chromium, firefox, webkit, ... }
 */
export async function loadPlaywright() {
  for (const [p, from] of candidates()) {
    const norm = String(p).replace(/\\/g, '/')
    if (!existsSync(norm)) continue
    try {
      return await import(`file:///${norm}`)
    } catch (e) {
      tried.push(`${norm}  （来自 ${from}，但导入失败：${e && e.message}）`)
    }
  }

  // 最后试裸模块名：全局装过、或 NODE_PATH 指过就能命中
  try {
    return await import('playwright')
  } catch {
    tried.push('playwright（裸模块名）')
  }

  throw new Error(
    '找不到可用的 Playwright，浏览器验收脚本没法跑。\n'
    + '本交付物本身零依赖，Playwright 需要你另外准备一个，三种办法任选：\n'
    + '  1. npm i -g playwright\n'
    + '  2. 设环境变量 PLAYWRIGHT_PATH 指向 playwright 的 index.mjs\n'
    + '  3. 本机有 AIRI 源码时，设 AIRI_HOME 指向它\n'
    + '（不需要下载浏览器内核：这些脚本用的是系统自带的 Edge，'
    + '装的时候可以加 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 省时间）\n'
    + '已经试过这些位置：\n'
    + tried.map(t => `  - ${t}`).join('\n'),
  )
}
