#!/usr/bin/env node
/**
 * drive-copybook-error.mjs —— 验证手册校验失败的 UI 展示路径。
 *
 * 为什么单独测这个：API 返回 errors 是一回事，
 * 前端有没有把它们显示给用户是另一回事。校验器的价值取决于
 * "用户真的看得到问题"，否则它只是日志里的一行。
 *
 * 做法：在页面里临时把 buildCopybookSpec 打桩成埋错版本，
 * 点生成，读回错误区文本 —— 走的是完全真实的前端展示逻辑。
 */

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "err-profile");
const PORT = 9223;

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("超时: " + method)); }
      }, 600000);
    });
  }
  async evalJs(expr, awaitPromise = false) {
    const r = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error("页面异常: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  await rm(PROFILE, { recursive: true, force: true });

  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    "--hide-scrollbars", "--window-size=1440,950", "about:blank",
  ], { windowsHide: true, stdio: "ignore" });

  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    await sleep(400);
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
  }
  if (!ver) { proc.kill(); throw new Error("调试端口未就绪"); }

  let target = null;
  for (let i = 0; i < 25 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
    target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!target) await sleep(300);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 950, deviceScaleFactor: 1, mobile: false,
  });

  console.log("打开页面 ...");
  await cdp.send("Page.navigate", { url: BASE });
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    if ((await cdp.evalJs("document.querySelectorAll('#tplGrid .card').length")) > 0) break;
  }
  console.log("  页面就绪");

  // 1) 切到手册
  const cap = await cdp.evalJs(`(() => {
    const b = Array.from(document.querySelectorAll('#capMenu button')).find(x => x.textContent.includes('手册'));
    b.click();
    return window.posterforge.state.cap;
  })()`);
  console.log("  切到:", cap);

  // 2) 注入：让手册构造返回一份埋错 spec。
  //    走页面自己的 doGenerate，所以前端展示逻辑是真实的那一套。
  //
  //    注意：app.js 是 ES module，模块内函数**不挂全局**，
  //    所以不能再用 `window.buildCopybookSpec = …` 打桩
  //    （旧写法在这里一直报"无法打桩"，这条测试等于没在跑）。
  //    现在走 app.js 留的显式注入点 `__debug.setCopybookSpecOverride`。
  const stubbed = await cdp.evalJs(`(() => {
    const pf = window.posterforge;
    if (!pf || !pf.__debug || typeof pf.__debug.setCopybookSpecOverride !== 'function') {
      return 'NO_HOOK';
    }
    pf.__debug.setCopybookSpecOverride(() => ({
      meta: { id: 'ui-bad', client: '测试酒店', title: '埋错手册' },   // 无 facts_source
      theme: { palette: { bgFrom: '#0b2a30', bgTo: '#1d5f66', ink: '#ffffff' } }, // 缺一堆色
      sections: [
        { type: 'cover', title: '全市最低价的海景房' },
        { type: 'table', columns: ['项目','价格'], rows: [['基础版','￥299','多一列']] },
        { type: 'unknownType' }
      ]
    }));
    return 'OK';
  })()`);
  console.log("  注入埋错 spec:", stubbed);
  if (stubbed !== "OK") { proc.kill(); throw new Error("注入失败：" + stubbed + "（app.js 的 __debug.setCopybookSpecOverride 不可用）"); }

  // 3) 点生成，等错误区出现
  await cdp.evalJs(`(() => {
    document.querySelector('#resultExtra').innerHTML = '';
    document.querySelector('#resultErr').style.display = 'none';
    document.querySelector('#genBtn').click();
    return true;
  })()`);

  let out = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    out = JSON.parse(await cdp.evalJs(`(() => {
      const err = document.querySelector('#resultErr');
      return JSON.stringify({
        shown: err.style.display === 'block',
        text: err.textContent || '',
        btn: document.querySelector('#genBtn').textContent
      });
    })()`));
    if (out.shown && out.text.length > 20) break;
  }

  console.log("\n=== 错误区显示内容 ===");
  console.log(out.text.split("\n").map((l) => "  " + l).join("\n"));

  // 断言用「语言无关」的标记：稳定 ASCII 令牌 + 计数。
  // 之前用中文子串匹配，结果 PowerShell 控制台的 GBK 编码把中文字面量搞坏了，
  // 测试报假失败。检查结构标记更可靠，也不受终端编码影响。
  const bulletCount = (out.text.match(/·/g) || []).length;
  const warnCount = (out.text.match(/⚠/g) || []).length;
  const checks = {
    "错误区已显示": out.shown,
    "含阶段标记 validate": out.text.includes("validate"),
    "列出多条错误（≥8）": bulletCount >= 8,
    "列出警告（≥1）": warnCount >= 1,
    "含调色板缺失标记": out.text.includes("theme.palette"),
    "含版块定位标记": out.text.includes("sections["),
    "含列数不符提示": /columns/.test(out.text),
    "按钮已恢复可用": out.btn.length > 0 && !out.btn.includes("…"),
  };
  console.log("\n=== 判定（语言无关标记）===");
  let allOk = true;
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${v ? "✓" : "✗"} ${k}`);
    if (!v) allOk = false;
  }
  console.log(`  （错误条目 ${bulletCount} 条，警告 ${warnCount} 条）`);

  // 顺手截图，确认页面上的中文展示正常（终端编码不可信，截图才可信）
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(OUT, "copybook-error-ui.png");
  await writeFile(file, Buffer.from(shot.data, "base64"));
  console.log(`  已截图: ${file}`);

  ws.close?.();
  proc.kill();
  console.log("\n结果:", allOk ? "✓ 错误路径 UI 展示正常" : "✗ 有展示缺失");
  setTimeout(() => process.exit(allOk ? 0 : 1), 300);
}

main().catch((e) => { console.error("测试失败:", e.message); process.exit(1); });
