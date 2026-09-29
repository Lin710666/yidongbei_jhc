#!/usr/bin/env node
/**
 * verify-portal.mjs -- 主界面验收
 *   1. 浅色 wanderlog 风格（读真实背景色，不是读代码）
 *   2. 两张卡片的跳转真的能打开目标页
 *   3. AI 助手胶囊 → 白色面板
 *   4. 无失败请求 / 无 JS 异常
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const PROFILE = path.join(__dirname, ".work", "portal-profile");
const PORT = 9300;
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
const errors = [], bad = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails?.exception?.description || "?").slice(0, 110));
  if (m.method === "Network.responseReceived") { const s = m.params.response.status; if (s >= 400) bad.push(s + " " + m.params.response.url.replace(BASE, "")); }
  if (m.method === "Network.loadingFailed") bad.push("FAIL " + (m.params.errorText || ""));
});

await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE + "/hub.html" });
await sleep(4500);

console.log("[1] wanderlog 风格（读真实计算样式）");
const bg = await ev("getComputedStyle(document.body).backgroundColor");
const brand = await ev("getComputedStyle(document.querySelector('.btn-primary')).backgroundColor");
const h1size = await ev("getComputedStyle(document.querySelector('.hero h1')).fontSize");
console.log("   页面底色:", bg, " 主按钮:", brand, " 标题字号:", h1size);
check("浅色底（接近纯白）", /rgb\(2[45][0-9], 2[45][0-9], 2[45][0-9]\)/.test(bg) || bg === "rgb(255, 255, 255)", bg);
check("主按钮是橙色系", /rgb\(2[0-9]{2}, (8|9)[0-9], (5|6)[0-9]\)/.test(brand), brand);
check("标题足够大（>=40px）", parseFloat(h1size) >= 40, h1size);

console.log("\n[2] 只有两个功能入口");
const cards = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.card')].map(a => ({t:a.querySelector('h3').textContent.trim(), h:a.getAttribute('href')})))`));
console.log("   ", JSON.stringify(cards));
check("正好两张卡", cards.length === 2, cards.length + " 张");
check("一张指向海报生成 /", cards.some((c) => c.h === "/"));
check("一张指向旅游规划 /wenlv/", cards.some((c) => c.h === "/wenlv/"));

console.log("\n[3] AI 助手：胶囊 → 白色面板");
check("胶囊可见", await ev("document.querySelector('#aiPill').getClientRects().length > 0"));
// 面板用的是 opacity:0 + pointer-events:none 隐藏（不是 display:none），
// 所以 getClientRects() 照样返回矩形 —— 那种量法在这里是错的。
// 判断"用户看不见"要看 opacity 和能不能点。
const initHidden = await ev(`(() => {
  const cs = getComputedStyle(document.querySelector('#aiPanel'));
  return cs.opacity === '0' && cs.pointerEvents === 'none';
})()`);
check("面板初始不可见（opacity 0 且不可点）", initHidden);
await ev("document.querySelector('#aiPill').click()");
await sleep(600);
check("点后胶囊隐藏", await ev("document.querySelector('#aiPill').classList.contains('hide')"));
const pr = JSON.parse(await ev("JSON.stringify(document.querySelector('#aiPanel').getBoundingClientRect())"));
check("面板拉出来了", pr.width > 300 && pr.height > 300, `${Math.round(pr.width)}×${Math.round(pr.height)}`);
const pbg = await ev("getComputedStyle(document.querySelector('#aiPanel')).backgroundColor");
check("面板是白色", pbg === "rgb(255, 255, 255)", pbg);
check("有示例问题", (await ev("document.querySelectorAll('.ai-ex').length")) >= 3,
  (await ev("document.querySelectorAll('.ai-ex').length")) + " 条");
check("有免责声明", (await ev("document.querySelector('.ai-note').textContent")).includes("可能不完全准确"));
check("有输入框和发送键", await ev("!!document.querySelector('#aiInput') && !!document.querySelector('#aiSend')"));
check("状态显示已连上", (await ev("document.querySelector('#aiStatus').textContent")).includes("就绪"),
  await ev("document.querySelector('#aiStatus').textContent"));

console.log("\n[4] 两个目标页真的能打开");
for (const c of cards) {
  const r = await fetch(BASE + c.h, { redirect: "manual" });
  const html = await r.text();
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "(无标题)";
  check(`${c.t} ${c.h}`, r.status === 200, `${r.status}  ${title}`);
}
// 旅游规划那条要确认 React 真的挂上了
await send("Page.navigate", { url: BASE + "/wenlv/" });
await sleep(6000);
const rootKids = await ev("(document.querySelector('#root')||{}).childElementCount || 0");
console.log("   /wenlv/ 的 #root 子元素数:", rootKids);
check("旅游规划页面真的渲染出来了", rootKids > 0, rootKids + " 个子元素");

console.log("\n[5] 无失败请求 / 无 JS 异常");
console.log("   失败请求:", bad.length ? bad.slice(0, 4).join(" | ") : "无");
check("没有失败请求", bad.length === 0);
check("没有未捕获异常", errors.length === 0, errors.slice(0, 2).join(" | "));

await send("Page.navigate", { url: BASE + "/hub.html" });
await sleep(4200);
await ev("document.querySelector('#aiPill').click()");
await sleep(800);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(path.join(__dirname, ".work", "portal.png"), Buffer.from(shot.data, "base64"));
await ev("document.querySelector('#aiClose').click()");
await sleep(500);
const shot2 = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(path.join(__dirname, ".work", "portal-clean.png"), Buffer.from(shot2.data, "base64"));
console.log("\n截图 → .work/portal.png（含助手） / .work/portal-clean.png（干净）");

ws.close?.(); proc.kill();
console.log(`\n${fail === 0 ? "全部通过" : fail + " 项未通过"}`);
process.exit(fail === 0 ? 0 : 1);
