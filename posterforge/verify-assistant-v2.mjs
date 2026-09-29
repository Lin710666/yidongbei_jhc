#!/usr/bin/env node
/** 实测 AI 助手：拉出面板 → 齿轮 → 设置 → 对话 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = path.join(__dirname, "ast-profile");
const PORT = 9316;
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
              "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, note = "") => { console.log(`  ${ok ? "[OK]" : "[X] "} ${n}${note ? "  " + note : ""}`); ok ? pass++ : fail++; };

rmSync(PROFILE, { recursive: true, force: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-proxy-server",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1500,980", "about:blank"], { windowsHide: true, stdio: "ignore" });
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
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.value;

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 980, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:8800/" });
await sleep(4500);

// 助手的 DOM 在 Shadow DOM 里，普通 querySelector 进不去 ——
// 第一版没穿进去，把"球在不在""面板可见吗"误判成失败。
await ev(`window.__walk = function(pred){ const w=(n)=>{ if(!n) return null;
  try { if(n.nodeType===1 && pred(n)) return n; } catch(e){}
  if(n.shadowRoot){ const r=w(n.shadowRoot); if(r) return r; }
  for(const c of (n.children||[])){ const r=w(c); if(r) return r; } return null; };
  return w(document.body); };`);

console.log("[1] 悬浮球");
check("球在页面上", await ev("!!window.__walk(n=>/ball/i.test(n.className||''))"));
check("球上有文字（能看出是 AI 助手）",
  await ev("(()=>{const b=window.__walk(n=>/\\bbt\\b/.test(n.className||''));return b?b.textContent.trim().length>0:false})()"));

console.log("\n[2] 拉出面板");
await ev("(()=>{const b=window.__walk(n=>/ball/i.test(n.className||''));if(b)b.click();return 1})()");
await sleep(1400);
check("助手实例已挂载", await ev("!!window.__pfAiBall"));
check("面板可见", await ev("(()=>{const p=window.__walk(n=>/panel/i.test(n.className||''));return p?getComputedStyle(p).display!=='none':false})()"));

console.log("\n[3] 设置只在拉出后可见");
const gearInfo = await ev(`(()=>{
  const root = document.querySelector('div');
  const walk = (n) => { if(!n) return null; if(n.id==='gear') return n;
    if(n.shadowRoot){ const r=walk(n.shadowRoot); if(r) return r; }
    for(const c of (n.children||[])){ const r=walk(c); if(r) return r; } return null; };
  const g = walk(document.body);
  if(!g) return {found:false};
  const st = (()=>{ const w=(n)=>{ if(!n) return null; if(n.id==='settings') return n;
    if(n.shadowRoot){const r=w(n.shadowRoot); if(r) return r;}
    for(const c of (n.children||[])){const r=w(c); if(r) return r;} return null; };
    return w(document.body); })();
  return {found:true, settingsHidden: st ? st.hidden : null};
})()`);
check("面板里有齿轮按钮", gearInfo.found);
check("设置初始是收起的", gearInfo.settingsHidden === true, String(gearInfo.settingsHidden));

await ev(`(()=>{ const w=(n)=>{ if(!n) return null; if(n.id==='gear') return n;
  if(n.shadowRoot){const r=w(n.shadowRoot); if(r) return r;}
  for(const c of (n.children||[])){const r=w(c); if(r) return r;} return null; }; const g=w(document.body); if(g) g.click(); return 1; })()`);
await sleep(900);
const st = await ev(`(()=>{ const w=(n)=>{ if(!n) return null; if(n.id==='settings') return n;
  if(n.shadowRoot){const r=w(n.shadowRoot); if(r) return r;}
  for(const c of (n.children||[])){const r=w(c); if(r) return r;} return null; };
  const s=w(document.body); if(!s) return {open:false};
  const av=w(s)||null;
  const box=(n,id)=>{ const q=(x)=>{ if(!x) return null; if(x.id===id) return x;
    if(x.shadowRoot){const r=q(x.shadowRoot); if(r) return r;}
    for(const c of (x.children||[])){const r=q(c); if(r) return r;} return null; }; return q(n); };
  const cb=box(s,'stAvatar');
  return {open:!s.hidden, hasAvatarToggle:!!cb, avatarChecked: cb?cb.checked:null,
          text:s.textContent.slice(0,60)}; })()`);
check("齿轮点开后设置面板出现", st.open);
check("设置里有「虚拟形象」开关", st.hasAvatarToggle);
check("虚拟形象默认关闭", st.avatarChecked === false, String(st.avatarChecked));
console.log("     设置内容:", JSON.stringify(st.text));

console.log("\n[4] 对话是真的（说你好）");
await ev(`(()=>{ const w=(n)=>{ if(!n) return null; if(n.id==='ta') return n;
  if(n.shadowRoot){const r=w(n.shadowRoot); if(r) return r;}
  for(const c of (n.children||[])){const r=w(c); if(r) return r;} return null; };
  const ta=w(document.body); if(!ta) return 0;
  const setter=Object.getOwnPropertyDescriptor(ta.constructor.prototype,'value').set;
  setter.call(ta,'你好，你是谁？');
  ta.dispatchEvent(new Event('input',{bubbles:true}));
  const s=(()=>{ const q=(n)=>{ if(!n) return null; if(n.id==='send') return n;
    if(n.shadowRoot){const r=q(n.shadowRoot); if(r) return r;}
    for(const c of (n.children||[])){const r=q(c); if(r) return r;} return null; }; return q(document.body); })();
  if(s) s.click(); return 1; })()`);
await sleep(9000);
const reply = await ev(`(()=>{ const w=(n)=>{ if(!n) return null; if(n.id==='msgs') return n;
  if(n.shadowRoot){const r=w(n.shadowRoot); if(r) return r;}
  for(const c of (n.children||[])){const r=w(c); if(r) return r;} return null; };
  const m=w(document.body); return m?m.textContent.slice(-260):''; })()`);
console.log("     回复尾部:", JSON.stringify(reply.slice(-160)));
check("有回复内容", reply.length > 10);
// 注意断言的写法：助手**提到**"说清目的地、天数"是在介绍能力，这是对的；
// 要抓的是"只会在那儿要参数"那种回复 —— 短、且以索要开头。
// 第一版断言直接匹配关键词，把正常的自我介绍判成了失败。
const onlyAsking = /^(还缺少|请补充|需要提供)/.test(reply.trim()) ||
  (reply.length < 90 && /目的地.*天数.*(人数|预算)/.test(reply));
check("不是只会索要规划参数", !onlyAsking, onlyAsking ? reply.slice(0, 60) : "（正常对话）");

ws.close?.(); proc.kill();
rmSync(PROFILE, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "全部通过" : fail + " 项未通过"}`);
process.exit(fail === 0 ? 0 : 1);
