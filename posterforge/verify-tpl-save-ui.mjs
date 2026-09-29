#!/usr/bin/env node
/** verify-tpl-save-ui.mjs -- 在真浏览器里点一遍「存为我的模板」→ 出现 → 删除 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const PROFILE = path.join(__dirname, ".work", "tplsave-profile");
const PORT = 9282;
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
              "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, note = "") => { console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`); ok ? pass++ : fail++; };

await rm(PROFILE, { recursive: true, force: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, "--window-size=1440,1300", "about:blank"], { windowsHide: true, stdio: "ignore" });
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
  if (r.exceptionDetails) throw new Error("page error: " + (r.exceptionDetails.exception?.description || "?"));
  return r.result.value;
};

await send("Page.enable"); await send("Runtime.enable");
await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1300, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: BASE });
await sleep(4000);

const clickCap = (n) => ev(`(() => { const b = Array.from(document.querySelectorAll('#capMenu button')).find(x => x.textContent.includes(${JSON.stringify(n)})); if (b) b.click(); return !!b; })()`);

console.log("[1] 先在海报模式写点内容");
await clickCap("海报");
await sleep(500);
const MINE = "我的私房菜馆周年庆，老客凭记录领伴手礼\n我的店名（改成你的店名）· 咨询 ○○○-○○○○-○○○○";
await ev(`(() => {
  const el = document.querySelector('#promptInput');
  el.value = ${JSON.stringify(MINE)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value.length;
})()`);
check("输入框有内容", (await ev("document.querySelector('#promptInput').value.length")) > 10);

console.log("\n[2] 切到套用模板，点「存为我的模板」");
await clickCap("模板");
await sleep(900);
console.log("   切换后输入框长度:", await ev("(document.querySelector('#promptInput')||{}).value?.length"));
console.log("   输入框是否还在 DOM:", await ev("!!document.querySelector('#promptInput')"));
console.log("   输入框可见性:", await ev("(() => { const el = document.querySelector('#promptInput'); return el ? el.getClientRects().length > 0 : 'MISSING'; })()"));
await ev(`document.querySelector('#tplSaveBtn').click()`);
await sleep(400);
console.log("   点保存前输入框长度:", await ev("(document.querySelector('#promptInput')||{}).value?.length"));
console.log("   debug.currentPrompt():", JSON.stringify(String(await ev("(window.posterforge.__debug.currentPrompt && window.posterforge.__debug.currentPrompt()) || ''")).slice(0, 40)));
check("出现命名输入行", await ev("!document.querySelector('#tplSave').hidden"));
check("名称已预填（取第一行）", (await ev("document.querySelector('#tplSaveName').value")).length > 0,
  await ev("document.querySelector('#tplSaveName').value"));

console.log("\n[3] 保存");
const before = await ev("document.querySelectorAll('#tplList .tpl-item').length");
await ev(`(() => {
  const n = document.querySelector('#tplSaveName');
  n.value = '我的私房菜周年庆';
  document.querySelector('#tplSaveOk').click();
  return true;
})()`);
await sleep(2000);
const after = await ev("document.querySelectorAll('#tplList .tpl-item').length");
const msg = await ev("(document.querySelector('#tplSaveMsg')||{}).textContent || ''");
console.log("   提示:", msg.slice(0, 80));
check("列表多了一套", after === before + 1, `${before} → ${after}`);
check("给了成功提示", /已存为/.test(msg));
check("标记为「我的」", await ev(`!!document.querySelector('.tpl-item.is-mine .mine-tag')`));
check("有删除按钮", await ev(`!!document.querySelector('.tpl-item.is-mine .tpl-del')`));

console.log("\n[4] 套用它 → 内容进输入框");
await ev(`document.querySelector('.tpl-item.is-mine').click()`);
await sleep(1200);
const applied = await ev("document.querySelector('#promptInput').value");
check("内容是刚存的那套", applied.includes("私房菜馆周年庆"), applied.slice(0, 30));
check("已切回海报模式", (await ev("window.posterforge.state.cap")) === "poster");

console.log("\n[5] 删除它");
await clickCap("模板");
await sleep(900);
await ev(`document.querySelector('.tpl-item.is-mine .tpl-del').click()`);
await sleep(1600);
const finalCount = await ev("document.querySelectorAll('#tplList .tpl-item').length");
check("删除后少了一套", finalCount === before, `${after} → ${finalCount}`);
check("界面上没有「我的」标记了", !(await ev(`!!document.querySelector('.tpl-item.is-mine')`)));

console.log(`\n${fail === 0 ? "全部通过" : fail + " 项未通过"}`);
ws.close?.(); proc.kill();
process.exit(fail === 0 ? 0 : 1);
