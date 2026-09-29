#!/usr/bin/env node
/**
 * verify-ball.mjs -- 悬浮球在三个页面上的验收
 *
 * 为什么要在真浏览器里跑：注入 <script> 只证明 HTML 里有那行字，
 * 不证明脚本跑起来了、Shadow DOM 挂上了、球真的画出来了。
 * 这里逐页读 Shadow DOM 里的真实几何。
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const PROFILE = path.join(__dirname, ".work", "ball-profile");
const PORT = 9302;
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
              "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, note = "") => { console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`); ok ? pass++ : fail++; };

rmSync(PROFILE, { recursive: true, force: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-proxy-server",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1440,1000", "about:blank"], { windowsHide: true, stdio: "ignore" });
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
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || "?").slice(0, 130));
  return r.result.value;
};
// 读 Shadow DOM：宿主 → shadowRoot → .ball
const BALL = `(() => {
  const h = document.getElementById('pf-ai-ball-host');
  if (!h || !h.shadowRoot) return 'NO_HOST';
  const b = h.shadowRoot.querySelector('.ball');
  if (!b) return 'NO_BALL';
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  // 用 clientWidth/clientHeight（不含滚动条）而不是 innerWidth/innerHeight。
  // 页面有滚动条时 innerWidth 会多出约 15px，把 right 算成 41 —— 位置其实是对的，
  // 是量法把滚动条算进去了。（海报页/门户有滚动条，规划页是定高应用没有。）
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height),
    right: Math.round(vw - r.right), bottom: Math.round(vh - r.bottom),
    radius: cs.borderRadius, visible: r.width > 0 });
})()`;
const PANEL = `(() => {
  const h = document.getElementById('pf-ai-ball-host');
  const p = h.shadowRoot.querySelector('.panel');
  const cs = getComputedStyle(p);
  return JSON.stringify({ on: p.classList.contains('on'), opacity: cs.opacity, bg: cs.backgroundColor });
})()`;

const errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails?.exception?.description || "?").slice(0, 110));
});

await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

const PAGES = [
  ["门户", "/hub.html"],
  ["海报生成", "/"],
  ["旅游规划（经反代）", "/wenlv/"],
  ["旅游规划（直连 8001）", "http://127.0.0.1:8001/"],
  ["AIRI-2.0（直连 8000）", "http://127.0.0.1:8000/"],
];

for (const [name, url] of PAGES) {
  console.log(`\n[${name}] ${url}`);
  const bad = [];
  const onMsg = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Network.responseReceived" && m.params.response.status >= 400)
      bad.push(m.params.response.status + " " + m.params.response.url.replace(BASE, ""));
    if (m.method === "Network.loadingFailed") bad.push("FAIL " + (m.params.errorText || ""));
  };
  ws.addEventListener("message", onMsg);
  await send("Page.navigate", { url: url.startsWith("http") ? url : BASE + url });
  await sleep(name === "旅游规划" ? 7000 : 4500);
  ws.removeEventListener("message", onMsg);

  const b = await ev(BALL);
  if (b === "NO_HOST" || b === "NO_BALL") {
    check("球渲染出来了", false, b);
    continue;
  }
  const g = JSON.parse(b);
  console.log("   球:", b);
  check("球渲染出来了", true);
  check("是圆形（不是胶囊）", g.w === g.h && parseFloat(g.radius) >= g.w / 2 - 1, `${g.w}×${g.h} radius=${g.radius}`);
  check("尺寸合理（50~70px）", g.w >= 50 && g.w <= 70, g.w + "px");
  check("贴在右下角", g.right >= 10 && g.right <= 40 && g.bottom >= 10 && g.bottom <= 40, `right=${g.right} bottom=${g.bottom}`);

  await ev(`document.getElementById('pf-ai-ball-host').shadowRoot.querySelector('.ball').click()`);
  await sleep(700);
  const p = JSON.parse(await ev(PANEL));
  check("点一下能打开", p.on && p.opacity === "1", JSON.stringify(p));
  check("面板是白色", p.bg === "rgb(255, 255, 255)", p.bg);
  const ex = await ev(`document.getElementById('pf-ai-ball-host').shadowRoot.querySelectorAll('.ex').length`);
  check("有示例问题", ex >= 3, ex + " 条");

  check("这页没有失败请求", bad.length === 0, bad.slice(0, 3).join(" | "));
  await ev(`document.getElementById('pf-ai-ball-host').shadowRoot.querySelector('.x').click()`);
  await sleep(400);
}

console.log("\n[截图]");
await send("Page.navigate", { url: BASE + "/wenlv/" });
await sleep(7000);
await ev(`document.getElementById('pf-ai-ball-host').shadowRoot.querySelector('.ball').click()`);
await sleep(900);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(path.join(__dirname, ".work", "ball-on-wenlv.png"), Buffer.from(shot.data, "base64"));
await send("Page.navigate", { url: BASE + "/" });
await sleep(5000);
await ev(`document.getElementById('pf-ai-ball-host').shadowRoot.querySelector('.ball').click()`);
await sleep(900);
const shot2 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(path.join(__dirname, ".work", "ball-on-poster.png"), Buffer.from(shot2.data, "base64"));
console.log("   → .work/ball-on-wenlv.png / .work/ball-on-poster.png");

console.log("\n[无 JS 异常]");
check("没有未捕获异常", errors.length === 0, errors.slice(0, 2).join(" | "));

ws.close?.(); proc.kill();
console.log(`\n${fail === 0 ? "全部通过" : fail + " 项未通过"}`);
process.exit(fail === 0 ? 0 : 1);
