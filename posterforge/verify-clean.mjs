#!/usr/bin/env node
/**
 * verify-clean.mjs —— 验证「爆火案例 / 工具箱 / STORY 三点钟」三节删除后的真实页面。
 *
 * 为什么单独写一个：shots.mjs 的自检里还断言 #caseGrid 有卡片，
 * 那套断言现在是错的（它验的是已删除的东西）。删除类改动必须验"它们真的没了"，
 * 而且要验"删完之后剩下的东西还能用"——所以这里顺手把模板预览弹层也点一遍。
 *
 * 用法：node verify-clean.mjs [baseUrl]
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "cdp-profile");
const PORT = Number(process.env.CDP_PORT || 9333);

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (u) => (await fetch(u)).json();

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("CDP 超时: " + method));
        }
      }, 30000);
    });
  }
  async evaluate(expr) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error("页面内异常: " + (r.exceptionDetails.exception?.description || "?"));
    }
    return r.result.value;
  }
}

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ✓ ${name}${detail ? "  " + detail : ""}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? "  " + detail : ""}`);
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  let proc = null;
  let version = await getJson(`http://127.0.0.1:${PORT}/json/version`).catch(() => null);

  if (!version) {
    const browser = BROWSERS.find((b) => existsSync(b));
    if (!browser) throw new Error("找不到 Edge/Chrome");
    await rm(PROFILE, { recursive: true, force: true });
    proc = spawn(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE}`,
        "--hide-scrollbars",
        "about:blank",
      ],
      { windowsHide: true, stdio: "ignore" }
    );
    for (let i = 0; i < 60 && !version; i++) {
      await sleep(400);
      version = await getJson(`http://127.0.0.1:${PORT}/json/version`).catch(() => null);
    }
    if (!version) {
      proc?.kill();
      throw new Error("调试端口未就绪");
    }
  }
  console.log("浏览器:", version.Browser, "端口", PORT);

  let target = null;
  for (let i = 0; i < 25 && !target; i++) {
    const list = await getJson(`http://127.0.0.1:${PORT}/json/list`).catch(() => []);
    target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!target) await sleep(300);
  }
  if (!target) throw new Error("找不到页面 target");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  const cdp = new CDP(ws);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true }); // 别截到旧 app.js

  const VIEW = { width: 1440, height: 950 };
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEW.width,
    height: VIEW.height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp.send("Page.navigate", { url: BASE });

  const waitFor = async (expr, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if ((await cdp.evaluate(expr)) === true) return true;
      } catch { /* 页面还在跳转时 evaluate 可能拿到旧上下文 */ }
      await sleep(300);
    }
    return false;
  };

  const ready = await waitFor(
    "document.querySelectorAll('#tplGrid .card').length > 0 && document.querySelectorAll('#feedGrid .feed-card').length > 0"
  );
  console.log(ready ? "页面渲染就绪" : "⚠ 渲染等待超时，继续检查");
  await sleep(800);

  /* ------------------------------------------------ 1. 三节确实没了 */
  console.log("\n[1] 被删的三节是否真的不存在");
  const gone = JSON.parse(
    await cdp.evaluate(`JSON.stringify({
      caseGrid:   !!document.getElementById('caseGrid'),
      railCard:   !!document.getElementById('railCard'),
      feedList:   !!document.getElementById('feedList'),
      casesSec:   !!document.getElementById('cases'),
      caseCards:  document.querySelectorAll('.grid-case .card').length,
      railItems:  document.querySelectorAll('.rail-item').length,
      storyTxt:   document.body.innerText.includes('STORY'),
      railBox:    document.body.innerText.includes('工具箱'),
      hotCase:    document.body.innerText.includes('爆火案例')
    })`)
  );
  check("#caseGrid 已移除", gone.caseGrid === false);
  check("#railCard 工具箱 已移除", gone.railCard === false);
  check("#feedList STORY 列表 已移除", gone.feedList === false);
  check("<section id=cases> 已移除", gone.casesSec === false);
  check("案例卡数量 = 0", gone.caseCards === 0, `实际 ${gone.caseCards}`);
  check(".rail-item 数量 = 0", gone.railItems === 0, `实际 ${gone.railItems}`);
  check("正文不含 STORY", gone.storyTxt === false);
  check("正文不含「工具箱」", gone.railBox === false);
  check("正文不含「爆火案例」", gone.hotCase === false);

  /* ------------------------------------------------ 2. 剩下的还能用 */
  console.log("\n[2] 删除没有波及到仍然保留的功能");
  const alive = JSON.parse(
    await cdp.evaluate(`JSON.stringify({
      tplCards: document.querySelectorAll('#tplGrid .card').length,
      feedCards: document.querySelectorAll('#feedGrid .feed-card').length,
      capBtns: document.querySelectorAll('#capMenu button').length,
      hasPrompt: !!document.getElementById('promptInput'),
      hasDrop: !!document.getElementById('drop'),
      hasGen: !!document.getElementById('genBtn'),
      hasFeedNote: !!document.getElementById('feedNote'),
      headline: (document.querySelector('h1')||{}).textContent || ''
    })`)
  );
  check("模板卡还在", alive.tplCards > 0, `${alive.tplCards} 张`);
  check("每日灵感 还在", alive.feedCards > 0, `${alive.feedCards} 张`);
  check("能力标签还在", alive.capBtns >= 4, `${alive.capBtns} 个`);
  check("提示词输入框 还在", alive.hasPrompt === true);
  check("上传区 还在", alive.hasDrop === true);
  check("生成按钮 还在", alive.hasGen === true);
  check("灵感版权说明 还在", alive.hasFeedNote === true);

  /* ------------------------------------------------ 3. 模板预览弹层仍可打开 */
  console.log("\n[3] 模板预览弹层（改过 renderPreview，必须回归）");
  await cdp.evaluate("document.querySelector('#tplGrid .card').click()");
  await sleep(600);
  const pv = JSON.parse(
    await cdp.evaluate(`JSON.stringify({
      open: document.getElementById('previewModal').hidden === false,
      kind: (document.getElementById('pvKind')||{}).textContent || '',
      title: (document.getElementById('pvTitle')||{}).textContent || '',
      meta: (document.getElementById('pvMeta')||{}).innerText || '',
      img: (document.getElementById('pvImg')||{}).getAttribute?.('src') || '',
      actions: (document.getElementById('pvActions')||{}).innerText || ''
    })`)
  );
  check("弹层已打开", pv.open === true);
  check("类型显示为「模板」", pv.kind.trim() === "模板", `实际「${pv.kind}」`);
  check("标题非空", pv.title.trim().length > 0 && pv.title.trim() !== "—", pv.title.trim());
  check("含「服务对象」行", pv.meta.includes("服务对象"), pv.meta.replace(/\s+/g, " ").slice(0, 60));
  check("弹层图片指向 .jpg", /\/thumbs\/.+\.jpg/.test(pv.img), pv.img);
  check("操作区含「套用此模板」", pv.actions.includes("套用此模板"));
  check("操作区不再出现案例文案", !pv.actions.includes("照着做一个"));

  // 弹层里的图真的解码成功了吗
  const pvImgOk = await cdp.evaluate(
    "(() => { const i = document.getElementById('pvImg'); return i && i.complete && i.naturalWidth > 0; })()"
  );
  check("弹层图片解码成功", pvImgOk === true);

  await writeFile(
    path.join(OUT, "pv-open.png"),
    Buffer.from((await cdp.send("Page.captureScreenshot", { format: "png" })).data, "base64")
  );

  await cdp.evaluate("document.getElementById('pvClose').click()");
  await sleep(300);
  const closed = await cdp.evaluate("document.getElementById('previewModal').hidden === true");
  check("弹层可关闭", closed === true);

  /* ------------------------------------------------ 4. 后端路由 */
  console.log("\n[4] 后端 /api/cases 是否随数据一起下线");
  const casesRes = await fetch(BASE + "/api/cases").catch((e) => ({ status: -1, err: e.message }));
  check("/api/cases 返回 404", casesRes.status === 404, `实际 ${casesRes.status}`);

  /* ------------------------------------------------ 5. 控制台是否有异常 */
  console.log("\n[5] 控制台异常");
  const errs = [];
  for (const ev of cdp.events) {
    if (ev.method === "Runtime.exceptionThrown") {
      const d = ev.params.exceptionDetails;
      errs.push(d.exception?.description || d.text || "unknown");
    } else if (ev.method === "Log.entryAdded" && ev.params.entry.level === "error") {
      errs.push(ev.params.entry.text);
    }
  }
  const real = errs.filter(
    (e) => !/favicon|net::ERR_|404|Failed to load resource/i.test(e)
  );
  check("无 JS 异常", real.length === 0, real.length ? real.slice(0, 3).join(" | ").slice(0, 220) : "");

  /* ------------------------------------------------ 6. 整页截图 */
  const metrics = JSON.parse(
    await cdp.evaluate(
      "JSON.stringify({h: document.body.scrollHeight, w: document.body.scrollWidth})"
    )
  );
  console.log(`\n[6] 整页高度 ${metrics.h}px（旧版含三节时更高）`);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEW.width,
    height: Math.min(metrics.h, 6000),
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.evaluate("window.scrollTo(0,0)");
  await sleep(1200);
  const full = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const file = path.join(OUT, "after-delete-full.png");
  await writeFile(file, Buffer.from(full.data, "base64"));
  console.log("整页截图 →", file, `(${(Buffer.from(full.data, "base64").length / 1024).toFixed(0)} KB)`);

  // 页脚之前最后一节到底是什么（确认 每日灵感 → 页脚 的衔接）
  const tail = JSON.parse(
    await cdp.evaluate(`JSON.stringify(
      Array.from(document.querySelectorAll('section.band')).map(s => s.id || s.className)
    )`)
  );
  console.log("页面剩余区块顺序:", tail.join(" → "));
  check("已无 cases 区块", !tail.includes("cases"));

  ws.close?.();
  proc?.kill();

  console.log(`\n${failures === 0 ? "全部通过 ✓" : failures + " 项未通过 ✗"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
