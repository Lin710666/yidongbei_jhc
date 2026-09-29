#!/usr/bin/env node
/**
 * verify-hub.mjs -- 统一门户 + 悬浮球助手的验收。
 *
 * 重点验三件容易做假的事：
 *   1. 虚拟形象开关**默认必须是关的**，而且清掉存储后再进也还是关（"首次使用不启用"）
 *   2. 抽屉是真的拉出来了（读几何，不是读 class）
 *   3. 六个入口卡的链接真的指向两个系统，且目标页真的能打开
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const PROFILE = path.join(__dirname, ".work", "hub-profile");
const PORT = 9290;
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
              "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, note = "") => { console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`); ok ? pass++ : fail++; };

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
const ev = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || "?").slice(0, 160));
  return r.result.value;
};

await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
const errors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails?.exception?.description || "?").slice(0, 120));
});
await send("Page.navigate", { url: BASE + "/hub.html" });
await sleep(4500);

console.log("[1] 门户内容");
check("标题正确", (await ev("document.title")).includes("浙里文旅工坊"), await ev("document.title"));
const cards = await ev(`JSON.stringify([...document.querySelectorAll('.entry')].map(a => ({t:a.querySelector('h3').textContent, h:a.getAttribute('href')})))`);
const list = JSON.parse(cards);
console.log("   入口:", list.map((c) => c.t + "→" + c.h).join("  "));
check("入口卡 >= 6", list.length >= 6, `${list.length} 个`);
check("有指向海报工坊(/)", list.some((c) => c.h === "/"));
check("有指向智慧旅游(/wenlv/)", list.some((c) => c.h === "/wenlv/"));
check("有指向形象设置(/wenlv/app/)", list.some((c) => c.h === "/wenlv/app/"));

console.log("\n[2] 虚拟形象默认必须是关的");
check("开关未勾选", (await ev("document.querySelector('#swAvatar').checked")) === false);
check("localStorage 里没有开过的记录", (await ev("localStorage.getItem('hub/avatar-on')")) === null);
check("模型选择区默认不显示", (await ev("document.querySelector('#avatarOpts').hidden")) === true);
check("抽屉里没有 Live2D 舞台", (await ev("!document.querySelector('#stage')")) === true);
check("有说明文字讲清默认关闭", (await ev("document.querySelector('#avatarNote').textContent")).includes("不启用"));

console.log("\n[3] 悬浮球与抽屉（读几何，不读 class）");
const ballBox = await ev(`JSON.stringify(document.querySelector('#ball').getBoundingClientRect())`);
const bb = JSON.parse(ballBox);
check("悬浮球可见且固定在右下", bb.width > 40 && bb.right > 1400 && bb.bottom > 800, `w=${Math.round(bb.width)} right=${Math.round(bb.right)} bottom=${Math.round(bb.bottom)}`);
check("抽屉初始在屏幕外", (await ev("document.querySelector('#drawer').getBoundingClientRect().left")) >= 1590,
  "left=" + Math.round(await ev("document.querySelector('#drawer').getBoundingClientRect().left")));

await ev("document.querySelector('#ball').click()");
await sleep(700);
const dl = await ev("document.querySelector('#drawer').getBoundingClientRect().left");
check("点球后抽屉拉进来了", dl < 1400, "left=" + Math.round(dl));
check("遮罩出现了", (await ev("getComputedStyle(document.querySelector('#backdrop')).opacity")) === "1");
check("抽屉可见宽度合理", (await ev("document.querySelector('#drawer').getBoundingClientRect().width")) > 350);

console.log("\n[4] 设置页：打开虚拟形象");
await ev(`document.querySelector('.tab[data-tab="settings"]').click()`);
await sleep(500);
check("设置面板已显示", await ev("document.querySelector('#panelSettings').classList.contains('active')"));
check("模型列表有 5 个", (await ev("document.querySelectorAll('#modelList .model-item').length")) === 5,
  String(await ev("document.querySelectorAll('#modelList .model-item').length")));
await ev("document.querySelector('#swAvatar').click()");
await sleep(300);
check("开关变成开", (await ev("document.querySelector('#swAvatar').checked")) === true);
check("写进了 localStorage", (await ev("localStorage.getItem('hub/avatar-on')")) === "1");
check("模型选择区显示了", (await ev("document.querySelector('#avatarOpts').hidden")) === false);
await sleep(6000);
const stageInfo = await ev(`(() => { const s = document.querySelector('#stage'); if(!s) return 'NO_STAGE';
  return JSON.stringify({ canvas: s.querySelectorAll('canvas').length, hint: (s.querySelector('.stage-hint')||{}).textContent || null }); })()`);
console.log("   舞台:", stageInfo);
check("舞台上出现了 canvas（Live2D 渲染器）", String(stageInfo).includes('"canvas":1'), String(stageInfo).slice(0, 90));

console.log("\n[5] 关掉后不该留东西");
await ev("document.querySelector('#swAvatar').click()");
await sleep(400);
check("开关变回关", (await ev("document.querySelector('#swAvatar').checked")) === false);
check("舞台被移除了", (await ev("!document.querySelector('#stage')")) === true);

console.log("\n[6] 对话面板");
await ev(`document.querySelector('.tab[data-tab="chat"]').click()`);
await sleep(300);
const nd = await ev("document.querySelectorAll('#msgs .msg').length");
console.log("   已有消息数（含角色卡问候）:", nd);
check("输入框在", (await ev("!!document.querySelector('#input')")) === true);
check("快捷键按钮在", (await ev("document.querySelectorAll('#quick button').length")) >= 3);

console.log("\n[7] 入口目标页真的能打开（逐个 HTTP）");
for (const c of list) {
  const r = await fetch(BASE + c.h, { redirect: "manual" });
  check(`${c.t} ${c.h} → ${r.status}`, r.status === 200);
}

console.log("\n[8] 无未捕获异常");
check("没有 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));

const shot = await send("Page.captureScreenshot", { format: "png" });
await writeFile(path.join(__dirname, ".work", "hub-open.png"), Buffer.from(shot.data, "base64"));
console.log("\n截图 → .work/hub-open.png");
ws.close?.(); proc.kill();
console.log(`\n${fail === 0 ? "全部通过" : fail + " 项未通过"}`);
process.exit(fail === 0 ? 0 : 1);
