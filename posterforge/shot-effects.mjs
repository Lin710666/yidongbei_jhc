#!/usr/bin/env node
/**
 * shot-effects.mjs —— 把两种功能各出一张真图，并排看效果对不对。
 * 光看断言不够：价格块没了以后版面会不会空一块、照片带位置对不对，得看图。
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "effects-profile");
const PORT = 9252;
const BASE = process.argv[2] || "http://127.0.0.1:8800";
const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true });
  await rm(PROFILE, { recursive: true, force: true });
  const proc = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    "--hide-scrollbars", "--window-size=1440,1200", "about:blank",
  ], { windowsHide: true, stdio: "ignore" });

  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(400); try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {} }
  let target = null;
  for (let i = 0; i < 25 && !target; i++) {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json().catch(() => []);
    target = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!target) await sleep(300);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  });
  const send = (method, params = {}) => {
    const i = ++id;
    return new Promise((resolve, reject) => {
      pend.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error("timeout " + method)); } }, 600000);
    });
  };
  const ev = async (expr, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send("Page.enable"); await send("Runtime.enable");
  await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Page.navigate", { url: BASE });
  for (let i = 0; i < 60; i++) { await sleep(300); if ((await ev("typeof window.posterforge")) === "object") break; }
  await sleep(900);

  const photos = [
    path.join(OUT, "poster-bg-test.jpg"),
    path.join(__dirname, "public", "bg", "seaside-sunset.jpg"),
  ].filter((p) => existsSync(p));

  async function addPhoto(p, expect) {
    const b64 = (await readFile(p)).toString("base64");
    await ev(`(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], '照片.jpg', { type: 'image/jpeg' }));
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, true);
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      if ((await ev("window.posterforge.state.files.filter(f=>f.uploaded&&f.url).length")) >= expect) return;
    }
  }
  const setPrompt = (t) => ev(`(() => { const el=document.querySelector('#promptInput'); el.value=${JSON.stringify(t)}; el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
  async function render(spec) {
    const specJson = JSON.stringify(spec);
    const r = await ev(`(async () => {
      const spec = ${specJson};
      const r = await fetch('/api/generate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ spec }) });
      const j = await r.json();
      return JSON.stringify({ ok:r.ok, url:j.url||null, err:j.error||j.message||null });
    })()`, true);
    return JSON.parse(r);
  }
  async function grab(url, name) {
    const b64 = await ev(`(async () => {
      const i = new Image(); i.crossOrigin='anonymous'; i.src = ${JSON.stringify(url)} + '?t=' + Date.now();
      await i.decode();
      const c = document.createElement('canvas'); c.width=i.naturalWidth; c.height=i.naturalHeight;
      c.getContext('2d').drawImage(i,0,0);
      return c.toDataURL('image/png').split(',')[1];
    })()`, true);
    await writeFile(path.join(OUT, name), Buffer.from(b64, "base64"));
    console.log("  已存 .work/" + name);
  }

  // ---- 场景 A：打卡卡，2 张图，用户没给任何价格 ----
  console.log("\n[A] 打卡卡 · 2 张图 · 没有价格");
  await ev("window.posterforge.__setBrainReady(false)");
  await ev("window.posterforge.__setCap('checkin')");
  await ev(`(async () => {
    for (let r=0;r<12;r++){ const c=Array.from(document.querySelectorAll('#fileList .chip')).filter(x=>x.textContent.includes('🖼')); if(!c.length)break; c[c.length-1].click(); await new Promise(z=>setTimeout(z,250)); }
    return true;
  })()`, true);
  await addPhoto(photos[0], 1);
  await addPhoto(photos[1], 2);
  await setPrompt("今天去了西湖和汉服馆，随手拍了几张");
  let spec = JSON.parse(await ev("JSON.stringify(window.posterforge.__debug.buildCheckinSpec())"));
  let r = await render(spec);
  console.log("  生成:", r.ok ? r.url : r.err);
  if (r.ok) await grab(r.url, "fx-checkin.png");

  // ---- 场景 B：海报，2 张图，用户没给价格 ----
  console.log("\n[B] 海报 · 2 张图 · 没有价格（不该出现价格块）");
  await ev("window.posterforge.__setCap('poster')");
  await setPrompt("今天去了西湖和汉服馆，随手拍了几张");
  spec = JSON.parse(await ev("JSON.stringify(window.posterforge.__debug.buildPosterSpec())"));
  console.log("  文本层:", spec.layers.filter((l) => l.type === "text").map((l) => l.name).join(", "));
  r = await render(spec);
  console.log("  生成:", r.ok ? r.url : r.err);
  if (r.ok) await grab(r.url, "fx-poster-noprice.png");

  // ---- 场景 C：海报，用户明确给了价格 ----
  console.log("\n[C] 海报 · 给了「价格 ￥599」");
  await setPrompt("西湖边的餐厅，双人套餐 4 菜 1 汤，价格 ￥599，电话 13900001111");
  spec = JSON.parse(await ev("JSON.stringify(window.posterforge.__debug.buildPosterSpec())"));
  console.log("  文本层:", spec.layers.filter((l) => l.type === "text").map((l) => l.name + "=" + l.text.replace(/\n/g, "/")).join(" | "));
  r = await render(spec);
  console.log("  生成:", r.ok ? r.url : r.err);
  if (r.ok) await grab(r.url, "fx-poster-price.png");

  ws.close(); proc.kill();
}
main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
