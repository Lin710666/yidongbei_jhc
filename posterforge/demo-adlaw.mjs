#!/usr/bin/env node
/**
 * demo-adlaw.mjs —— 开一个**看得见**的浏览器窗口，把用户卡住的那条路当场演一遍。
 *
 * 为什么不用 headless：用户要"看效果"，无头截图只能给他一张静止图，
 * 他没法接着自己点。这里开的是真的可见窗口，演完**不关**，交给他继续操作。
 *
 * 演示脚本（就是用户报错的那条路）：
 *   1. 打开站点
 *   2. 切到「打卡模板」
 *   3. 点「游客打卡」通用模板（改前这里会注定失败）
 *   4. 上传一张照片
 *   5. 点生成，等出图
 */

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, ".work");
const PROFILE = path.join(OUT, "demo-profile");
const PORT = Number(process.env.CDP_PORT || 9240);
const BASE = process.argv[2] || "http://127.0.0.1:8800";

const EDGE = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => existsSync(p));
if (!EDGE) throw new Error("找不到 Edge");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mkdir(OUT, { recursive: true });

  // 复用已经在跑的可见实例（用户可能自己开过），没有再起一个
  let ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
  let proc = null;
  if (!ver) {
    console.log("启动可见浏览器窗口 ...");
    proc = spawn(EDGE, [
      "--no-first-run", "--no-default-browser-check",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--window-size=1360,1000", "--window-position=80,40",
      "--new-window", BASE,
    ], { windowsHide: false, stdio: "ignore", detached: true });
    for (let i = 0; i < 60 && !ver; i++) {
      await sleep(400);
      ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
    }
  }
  if (!ver) throw new Error("浏览器没起来");
  console.log("浏览器:", ver.Browser);

  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);
    target = list.find((t) => t.type === "page" && /127\.0\.0\.1:8800/.test(t.url || "")) ||
             list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!target) await sleep(300);
  }
  if (!target) throw new Error("找不到页面");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let id = 0;
  const pend = new Map();
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
      setTimeout(() => { if (pend.has(i)) { pend.delete(i); reject(new Error("超时 " + method)); } }, 600000);
    });
  };
  const ev = async (expr, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: BASE });
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const ok = await ev("(document.querySelectorAll('#tplGrid .card').length > 0) && (typeof window.posterforge !== 'undefined')").catch(() => false);
    if (ok) break;
  }
  await sleep(1200);
  console.log("页面就绪\n");

  console.log("① 切到「打卡模板」");
  await ev(`(() => {
    const b = Array.from(document.querySelectorAll('#capMenu button')).find(x => /打卡/.test(x.textContent));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(800);

  console.log("② 点「游客打卡」通用模板（改之前这一步注定失败）");
  await ev("document.querySelector('#promptClear').click()");
  await ev(`document.querySelector('.mini-chip[data-tpl="checkin"]').click()`);
  await sleep(500);
  const txt = await ev("document.querySelector('#promptInput').value");
  console.log("   填入:", txt.split("\n").join(" / "));
  const law = JSON.parse(await ev(`JSON.stringify(window.posterforge.__debug.checkAdLaw(${JSON.stringify(txt)}))`));
  console.log("   广告法预检:", law.clean ? "干净 ✓" : `命中 ${law.hard.concat(law.proof).join(",")}`);
  const noteHidden = await ev("document.getElementById('adLawNote').hidden");
  console.log("   警告条:", noteHidden ? "未出现 ✓" : "出现了（说明还有词）");

  console.log("③ 上传一张照片");
  const photo = path.join(OUT, "poster-bg-test.jpg");
  if (existsSync(photo)) {
    const b64 = (await readFile(photo)).toString("base64");
    await ev(`(async () => {
      const bin = atob(${JSON.stringify(b64)});
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([arr], '打卡照片.jpg', { type: 'image/jpeg' }));
      const input = document.querySelector('#fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, true);
    for (let i = 0; i < 100; i++) {
      await sleep(300);
      const n = await ev("window.posterforge.state.files.filter(f => f.uploaded && f.url).length").catch(() => 0);
      if (n > 0) break;
    }
    console.log("   已上传");
  }

  console.log("④ 点生成（渲染 10~25 秒，窗口里能看到按钮上的进度）");
  const before = await ev("document.querySelector('#resultImg').getAttribute('src') || ''");
  await ev("document.querySelector('#genBtn').click()");
  let done = null;
  for (let i = 0; i < 220; i++) {
    await sleep(700);
    const st = JSON.parse(await ev(`JSON.stringify({
      img: document.querySelector('#resultImg').getAttribute('src') || '',
      errShown: document.querySelector('#resultErr').style.display !== 'none',
      err: document.querySelector('#resultErr').textContent,
    })`).catch(() => "{}"));
    if (st.img && st.img !== before) { done = { ok: true, url: st.img }; break; }
    if (st.errShown && st.err) { done = { ok: false, err: st.err }; break; }
  }
  if (done && done.ok) {
    console.log("   ✓ 出图成功");
    console.log("     ", await ev("document.querySelector('#resultMeta').textContent"));
    // 让页面滚到结果处，用户一眼能看到
    await ev(`(() => {
      const r = document.getElementById('result');
      if (r) r.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    })()`);
  } else {
    console.log("   ✗ 失败:", (done && done.err || "超时").replace(/\s+/g, " ").slice(0, 200));
  }

  console.log("\n窗口留给你了（没关）。可以直接改字、换图、再点生成。");
  console.log("关闭窗口即可退出；调试实例端口 " + PORT);
  ws.close?.();
}
main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
