#!/usr/bin/env node
/**
 * verify-wenlv.mjs -- 验证 HikiTravel 反代挂载。
 *
 * 为什么不能只看首页返回 200：反代最容易骗人的地方就是
 * 「HTML 回来了，但它引用的 /js/ /css/ /api/ 全是 404」——
 * 页面一片空白，而 HTTP 状态码一切正常。
 *
 * 这个测试在**真浏览器**里加载页面，抓所有请求的失败项（404/5xx/连接失败），
 * 并对照重写后的 HTML 检查前缀。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const PROFILE = path.join(__dirname, ".work", "wenlv-profile");
const PORT = 9288;
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
              "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, note = "") => { console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`); ok ? pass++ : fail++; };

// ---------------------------------------------------------------- 1. 改写检查（纯 HTTP）
console.log("[1] HTML/CSS/JS 里的绝对路径是否被改写到 /wenlv/");
for (const p of ["/wenlv/", "/wenlv/app/", "/wenlv/m/", "/wenlv/planner/", "/wenlv/__motion__/"]) {
  const r = await fetch(BASE + p);
  const html = await r.text();
  // 找出仍然是根路径的引用（排除 /wenlv/ 开头的）
  const bad = [...html.matchAll(/(?:src|href)=["'](\/(?!wenlv\/)[^"']*)["']/g)].map((m) => m[1]);
  const good = [...html.matchAll(/(?:src|href)=["']\/wenlv\/[^"']*["']/g)].length;
  check(`${p} 无漏改的根路径`, bad.length === 0, bad.length ? bad.slice(0, 3).join(" ") : `已改写 ${good} 个`);
}

const css = await (await fetch(BASE + "/wenlv/css/airi.css")).text();
const cssUrls = [...css.matchAll(/url\((\/[^)]*)\)/g)].map((m) => m[1]).filter((u) => !u.startsWith("/wenlv/"));
check("CSS 里的 url() 无漏改", cssUrls.length === 0, cssUrls.slice(0, 3).join(" "));

const js = await (await fetch(BASE + "/wenlv/js/app.js")).text();
const jsApi = [...js.matchAll(/["'`](\/api\/[^"'`]*)/g)].map((m) => m[1]);
check("JS 里的 /api/ 已改写到 /wenlv/api/", jsApi.length === 0, jsApi.slice(0, 3).join(" "));

// ---------------------------------------------------------------- 2. 真浏览器加载
console.log("\n[2] 真浏览器加载，统计失败请求");
await rm(PROFILE, { recursive: true, force: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-proxy-server",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1600,1000", "about:blank"], { windowsHide: true, stdio: "ignore" });
let v = null;
for (let i = 0; i < 60 && !v; i++) { await sleep(400); try { v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {} }
let t = null;
for (let i = 0; i < 25 && !t; i++) {
  const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
  t = l.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
  if (!t) await sleep(300);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = Math.floor(Math.random() * 1e9);
  const h = (e) => { const x = JSON.parse(e.data); if (x.id === id) { ws.removeEventListener("message", h); x.error ? rej(new Error(JSON.stringify(x.error))) : res(x.result); } };
  ws.addEventListener("message", h); ws.send(JSON.stringify({ id, method: m, params: p }));
});
await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

for (const page of ["/wenlv/", "/wenlv/app/", "/wenlv/m/", "/wenlv/__motion__/"]) {
  const bad = [];
  const onMsg = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Network.responseReceived") {
      const st = m.params.response.status;
      const u = m.params.response.url;
      if (st >= 400) bad.push(st + " " + u.replace(BASE, ""));
    }
    if (m.method === "Network.loadingFailed") bad.push("FAIL " + (m.params.errorText || ""));
  };
  ws.addEventListener("message", onMsg);
  await send("Network.clearBrowserCache");
  await send("Page.navigate", { url: BASE + page });
  await sleep(6500);
  ws.removeEventListener("message", onMsg);
  check(`${page} 无失败请求`, bad.length === 0, bad.length ? bad.slice(0, 4).join(" | ") : "全部 200");
}

const title = await send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
console.log("\n   最后页面标题:", title.result.value);
ws.close?.(); proc.kill();
console.log(`\n${fail === 0 ? "全部通过" : fail + " 项未通过"}`);
process.exit(fail === 0 ? 0 : 1);
