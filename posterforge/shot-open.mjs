#!/usr/bin/env node
/** shot-open.mjs —— 打开站点并截一张"用户此刻看到的样子"，顺便读回提示语。 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "shot-profile");
const PORT = 9231;
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
    "--hide-scrollbars", "--window-size=1440,1100", "about:blank",
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
  let id = 0;
  const pend = new Map();
  const events = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { resolve, reject } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) events.push(m);
  });
  const send = (method, params = {}) => {
    const i = ++id;
    return new Promise((resolve, reject) => {
      pend.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error("超时 " + method)); } }, 60000);
    });
  };
  const ev = async (expr, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false,
  });
  await send("Page.navigate", { url: BASE });

  for (let i = 0; i < 50; i++) {
    await sleep(300);
    const ok = await ev(
      "(document.querySelectorAll('#tplGrid .card').length > 0) && (typeof window.posterforge !== 'undefined')"
    ).catch(() => false);
    if (ok) break;
  }
  await sleep(1500);   // 等模型状态探完，提示语才会显示"谁写文案"

  const info = JSON.parse(await ev(`JSON.stringify({
    hint: (document.getElementById('promptHint')||{}).textContent || '',
    brainReady: window.posterforge ? window.posterforge.state.brainReady : null,
    tplCards: document.querySelectorAll('#tplGrid .card').length,
    feedCards: document.querySelectorAll('#feedGrid .feed-card').length,
    noteHidden: (document.getElementById('composeNote')||{}).hidden,
  })`));
  console.log("页面提示语:", info.hint);
  console.log("模型就绪:", info.brainReady, "| 模板卡:", info.tplCards, "| 灵感卡:", info.feedCards);
  console.log("模型面板初始隐藏:", info.noteHidden);

  const errs = events
    .filter((e) => e.method === "Runtime.exceptionThrown")
    .map((e) => e.params.exceptionDetails.exception?.description || "")
    .filter(Boolean);
  console.log("JS 异常:", errs.length ? errs.slice(0, 2).join(" | ").slice(0, 200) : "无");

  const shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(OUT, "opened.png"), Buffer.from(shot.data, "base64"));
  console.log("截图 → .work/opened.png");

  ws.close?.();
  proc.kill();
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
