#!/usr/bin/env node
/**
 * shot-adlaw.mjs —— 把广告法预检这块的**三个状态**分别截图存下来给人看。
 * 光看断言日志不够，得看渲染出来的样子：警告条会不会挤坏版式、按钮位置对不对。
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "adlaw-shot-profile");
const PORT = 9235;
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
    "--hide-scrollbars", "--window-size=1000,1000", "about:blank",
  ], { windowsHide: true, stdio: "ignore" });

  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    await sleep(400);
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch {}
  }
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
  let id = 0; const pend = new Map();
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const { resolve, reject } = pend.get(m.id);
      pend.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: BASE });
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const ok = await ev("(document.querySelectorAll('#tplGrid .card').length > 0)").catch(() => false);
    if (ok) break;
  }
  await sleep(1000);

  const setPrompt = (t) => ev(`(() => {
    const el = document.querySelector('#promptInput');
    el.value = ${JSON.stringify(t)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  const shoot = async (name, scrollTo) => {
    if (scrollTo) {
      await ev(`(() => {
        const e = document.querySelector(${JSON.stringify(scrollTo)});
        if (e) window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 120);
      })()`);
    }
    await sleep(500);
    const s = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(OUT, `adlaw-${name}.png`), Buffer.from(s.data, "base64"));
    const state = JSON.parse(await ev(`JSON.stringify({
      hidden: document.getElementById('adLawNote').hidden,
      cls: document.getElementById('adLawNote').className,
      text: document.getElementById('adLawNote').innerText.replace(/\\s+/g,' ').slice(0,90),
      prompt: document.getElementById('promptInput').value.replace(/\\n/g,' / ').slice(0,70),
      h: document.getElementById('capCard') ? document.getElementById('capCard').getBoundingClientRect().height : 0,
    })`));
    console.log(`[${name}] hidden=${state.hidden} cls=${state.cls}`);
    console.log(`  输入框: ${state.prompt}`);
    console.log(`  警告条: ${state.text || "(无)"}`);
  };

  // 1) 干净输入
  await setPrompt("今日实拍，随手一拍就是大片\n观景台机位出片，建议日落前一小时到");
  await shoot("clean", "#promptInput");

  // 2) 含禁词
  await setPrompt("今日实拍，随手一拍就是大片\n最佳机位在观景台，建议日落前一小时到");
  await shoot("banned", "#promptInput");

  // 3) 一键改写之后
  await ev("document.querySelector('#adLawFix').click()");
  await sleep(1500);
  await shoot("fixed", "#promptInput");

  // 4) 只需资质提醒（不是硬禁）
  await setPrompt("老字号手作点心，独家配方，每日现做");
  await shoot("proof", "#promptInput");

  console.log("\n截图 → .work/adlaw-{clean,banned,fixed,proof}.png");
  ws.close?.();
  proc.kill();
}
main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
