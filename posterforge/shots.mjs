#!/usr/bin/env node
/**
 * shots.mjs —— 用 CDP 驱动 Edge 无头截图，验证页面各区块的真实渲染效果。
 *
 * 为什么不用 --screenshot 一把梭：那样没法滚动、没法等异步数据（模板是从 /api 拉的），
 * 也没法设视口尺寸。CDP 能精确控制，截图才是"用户真正看到的"。
 *
 * 用法：node shots.mjs [baseUrl]
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8787";
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "cdp-profile");
// 优先连接到已在运行的调试实例（更稳），连不上才自己启动。
const EXISTING_PORT = Number(process.env.CDP_PORT || 9333);
const LAUNCH_PORT = 9222;

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

function findBrowser() {
  for (const c of EDGE_CANDIDATES) if (existsSync(c)) return c;
  throw new Error("找不到 Edge/Chrome");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url);
  return r.json();
}

/** 极简 CDP 客户端：连接页面 target 的 WebSocket，发命令收结果。 */
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
      } else if (msg.method) {
        this.events.push(msg);
      }
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
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  return new CDP(ws);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let proc = null;
  let port = EXISTING_PORT;
  let version = await getJson(`http://127.0.0.1:${port}/json/version`).catch(() => null);

  if (version) {
    console.log("连接到已运行的实例，端口", port, "->", version["Browser"]);
  } else {
    // 自己启动：用独立端口与全新 profile，避免与残留实例打架
    port = LAUNCH_PORT;
    await rm(PROFILE, { recursive: true, force: true });
    const browser = findBrowser();
    console.log("未发现运行中的实例，自行启动:", browser, "端口", port);
    proc = spawn(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${PROFILE}`,
        "--hide-scrollbars",
        "about:blank",
      ],
      { windowsHide: true, stdio: "ignore" }
    );
    for (let i = 0; i < 60 && !version; i++) {
      await sleep(400);
      version = await getJson(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    }
    if (!version) {
      proc.kill();
      throw new Error("调试端口未就绪（端口 " + port + "）");
    }
    console.log("已就绪:", version["Browser"]);
  }

  // 注意：Edge 对 /json/new 的 GET 返回纯文本（要求 PUT），所以从 /json/list 里挑页面 target。
  let target = null;
  for (let i = 0; i < 25 && !target; i++) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`).catch(() => []);
    target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!target) await sleep(300);
  }
  if (!target) {
    if (proc) proc.kill();
    throw new Error("找不到可用的页面 target");
  }
  console.log("target:", target.url || "(about:blank)");
  const cdp = await connect(target.webSocketDebuggerUrl);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  // 禁用缓存：长期存活的调试实例会缓存旧的 app.js/style.css，
  // 导致改了前端却截到旧页面（踩过：tplCards 一直是 0）。
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

  const VIEWPORT = { width: 1440, height: 950 };

  // 关键：模拟真实布局宽度，并启用设备指标
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // 等页面真的"有内容"再开始截图。
  // 早先用固定 sleep，在新启动的服务器上截到了空网格（tplCards:0）——
  // 首次响应慢时 sleep 不够。改成轮询，最多等 20 秒。
  const waitReady = async (timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const n = await cdp.send("Runtime.evaluate", {
        expression:
          "document.querySelectorAll('#tplGrid .card').length + document.querySelectorAll('#capMenu button').length",
        returnByValue: true,
      });
      if ((n.result.value || 0) >= 2) return true;
      await sleep(400);
    }
    return false;
  };

  const results = [];

  async function shoot(name, { scrollTo = null, fullPage = false, height = null } = {}) {
    if (height) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: VIEWPORT.width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    } else {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }

    if (scrollTo) {
      // 用元素偏移精确滚动，并等一帧
      await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const el = document.querySelector(${JSON.stringify(scrollTo)});
          if (!el) return 'NOT_FOUND';
          window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70);
          return 'OK';
        })()`,
      });
    } else {
      await cdp.send("Runtime.evaluate", { expression: "window.scrollTo(0,0)" });
    }

    await sleep(900); // 等图片/异步渲染稳定

    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: !!fullPage,
    });
    const file = path.join(OUT, `cdp-${name}.png`);
    await writeFile(file, Buffer.from(shot.data, "base64"));
    const size = Buffer.from(shot.data, "base64").length;
    results.push({ name, file, kb: (size / 1024).toFixed(0) });
    console.log(`  ${name.padEnd(14)} ${(size / 1024).toFixed(0)} KB  ${file}`);
  }

  console.log("\n开始截图 ...");
  await cdp.send("Page.navigate", { url: BASE });

  // 渲染完成的判定：等 /api 数据到达并插入 DOM，再截图 —— 否则截到的是空网格
  const waitFor = async (expr, timeout = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true });
      if (r.result.value === true) return true;
      await sleep(300);
    }
    return false;
  };
  // 注意：这里原来还断言 #caseGrid 有卡片，案例区删除后那套断言是错的。
  // 删除类改动的回归请用 verify-clean.mjs。
  const ready = await waitFor(
    "document.querySelectorAll('#tplGrid .card').length > 0 && document.querySelectorAll('#feedGrid .feed-card').length > 0"
  );
  if (!ready) console.log("⚠ 等待数据渲染超时，截图可能不完整");
  await sleep(700); // 再给图片解码一点时间

  // 页面自检：把关键计数读回来，作为"页面真的渲染出来了"的证据
  const diag = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify({
      title: document.title,
      tplCards: document.querySelectorAll('#tplGrid .card').length,
      capBtns: document.querySelectorAll('#capMenu button').length,
      feedItems: document.querySelectorAll('#feedGrid .feed-card').length,
      bodyH: document.body.scrollHeight,
      imgsTotal: document.images.length
    })`,
    returnByValue: true,
  });
  console.log("\n页面自检:", diag.result.value);

  // 逐区块截图（案例区已删除，故只剩这三块）
  await shoot("hero", {});
  await shoot("templates", { scrollTo: "#templates" });
  await shoot("feed", { scrollTo: "#feed" });

  // 图片加载失败检查（onerror 会把失败的隐藏掉，但要报出来）
  const broken = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(Array.from(document.images)
      .filter(i => i.complete && i.naturalWidth === 0)
      .map(i => i.getAttribute('src') || '(无 src)'))`,
    returnByValue: true,
  });
  const brokenList = JSON.parse(broken.result.value);
  if (brokenList.length) console.log("\n⚠ 加载失败的图片:", brokenList);
  else console.log("\n✓ 所有图片加载成功");

  cdp.ws.close?.();
  if (proc) proc.kill(); // 只杀自己启动的实例；附着在别人实例上时不动它

  console.log("\n完成，共", results.length, "张截图 →", OUT);
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
