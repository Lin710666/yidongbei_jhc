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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

  // 从脚本所在目录和当前工作目录分别往上走，查沿途每一级的 node_modules。
  // 这条是必需的：Playwright 常常是被平级的邻居目录装上的（比如一个专门放
  // 验收工具的目录），只看上面那几个固定路径会漏掉。
  const seen = new Set()
  for (const start of [dirname(fileURLToPath(import.meta.url)), process.cwd()]) {
    let cur = start
    for (let i = 0; i < 6; i++) {
      // 本级 node_modules，以及本级下的 tools / .tools（放可选工具的自然位置）
      for (const sub of ['node_modules', join('tools', 'node_modules'), join('.tools', 'node_modules')]) {
        const p = join(cur, sub, 'playwright', 'index.mjs')
        if (!seen.has(p)) {
          seen.add(p)
          list.push([p, `${cur} 下的 ${sub}`])
        }
      }
      const up = dirname(cur)
      if (up === cur) break
      cur = up
    }
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

/**
 * 载入 Playwright；环境里没有就打印一条跳过说明并退出。
 *
 * 为什么要有这个：浏览器验收是**可选**的额外验证（要服务在跑、要有 Edge、要有
 * Playwright），不该因为环境缺一样工具就让整个验收流程报一大段栈。
 * 用这个版本的脚本在缺工具时会明确打印「跳过」，而不是抛异常。
 *
 * 注意它退出码是 0：跳过不等于失败。但打印得很显眼，不会让人误以为跑过了。
 */
export async function loadPlaywrightOrSkip(scriptName = '') {
  try {
    return await loadPlaywright()
  } catch (e) {
    const line = '─'.repeat(64)
    console.log('\n' + line)
    console.log(`跳过：${scriptName || '这个浏览器验收脚本'} 没能跑起来`)
    console.log(line)
    console.log('原因：本机找不到可用的 Playwright。')
    console.log('这是环境缺工具，不是项目本身的问题 —— 服务端测试（audit / smoke）不受影响。')
    console.log('\n想跑浏览器验收，先启动服务，再任选一种准备 Playwright：')
    console.log('  1. npm i -g playwright')
    console.log('  2. 设环境变量 PLAYWRIGHT_PATH 指向 playwright 的 index.mjs')
    console.log('  3. 本机有 AIRI 源码时，设 AIRI_HOME 指向它')
    console.log('（不用下载浏览器内核：这些脚本用系统自带的 Edge，')
    console.log('  装的时候可以加 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 省时间）')
    console.log('\n已经找过这些位置：')
    console.log(tried.map(t => `  - ${t}`).join('\n'))
    console.log(line)
    console.log('')
    process.exit(0)
  }
}
